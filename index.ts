import { log } from './common/log';
import type { TagSet } from './common/task';
import * as builder from './local/builder';
import { runCli } from './local/cli';
import { Connection } from './local/connection';
import * as runner from './local/runner';
import { newTaskScheduler } from './local/scheduler';
import type { Task } from './local/task';
import type { Connector } from './protocol';

export * as protocols from './protocol';
export * as files from './task/files';
export * as nebula from './task/nebula';
export * as podman from './task/podman';
export * as systemd from './task/systemd';

/**
 * Groups tasks together. Tasks inside a group get then group's id as prefix
 * to their own ids. The group handler may also select which outputs to expose
 * for other code.
 * @param id Globally unique group id.
 * @param handler Callback that creates tasks inside the group.
 * @returns Outputs of handler, if any.
 */
export async function group<T>(
    id: string,
    handler: () => Promise<T> | T,
): Promise<T> {
    builder.pushId(id);
    const outputs = await handler();
    builder.popId();
    return outputs;
}

/**
 * Adds a set of tasks for a future deployment.
 * @param targets A set of tags that hosts must have for these tasks to be
 * deployed on them.
 * @param handler Handler that should add the tasks.
 * @param rolling Whether or not this set of tasks should receive a rolling
 * deployment. By default, the tasks are applied host-by-host. If set to
 * false, all tasks are applied in parallel, improving performance.
 */
export function on(
    targets: TagSet | string,
    handler: (host: Host) => Promise<void> | void,
    rolling: boolean = true,
): void {
    const targetTags =
        typeof targets === 'string' ? { host: targets } : targets;
    builder.addSource(async (host, prev) => {
        const hostTags = host.tags ?? {};
        hostTags.host = host.id;
        let shouldApply = false;
        // If we have even one of requested tags, run handler for this host
        // Handler code can do more complicated host selection logic if it wishes to
        for (const [tag, value] of Object.entries(targetTags)) {
            if (hostTags[tag] && new Bun.Glob(value).match(hostTags[tag])) {
                shouldApply = true;
                break;
            }
        }
        log.debug('load source', 'host', host.id, 'apply', shouldApply);
        if (shouldApply) {
            try {
                const startIdx = builder.enterHost(host.id);
                await handler(host);

                // Add task at end which depends on all tasks
                const tasks = builder.tasks;
                const end = builder.addTask(
                    `${tasks.at(-1)?.id}-end`,
                    '$noop',
                    {},
                    { onChanged: [] },
                ); // FIXME better id source
                for (let i = startIdx; i < tasks.length - 1; i++) {
                    const task = tasks[i]!;
                    end.after!.push(task.id);
                    end.onChanged!.push(task.id);
                    // If this is rolling, add dependency on previous end
                    if (rolling && prev) {
                        task.after.push(prev.id);
                    }
                }

                return end;
            } finally {
                builder.exitHost();
            }
        }
    });
}

export interface Host {
    id: string;
    conn: Connector;
    tags?: TagSet;
}

export async function connect(hosts: Host[]): Promise<TargetPool> {
    // Attempt to connect to hosts
    const attempts = await Promise.allSettled(
        hosts.map((host) => host.conn.connect()),
    );
    const failures = attempts
        .filter((conn) => conn.status === 'rejected')
        .map((conn) => conn.reason);
    const successes = attempts
        .filter((conn) => conn.status === 'fulfilled')
        .map((conn) => conn.value);
    if (failures.length > 0) {
        // On failure, close the successful connections before erroring!
        for (const conn of successes) {
            conn.close();
        }
        throw new AggregateError(failures, 'connecting to hosts failed');
    }
    // biome-ignore lint/style/noNonNullAssertion: there are no failures, indices in successes are same as indices in hosts
    const conns = successes.map((conn, i) => new Connection(conn, hosts[i]!));

    await builder.loadTasks(hosts);
    return new TargetPool(conns, builder.tasks);
}

export type Plan = runner.Plan;

export type Event = runner.Event;

export interface Result {
    /**
     * Id of host that was deployed to.
     */
    host: string;
    completed: string[];
    skipped: string[];
    errored: {
        taskId: string;
        error: string;
    }[];
}

async function* mergeAsync<T>(gens: AsyncGenerator<T>[]): AsyncGenerator<T> {
    const next = (g: AsyncGenerator<T>, i: number) =>
        g.next().then((r) => ({ g, i, r }));
    const pending = new Map(gens.map((g, i) => [i, next(g, i)]));
    while (pending.size) {
        const { g, i, r } = await Promise.race(pending.values());
        if (r.done) {
            pending.delete(i);
        } else {
            yield r.value;
            pending.set(i, next(g, i));
        }
    }
}

export class TargetPool {
    #conns: Connection[];
    #stage = 0;
    #tasks: Task[];

    constructor(conns: Connection[], tasks: Task[]) {
        this.#conns = conns;
        this.#tasks = tasks;
    }

    async plan(
        stack: string,
        mode: 'apply' | 'destroy' | 'reapply' = 'apply',
    ): Promise<Plan[]> {
        if (this.#stage > 0) {
            throw new Error('already planned');
        }
        this.#stage = 1;
        return await Promise.all(
            this.#conns.map((conn) =>
                runner.plan(
                    stack,
                    conn,
                    mode === 'destroy'
                        ? []
                        : this.#tasks.filter(
                              (task) => task.host === conn.host.id,
                          ),
                    mode === 'reapply',
                ),
            ),
        );
    }

    async execute(
        plans: Plan[],
        callback?: (event: Event) => void,
    ): Promise<Result[]> {
        if (this.#stage < 1) {
            throw new Error('not yet planned');
        }
        if (this.#stage > 1) {
            throw new Error('already executed');
        }
        this.#stage = 2;

        // Build the executable task list. Any id reported by the remote as
        // deleted is represented by a synthetic `$delete` pseudo-task — even
        // if a user-defined task with the same id is in this.#tasks. The
        // pseudo replaces the real entry so the runner takes the cleanup
        // path; otherwise we'd queue the same id twice (causing duplicate
        // `run` events and double cleanup, which is what `destroy` triggered
        // when this.#tasks was still populated).
        // TODO couldn't we just detect if this is destroy, and act accordingly if so?
        const deletedIds = new Set<string>();
        for (const plan of plans) {
            for (const entry of plan.deleted) deletedIds.add(entry.id);
        }
        const allTasks = this.#tasks.filter((t) => !deletedIds.has(t.id));
        for (const plan of plans) {
            for (const entry of plan.deleted) {
                allTasks.push({
                    id: entry.id,
                    host: plan.host.id,
                    type: '$delete',
                    after: [],
                    state: undefined,
                    localData: {} as { host: Host },
                });
            }
        }

        // Create executors that submit tasks to remotes on hosts
        const generators: AsyncGenerator<runner.Event>[] = [];
        const executors: Map<string, (task: Task) => void> = new Map();
        const shutdowns: (() => void)[] = [];
        for (const plan of plans) {
            const conn = this.#conns.find((conn) => conn.host === plan.host)!;

            const unchanged = new Set(plan.unchanged);
            // Use allTasks (not this.#tasks) so synthetic $delete tasks
            // detected only on the remote are included in the executor's
            // step map and reachable by exec().
            const changed = allTasks.filter(
                (task) => task.host === plan.host.id && !unchanged.has(task.id),
            );
            const oldStates: Map<string, unknown> = new Map();
            plan.updated.forEach((entry) => {
                oldStates.set(entry.id, entry.oldState);
            });
            plan.deleted.forEach((entry) => {
                oldStates.set(entry.id, entry.oldState);
            });

            const [listen, exec, shutdown] = await runner.newExecutor(
                conn,
                changed,
                oldStates,
            );
            generators.push(listen);
            executors.set(plan.host.id, exec);
            shutdowns.push(shutdown);
        }

        // Create scheduler, but do NOT start it yet. Same allTasks here so
        // $delete tasks get scheduled.
        const [scheduler, onCompleted] = newTaskScheduler(allTasks);

        // Mark unchanged tasks as completed (skipped means "skipped due to dependency error" and cascades; don't use it here!)
        for (const plan of plans) {
            for (const taskId of plan.unchanged) {
                onCompleted(
                    {
                        host: plan.host,
                        type: 'completed',
                        taskId,
                        status: 'done',
                    },
                    true,
                );
            }
        }

        // And now we can schedule rest of the tasks for execution!
        const hosts = new Map(
            this.#conns.map((conn) => [conn.host.id, conn.host]),
        );
        async function* run(): AsyncGenerator<runner.Event> {
            try {
                for await (const sched of scheduler()) {
                    if (sched.status === 'skipped') {
                        // Skipped locally (e.g. dependency failed) — the
                        // task never reaches the remote, so emit its
                        // completion event here.
                        yield {
                            host: hosts.get(sched.task.host)!,
                            type: 'completed',
                            status: 'skipped',
                            taskId: sched.task.id,
                        };
                    } else {
                        yield {
                            host: hosts.get(sched.task.host)!,
                            type: 'started',
                            status: 'started',
                            taskId: sched.task.id,
                        };
                        executors.get(sched.task.host)!(sched.task);
                    }
                }
                log.debug('scheduler has finished');
            } finally {
                // Scheduler done — tell each per-host listener to stop
                // awaiting further remote responses.
                for (const shutdown of shutdowns) shutdown();
            }
        }
        generators.push(run());

        // Collect per-host results and start rolling tasks as they complete in previous hosts
        const byHost = new Map<string, Result>(
            plans.map((plan) => [
                plan.host.id,
                {
                    host: plan.host.id,
                    completed: [],
                    skipped: [],
                    errored: [],
                },
            ]),
        );
        for await (const event of mergeAsync(generators)) {
            callback?.(event);
            switch (event.type) {
                case 'completed': {
                    onCompleted(event, false);
                    const result = byHost.get(event.host.id);
                    if (!result) {
                        throw new Error(
                            `unknown host in event: ${event.host.id}`,
                        );
                    }
                    switch (event.status) {
                        case 'done':
                            result.completed.push(event.taskId);
                            break;
                        case 'skipped':
                            result.skipped.push(event.taskId);
                            break;
                        case 'error':
                            result.errored.push({
                                taskId: event.taskId,
                                error: event.error ?? 'unknown',
                            });
                            break;
                    }
                    break;
                }
            }
        }

        return [...byHost.values()];
    }

    async close(): Promise<void> {
        await Promise.allSettled(this.#conns.map((conn) => conn.close()));
    }
}

/**
 * Plan, apply, destroy, list tasks, or install the agent — driven by CLI
 * subcommands read from `Bun.argv`. This is the entry point a user's
 * deployment script calls. To inspect and apply plans programmatically,
 * use the lower-level `connect()` / `TargetPool` directly instead.
 * @param stack Stack to apply tasks in.
 * @param hosts List of hosts.
 */
export async function deploy(stack: string, hosts: Host[]): Promise<void> {
    await runCli(stack, hosts);
}
