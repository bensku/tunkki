import type { Host } from '@bensku/tunkki';
import type { Event, TaskRecord } from '../common/event';
import { log } from '../common/log';
import type { Connection } from './connection';
import { findRefs, substituteState } from './outputs';
import { type Plan, toJson } from './plan';
import { Scheduler } from './scheduler';
import { bundleHandler, loadSteps } from './task';

/**
 * Max number of steps a remote runs at once.
 */
const CONCURRENCY = 4;

export interface TaskEvent {
    host: Host;
    type: 'started' | 'completed';
    taskId: string;
    status: 'started' | 'done' | 'unchanged' | 'error' | 'skipped';
    error?: string;
}

export interface Result {
    /**
     * Id of host that was deployed to.
     */
    host: string;
    completed: string[];
    unchanged: string[];
    skipped: string[];
    errored: {
        taskId: string;
        error: string;
    }[];

    /**
     * Error that was not caused by a task, e.g. failure to write state.
     */
    error?: string;
}

/**
 * Applies a plan.
 * @param plan Plan to apply.
 * @param conns Connections to all hosts in the plan.
 * @param callback Receives progress events.
 */
export async function applyPlan(
    plan: Plan,
    conns: Connection[],
    callback?: (event: TaskEvent) => void,
): Promise<Result[]> {
    const sessionId = crypto.randomUUID();
    const sessions = new Map(
        conns.map((conn) => [conn.host.id, new RemoteSession(conn, sessionId)]),
    );
    const sessionOf = (id: string) =>
        sessions.get(taskOf(plan, id).host) as RemoteSession;

    await openSessions(plan, sessions);

    const results = new Map<string, Result>(
        conns.map((conn) => [
            conn.host.id,
            {
                host: conn.host.id,
                completed: [],
                unchanged: [],
                skipped: [],
                errored: [],
            },
        ]),
    );
    const resultOf = (id: string) =>
        results.get(taskOf(plan, id).host) as Result;
    const emit = (id: string, event: Omit<TaskEvent, 'host' | 'taskId'>) => {
        callback?.({
            host: sessionOf(id).host,
            taskId: id,
            ...event,
        });
    };

    const started = new Set<string>();
    const markStarted = (id: string) => {
        if (!started.has(id)) {
            started.add(id);
            emit(id, { type: 'started', status: 'started' });
        }
    };
    for (const session of sessions.values()) {
        session.onStarted = markStarted;
    }

    const applier = new TaskApplier(plan, sessionOf, markStarted);
    const run = async (id: string, depApplied: boolean) => {
        let result: 'done' | 'unchanged' | 'error';
        let error: string | undefined;
        try {
            result = await applier.apply(id, depApplied);
        } catch (e) {
            result = 'error';
            error = e instanceof RemoteError ? e.message : Bun.inspect(e);
            log.error('task failed', 'task', id, 'error', error);
        }

        const hostResult = resultOf(id);
        if (result === 'done') {
            hostResult.completed.push(id);
        } else if (result === 'unchanged') {
            hostResult.unchanged.push(id);
        } else {
            hostResult.errored.push({ taskId: id, error: error ?? '' });
        }
        emit(id, { type: 'completed', status: result, error });
        scheduler.finish(id, result);
    };
    const scheduler: Scheduler = new Scheduler(plan, {
        run,
        skipped: (id) => {
            resultOf(id).skipped.push(id);
            emit(id, { type: 'completed', status: 'skipped' });
        },
    });
    await scheduler.start();

    for (const id of plan.refresh) {
        sessionOf(id).commit(id, {
            ...(plan.old[id] as TaskRecord),
            deps: taskOf(plan, id).deps,
        });
    }
    await Promise.all(
        [...sessions].map(async ([host, session]) => {
            const error = await session.close();
            if (error) {
                (results.get(host) as Result).error = error;
            }
        }),
    );
    return [...results.values()];
}

function taskOf(plan: Plan, id: string) {
    const node = plan.nodes[id];
    if (!node) {
        throw new Error(`internal error: ${id} is not in plan`);
    }
    return node.task;
}

/**
 * Opens sessions on all hosts and loads handlers they need.
 * @throws If any host fails, after closing all sessions.
 */
async function openSessions(plan: Plan, sessions: Map<string, RemoteSession>) {
    const open = async (host: string, session: RemoteSession) => {
        const stateHash = plan.hosts[host]?.stateHash;
        if (stateHash === undefined) {
            throw new Error(`host ${host} is not in the plan`);
        }
        await session.open(plan.stack, stateHash);
        await session.loadHandlers(await bundleHandlers(plan, host));
    };
    const opened = await Promise.allSettled(
        [...sessions].map(([host, session]) => open(host, session)),
    );
    const errors = opened.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length > 0) {
        await Promise.allSettled(
            [...sessions.values()].map((session) => session.close()),
        );
        throw new AggregateError(errors, 'failed to start applying');
    }
}

/**
 * Bundles handlers that a host needs to apply a plan.
 */
async function bundleHandlers(
    plan: Plan,
    host: string,
): Promise<Record<string, string>> {
    const types = new Set<string>();
    const skip = new Set(plan.unchanged);
    for (const [id, node] of Object.entries(plan.nodes)) {
        if (node.task.host === host && !skip.has(id)) {
            types.add(node.task.type);
            const old = plan.old[id];
            if (old) {
                types.add(old.handler);
            }
        }
    }
    types.delete('$noop');

    const bundles: Record<string, string> = {};
    for (const type of types) {
        bundles[type] = await bundleHandler(type);
    }
    return bundles;
}

/**
 * Applies individual tasks of a plan, once the scheduler starts them.
 */
class TaskApplier {
    #plan: Plan;
    #sessionOf: (id: string) => RemoteSession;
    #onStarted: (id: string) => void;
    #deleted: Set<string>;
    #replaced: Set<string>;

    /**
     * Tasks whose outputs other tasks use.
     */
    #referenced: Set<string>;

    /**
     * Outputs of tasks that have been applied by this run.
     */
    #outputs = new Map<string, unknown>();

    constructor(
        plan: Plan,
        sessionOf: (id: string) => RemoteSession,
        onStarted: (id: string) => void,
    ) {
        this.#plan = plan;
        this.#sessionOf = sessionOf;
        this.#onStarted = onStarted;
        this.#deleted = new Set(plan.deleted);
        this.#replaced = new Set(plan.replaced);
        this.#referenced = new Set(
            Object.values(plan.nodes).flatMap((node) =>
                findRefs(node.task.state).map((ref) => ref.id),
            ),
        );
    }

    async apply(
        id: string,
        depApplied: boolean,
    ): Promise<'done' | 'unchanged'> {
        const task = taskOf(this.#plan, id);
        const session = this.#sessionOf(id);
        const record = this.#plan.old[id];
        const replaced = this.#replaced.has(id);

        if (record && (replaced || this.#deleted.has(id))) {
            await session.run(record.handler, id, 0, undefined);
            if (!replaced) {
                return 'done';
            }
        }

        const { value: input, unresolved } = substituteState(
            task.state,
            (ref) =>
                this.#outputs.has(ref)
                    ? this.#outputs.get(ref)
                    : this.#plan.old[ref]?.output,
        );
        if (unresolved.length > 0) {
            throw new Error(`unresolved outputs: ${unresolved.join(', ')}`);
        } else if (input === undefined) {
            throw new Error('task has no input');
        }
        const stored = toJson(input);
        if (
            !replaced &&
            Bun.deepEquals(stored, record?.state) &&
            !this.#mustReapply(id, depApplied)
        ) {
            return 'unchanged';
        }

        let state: unknown = input;
        const old = replaced ? undefined : record;
        const steps = await loadSteps(task.type);
        for (const [i, step] of steps.entries()) {
            if (step.location === 'local') {
                this.#onStarted(id);
                state = await step.handler(
                    state,
                    { host: session.host },
                    i === 0 ? old?.state : undefined,
                    old?.output,
                );
            } else {
                state = await session.run(task.type, id, i, state);
            }
            if (state === undefined && i < steps.length - 1) {
                throw new Error(
                    `step ${i} returned nothing, but it is not the last step`,
                );
            }
        }

        const output = steps.length > 0 ? toJson(state) : undefined;
        session.commit(id, {
            handler: task.type,
            state: stored,
            output,
            deps: task.deps,
        });
        this.#outputs.set(id, output);
        return 'done';
    }

    /**
     * Whether a task must be applied even though its input did not change.
     */
    #mustReapply(id: string, depApplied: boolean): boolean {
        const task = taskOf(this.#plan, id);
        return (
            this.#plan.mode === 'reapply' ||
            (task.requireReapply && depApplied) ||
            // Its output is used, but an old version did not store it
            (this.#referenced.has(id) &&
                this.#plan.old[id]?.output === undefined)
        );
    }
}

/**
 * Error from a remote. Its message is already formatted.
 */
class RemoteError extends Error {}

type DoneEvent = Extract<Event, { type: 'done' }>;

/**
 * Apply session on a remote. Runs requests over one connection, matching
 * replies to them.
 */
class RemoteSession {
    #conn: Connection;
    #id: string;
    #opened = false;
    #steps = new Map<string, PromiseWithResolvers<unknown>>();
    #reply: PromiseWithResolvers<Event> | undefined;
    #listening: Promise<void>;

    /**
     * Why the connection stopped working, if it did.
     */
    #failure: unknown;

    onStarted: (id: string) => void = () => {};

    constructor(conn: Connection, id: string) {
        this.#conn = conn;
        this.#id = id;
        this.#listening = this.#listen();
    }

    get host(): Host {
        return this.#conn.host;
    }

    async open(stack: string, stateHash: string) {
        await this.#expectReady({
            type: 'openSession',
            session: this.#id,
            stack,
            concurrency: CONCURRENCY,
            stateHash,
        });
        this.#opened = true;
    }

    async loadHandlers(handlers: Record<string, string>) {
        await this.#expectReady({
            type: 'loadHandlers',
            session: this.#id,
            handlers,
        });
    }

    /**
     * Runs a remote step, or cleans up if state is undefined.
     * @returns Output of the step.
     */
    async run(task: string, id: string, step: number, state: unknown) {
        const done = Promise.withResolvers<unknown>();
        this.#steps.set(id, done);
        await this.#send({
            type: 'run',
            session: this.#id,
            task,
            id,
            step,
            state,
        });
        return done.promise;
    }

    commit(id: string, record: TaskRecord) {
        this.#send({ type: 'commit', session: this.#id, id, record }).catch(
            (e) => log.error('failed to commit', 'task', id, 'error', e),
        );
    }

    /**
     * Closes the session if it was opened.
     * @returns Error, e.g. if commits failed on the remote.
     */
    async close(): Promise<string | undefined> {
        if (!this.#opened) {
            return;
        }
        try {
            const closed = await this.#request({
                type: 'closeSession',
                session: this.#id,
            });
            await this.#listening;
            if (closed.type !== 'sessionClosed') {
                return `unexpected event ${closed.type}`;
            }
            return closed.error;
        } catch (e) {
            return Bun.inspect(e);
        }
    }

    async #expectReady(event: Event) {
        const ready = await this.#request(event);
        if (ready.type !== 'ready') {
            throw new Error(
                `unexpected event ${ready.type} from ${this.host.id}`,
            );
        } else if (ready.error) {
            throw new RemoteError(`${this.host.id}: ${ready.error}`);
        }
    }

    async #send(event: Event) {
        if (this.#failure) {
            throw this.#failure;
        }
        await this.#conn.send(event);
    }

    async #request(event: Event): Promise<Event> {
        this.#reply = Promise.withResolvers();
        await this.#send(event);
        return this.#reply.promise;
    }

    async #listen() {
        try {
            while (true) {
                const event = await this.#conn.next();
                if (event.type === 'done' && event.session === this.#id) {
                    this.#handleDone(event);
                } else {
                    this.#reply?.resolve(event);
                    if (event.type === 'sessionClosed') {
                        return;
                    }
                }
            }
        } catch (e) {
            this.#failure = e;
            this.#reply?.reject(e);
            for (const step of this.#steps.values()) {
                step.reject(e);
            }
        }
    }

    #handleDone(event: DoneEvent) {
        if (event.status === 'started') {
            this.onStarted(event.id);
            return;
        }
        const step = this.#steps.get(event.id);
        this.#steps.delete(event.id);
        if (event.status === 'done') {
            step?.resolve(event.output);
        } else {
            step?.reject(new RemoteError(String(event.output)));
        }
    }
}
