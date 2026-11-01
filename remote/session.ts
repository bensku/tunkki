import * as fs from 'node:fs/promises';
import type { ApplyEvent } from '../common/event';
import type { TaskHandler } from '../common/task';
import { loadState } from './state';
import { reply, Semaphore } from './util';

export interface Session {
    handleEvent(event: ApplyEvent): void;
}

/**
 * Starts a new session that can apply changes to this machine.
 * @param session Session id.
 * @param stack Stack this session will operate on.
 * @param concurrency Max number of tasks executing concurrently.
 * @returns Session.
 */
export async function newSession(
    session: string,
    stack: string,
    concurrency: number,
): Promise<Session> {
    // Load this remote's state
    const stateDir = `/opt/tunkki/${stack}`;
    await fs.mkdir(stateDir, { recursive: true });
    const state = await loadState(stateDir);

    const handlers: Record<string, TaskHandler> = {
        // TODO consider if we even need no-op handler anymore
        $noop: {
            apply: {
                handler: () => Promise.resolve(),
                location: 'remote',
            },
        },
    };

    const taskSemaphore = new Semaphore(concurrency);

    const applyTask = async (
        handler: TaskHandler,
        id: string,
        step: number,
        taskState: unknown,
    ): Promise<unknown> => {
        const apply = Array.isArray(handler.apply)
            ? handler.apply[step]
            : handler.apply;
        if (!apply) {
            reply({
                type: 'done',
                session,
                id,
                status: 'error',
                output: `missing step ${step}`,
            });
            return;
        }
        const stepCount = Array.isArray(handler.apply)
            ? handler.apply.length
            : 1;

        // Execute task as soon as we can
        const release = await taskSemaphore.acquire();
        try {
            reply({
                type: 'done',
                session,
                id,
                status: 'started',
                output: null,
            });

            // If this is first step, dig old state so it can perhaps apply changes more "gracefully"
            const oldState = step === 0 ? state.input(id) : undefined;
            const output = await apply.handler(taskState, undefined, oldState); // Invoke handler

            // Save input if this is first or output if this is the last step
            if (step === 0) {
                await state.setInput(id, taskState);
            } else if (step === stepCount - 1) {
                await state.setOutput(id, output);
            }
            return output;
        } catch (e) {
            reply({
                type: 'done',
                session,
                id,
                status: 'error',
                output: Bun.inspect(e),
            });
        } finally {
            release();
        }
    };

    const cleanupTask = async (handler: TaskHandler, id: string) => {
        const cleanup = handler.cleanup;
        const release = await taskSemaphore.acquire();
        try {
            reply({
                type: 'done',
                session,
                id,
                status: 'started',
                output: null,
            });

            if (cleanup) {
                await cleanup(state.input(id));
            }
            await state.delete(id);
        } catch (e) {
            reply({
                type: 'done',
                session,
                id,
                status: 'error',
                output: Bun.inspect(e),
            });
        } finally {
            release();
        }
    };

    return {
        async handleEvent(event) {
            switch (event.type) {
                // open and close are handled by runner!
                case 'loadHandlers': {
                    let error: string | undefined;
                    try {
                        // Handlers are self-contained base64 URLs
                        for (const [id, code] of Object.entries(
                            event.handlers,
                        )) {
                            handlers[id] = await import(code);
                        }
                    } catch (e) {
                        error = Bun.inspect(e);
                    }
                    // Let local know we've loaded handlers or died trying
                    reply({
                        type: 'ready',
                        session,
                        error,
                    });
                    break;
                }
                case 'run': {
                    // Locate this task's handler that SHOULD have been uploaded to us (see above)
                    const handler = handlers[event.task];
                    if (!handler) {
                        reply({
                            type: 'done',
                            session,
                            id: event.id,
                            status: 'error',
                            output: 'missing handler',
                        });
                        return;
                    }

                    if (event.state === undefined) {
                        await cleanupTask(handler, event.id);
                        reply({
                            type: 'done',
                            session,
                            id: event.id,
                            status: 'done',
                            output: null,
                        });
                    } else {
                        // TODO we need to somehow duplicate this logic on local side, in case first step runs there (tricky!)
                        if (event.step === 0) {
                            // Substitute values that were not known plan-time
                            const input =
                                event.step === 0
                                    ? substituteState(event.state, event.replacements)
                                    : event.state;
                            if (
                                !event.force &&
                                Bun.deepEquals(input, state.input(event.id))
                            ) {
                                // Unchanged. Probably, some dependency of us changed, but its outputs stayed same by chance
                                reply({
                                    type: 'done',
                                    session,
                                    id: event.id,
                                    status: 'unchanged',
                                    output: null,
                                });
                            } else {
                                // Apply as usual
                                const output = await applyTask(
                                    handler,
                                    event.id,
                                    event.step,
                                    input,
                                );
                                reply({
                                    type: 'done',
                                    session,
                                    id: event.id,
                                    status: 'done',
                                    output,
                                });
                            }
                        } else {
                            // Not first step, we've already checked if this should execute before!
                            const output = await applyTask(
                                handler,
                                event.id,
                                event.step,
                                event.state,
                            );
                            reply({
                                type: 'done',
                                session,
                                id: event.id,
                                status: 'done',
                                output,
                            });
                        }
                    }
                    break;
                }
                case 'done': {
                    // Local is letting us know it has finished a task
                    // Persist output here!
                    state.setOutput(event.id, event.output);
                }
            }
        },
    };
}

function substituteState(
    state: unknown,
    subs: Record<string, unknown>,
): unknown {
    // TODO implement
    return null;
}
