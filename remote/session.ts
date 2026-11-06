import type { Event, TaskRecord } from '../common/event';
import { log } from '../common/log';
import { stepsOf, type TaskHandler } from '../common/task';
import { loadState, type State } from './state';
import { type Reply, Semaphore } from './util';

type RunEvent = Extract<Event, { type: 'run' }>;

export interface SessionOptions {
    id: string;
    stateDir: string;
    concurrency: number;
    reply: Reply;
}

/**
 * Opens an apply session.
 * @param opts Session options.
 * @param stateHash Hash of the state file that local planned against.
 * @throws If the state file has changed since then.
 */
export async function openSession(
    opts: SessionOptions,
    stateHash: string,
): Promise<Session> {
    const state = await loadState(opts.stateDir);
    if (state.hash !== stateHash) {
        throw new Error(
            'state has changed since the plan was made, please plan again',
        );
    }
    return new Session(opts, state);
}

/**
 * Executes steps and records state on behalf of local. Methods that do work
 * reply to local themselves, so callers don't need to await them.
 */
export class Session {
    #id: string;
    #reply: Reply;
    #state: State;
    #slots: Semaphore;
    #handlers: Record<string, TaskHandler> = {};
    #pending = new Set<Promise<void>>();
    #commitErrors: string[] = [];

    constructor(opts: SessionOptions, state: State) {
        this.#id = opts.id;
        this.#reply = opts.reply;
        this.#state = state;
        this.#slots = new Semaphore(opts.concurrency);
    }

    /**
     * Imports handlers from data URLs. Replies with ready.
     */
    async loadHandlers(handlers: Record<string, string>) {
        let error: string | undefined;
        try {
            for (const [type, url] of Object.entries(handlers)) {
                this.#handlers[type] = await import(url);
            }
        } catch (e) {
            error = Bun.inspect(e);
        }
        this.#reply({ type: 'ready', session: this.#id, error });
    }

    /**
     * Runs a step or a cleanup. Replies with done.
     */
    run(event: RunEvent) {
        this.#track(this.#run(event));
    }

    /**
     * Writes a record. Failures are reported when the session closes.
     */
    commit(id: string, record: TaskRecord) {
        this.#track(
            this.#state.commit(id, record).catch((e) => {
                log.error('commit failed', 'task', id, 'error', e);
                this.#commitErrors.push(`${id}: ${Bun.inspect(e)}`);
            }),
        );
    }

    /**
     * Waits for pending work. Replies with sessionClosed.
     */
    async close() {
        while (this.#pending.size > 0) {
            await Promise.all(this.#pending);
        }
        this.#reply({
            type: 'sessionClosed',
            session: this.#id,
            error:
                this.#commitErrors.length > 0
                    ? `failed to commit:\n${this.#commitErrors.join('\n')}`
                    : undefined,
        });
    }

    #track(promise: Promise<void>) {
        const tracked = promise
            .catch((e) => log.error('internal error', e))
            .finally(() => this.#pending.delete(tracked));
        this.#pending.add(tracked);
    }

    async #run(event: RunEvent) {
        const release = await this.#slots.acquire();
        try {
            this.#done(event.id, 'started', null);
            const output =
                event.state === undefined
                    ? await this.#cleanup(event.task, event.id)
                    : await this.#step(event);
            this.#done(event.id, 'done', output);
        } catch (e) {
            log.error(
                'step failed',
                'task',
                event.id,
                'step',
                event.step,
                'error',
                e,
            );
            this.#done(event.id, 'error', Bun.inspect(e));
        } finally {
            release();
        }
    }

    async #cleanup(type: string, id: string) {
        const record = this.#state.records[id];
        // $noop has no handler, and nothing to clean up
        if (record && type !== '$noop') {
            await this.#handler(type).cleanup?.(record.state);
        }
        await this.#state.delete(id);
        log.info('cleaned up', 'task', id);
    }

    async #step(event: RunEvent) {
        const step = stepsOf(this.#handler(event.task))[event.step];
        if (step?.location !== 'remote') {
            throw new Error(
                `task type ${event.task} has no remote step ${event.step}`,
            );
        }
        const oldState =
            event.step === 0 ? this.#state.records[event.id]?.state : undefined;
        const output = await step.handler(event.state, undefined, oldState);
        log.info('executed step', 'task', event.id, 'step', event.step);
        return output;
    }

    #handler(type: string): TaskHandler {
        const handler = this.#handlers[type];
        if (!handler) {
            throw new Error(`handler for ${type} was not loaded`);
        }
        return handler;
    }

    #done(id: string, status: 'started' | 'done' | 'error', output: unknown) {
        this.#reply({ type: 'done', session: this.#id, id, status, output });
    }
}
