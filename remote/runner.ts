import * as fs from 'node:fs/promises';
import { type Event, writeEvent } from '../common/event';
import { log, setupLogger } from '../common/log';
import type { TaskHandler } from '../common/task';
import { Semaphore } from './util';

export class Runner {
    #handlerDir: string | undefined;
    #stateDir: string | undefined;

    /**
     * Current state on this remote.
     */
    #state: Record<string, TaskState> = {};

    /**
     * Tasks that we have seen since last reset. This includes tasks that do
     * not need any action from us!
     */
    #seenTasks: Set<string>;

    /**
     * Tasks that need to be applied or cleaned up. This does NOT include
     * tasks that do not need any action.
     */
    #tasks: Map<string, Task>;

    /**
     * Reverse dependency index: task id -> ids of tasks that depend on it.
     * Built incrementally as `task` events arrive so we can wake dependents
     * the moment a dependency completes.
     */
    #dependents: Map<string, Set<string>>;

    /**
     * Tasks that have fully completed, i.e. all steps run without errors or
     * task was entirely skipped.
     */
    #completed: Set<string>;

    /**
     * Tasks that errored, or that were skipped due to a transitive failed
     * dependency. New `run` events for these reply `skipped` immediately.
     */
    #failed: Set<string>;

    /**
     * `run` events with step 0 that arrived before their dependencies were
     * completed. Typically, this occurs when said dependencies need to bounce
     * back between remote and local steps.
     *
     * `run` events after step 0 are never queued.
     */
    #pending: Map<string, RunEvent>;

    #taskSlots: Semaphore | undefined;
    #saveLock: Semaphore;

    constructor() {
        this.#seenTasks = new Set();
        this.#tasks = new Map();
        this.#dependents = new Map();
        this.#completed = new Set();
        this.#failed = new Set();
        this.#pending = new Map();
        this.#saveLock = new Semaphore(1);
    }

    async #loadConfig(workDir: string, concurrency: number) {
        this.#handlerDir = `${workDir}/handlers`;
        this.#stateDir = `${workDir}/state`;
        this.#taskSlots = new Semaphore(concurrency);

        const file = Bun.file(`${this.#stateDir}/current.json`);
        if (!(await file.exists())) {
            this.#state = {}; // No state file, possibly first ever deploy
        } else {
            this.#state = await file.json();
        }
        log.debug('loaded local state', 'file', file.name);
    }

    async #saveState() {
        const release = await this.#saveLock.acquire();
        try {
            // Write to different file, then atomic rename to reduce likehood of state corruption
            await Bun.write(
                `${this.#stateDir}/next.json`,
                JSON.stringify(this.#state),
            );
            await fs.rename(
                `${this.#stateDir}/next.json`,
                `${this.#stateDir}/current.json`,
            );
            log.debug('saved state', 'file', `${this.#stateDir}/current.json`);
        } finally {
            release();
        }
    }

    async handleEvent(event: Event) {
        log.debug('local->remote', 'event', event);
        switch (event.type) {
            case 'settings':
                // Local sends configuration to us
                setupLogger((msg) => console.error(...msg.msg), event.logLevel);
                await this.#loadConfig(
                    `/opt/tunkki/${event.stack}`,
                    event.concurrency,
                );
                log.info(
                    'configured',
                    'stack',
                    event.stack,
                    'concurrency',
                    event.concurrency,
                    'logLevel',
                    event.logLevel,
                );
                break;
            case 'uploadHandlers': {
                // Write handlers to disk, overwriting old ones if needed
                for (const [name, code] of Object.entries(event.handlers)) {
                    await Bun.write(`${this.#handlerDir}/${name}.ts`, code);
                }
                break;
            }
            case 'task': {
                // Local has sent a task. Queue if we need to execute anything
                this.#seenTasks.add(event.id); // at least this task was not deleted

                // Register reverse dep edges so we can wake this task when its
                // dependencies complete (regardless of arrival order).
                if (event.dependsOn) {
                    for (const depId of event.dependsOn) {
                        let dependents = this.#dependents.get(depId);
                        if (!dependents) {
                            dependents = new Set();
                            this.#dependents.set(depId, dependents);
                        }
                        dependents.add(event.id);
                    }
                }

                const oldState = this.#state[event.id];
                if (
                    oldState?.handler === event.taskType &&
                    Bun.deepEquals(oldState?.state, event.state)
                ) {
                    // No changes needed; instantly complete so dependents may proceed
                    this.#markCompleted(event.id);
                    reply({
                        type: 'status',
                        id: event.id,
                        status: 'unchanged',
                        oldState: undefined, // Same as what local side already has, no need to pass it
                    });
                } else {
                    // Some changes needed, track a task...
                    this.#tasks.set(event.id, {
                        type: event.taskType,
                        handler: await import(
                            `${this.#handlerDir}/${event.taskType}.ts`
                        ),
                        state: event.state,
                        dependsOn: event.dependsOn,
                        // If task type changed, we need to cleanup it before updating with new state
                        recreateWith:
                            oldState?.handler &&
                            oldState.handler !== event.taskType
                                ? await import(
                                      `${this.#handlerDir}/${oldState.handler}.ts`
                                  )
                                : undefined,
                    });
                    // Let local side know about changes
                    reply({
                        type: 'status',
                        id: event.id,
                        status: oldState ? 'updated' : 'created',
                        // If we're updating, pass old state to client; if creating, it is naturally undefined
                        oldState: oldState?.state,
                    });
                }
                break;
            }
            case 'tasksSent': {
                // Local has sent all tasks. Check if we have tasks that were not sent
                // and queue them for cleanup if any are found
                for (const [id, state] of Object.entries(this.#state)) {
                    if (!this.#seenTasks.has(id)) {
                        // Deleted
                        this.#tasks.set(id, {
                            // Old handler should still exist on our disk...
                            type: state.handler,
                            handler: await import(
                                `${this.#handlerDir}/${state.handler}.ts`
                            ),
                            state: undefined, // undefined == state does not exist, please cleanup
                        });
                        reply({
                            type: 'status',
                            id,
                            status: 'deleted',
                            oldState: state.state,
                        });
                    }
                }

                // Plan phase done, local side can now command us to deploy if it wishes
                reply({
                    type: 'ready',
                });
                log.info('all tasks received');
                break;
            }
            case 'run': {
                if (event.step === 0) {
                    const task = this.#tasks.get(event.id);
                    if (!task) {
                        throw new Error(`missing task: ${event.id}`);
                    }
                    const deps = task.dependsOn ?? [];

                    // If any of dependencies have failed, immediately skip this due to failure
                    for (const dep of deps) {
                        if (this.#failed.has(dep)) {
                            reply({
                                type: 'done',
                                id: event.id,
                                result: undefined,
                                status: 'skipped',
                            });
                            this.#markFailed(event.id);
                            log.info(
                                'skipped task due to dependency error',
                                'task',
                                event.id,
                                'dependency',
                                dep,
                            );
                            return;
                        }
                    }

                    // If any of dependencies are pending, queue this until they have completed
                    for (const dep of deps) {
                        if (!this.#completed.has(dep)) {
                            this.#pending.set(event.id, event);
                            log.debug(
                                'dependencies not ready, marked as pending',
                                'task',
                                event.id,
                            );
                            return;
                        }
                    }
                } // else: task has already started execution, so its dependencies must've been completed
                this.#dispatchRun(event);
                break;
            }
            case 'done': {
                // In rare cases where local side executes last step, it'll send US done event with results
                if (event.status === 'error') {
                    this.#markFailed(event.id);
                } else {
                    this.#markCompleted(event.id);
                }
                break;
            }
            case 'reset':
                break; // TODO
        }
    }

    async #dispatchRun(event: RunEvent) {
        const release = await this.#taskSlots!.acquire();
        try {
            const task = this.#tasks.get(event.id);
            if (!task) {
                throw new Error(`missing task: ${event.id}`);
            }
            const steps = Array.isArray(task.handler.apply)
                ? task.handler.apply
                : [task.handler.apply];
            let result: unknown;
            let errored = false;
            try {
                if (event.step === 0) {
                    // First step gets some special handling
                    if (task?.recreateWith?.cleanup) {
                        // If task changed handler, we'll need to first cleanup using old handler
                        await task?.recreateWith?.cleanup(
                            this.#state[event.id]?.state,
                        );
                        log.info('cleanup due to recreate', 'task', event.id);
                    }
                    // And then we can apply the first step with state stored locally
                    if (task.state === undefined) {
                        // Deleting? Cleanup if the handler can do that
                        if (task.handler.cleanup) {
                            await task.handler.cleanup(this.#state[event.id]?.state);
                        }
                        result = undefined;
                        log.info('cleanup due to delete', 'task', event.id);
                    } else {
                        // Just apply create/update for first step
                        result = await steps[0]!.handler(task.state);
                        log.info('executed step', 'task', event.id, 'step', 0);
                    }
                } else {
                    // For subsequent steps, we've been passed the state
                    result = await steps[event.step]!.handler(event.state);
                    log.info(
                        'executed step',
                        'task',
                        event.id,
                        'step',
                        event.step,
                    );
                }
            } catch (e) {
                log.error(
                    'failed task step',
                    'task',
                    event.id,
                    'step',
                    event.step,
                    'error',
                    e,
                );
                result = `${e}`;
                errored = true;
            }

            // Let local side know that we're done with the task
            reply({
                type: 'done',
                id: event.id,
                result,
                status: errored ? 'error' : 'done',
            });

            if (errored) {
                this.#markFailed(event.id);
            } else if (task.state === undefined) {
                // Task was deleted
                delete this.#state[event.id];
                await this.#saveState();
            } else if (event.step === steps.length - 1) {
                // Last step executed successfully, save state and mark as completed
                this.#state[event.id] = {
                    handler: task.type,
                    state: task.state,
                };
                await this.#saveState();
                this.#markCompleted(event.id);
            }
        } finally {
            release();
        }
    }

    #markCompleted(id: string) {
        this.#completed.add(id);

        const dependents = this.#dependents.get(id);
        if (!dependents) {
            return;
        }

        // If we have dependents, wake them up if their other dependencies are also completed
        outer: for (const id of dependents) {
            const pendingEvent = this.#pending.get(id);
            if (pendingEvent) {
                const task = this.#tasks.get(id);
                if (!task) {
                    throw new Error(`missing task: ${id}`);
                }
                for (const dep of task.dependsOn ?? []) {
                    if (!this.#completed.has(dep)) {
                        continue outer; // Other dependencies not yet completed
                    }
                }
                // All dependencies completed, run the task
                this.#dispatchRun(pendingEvent);
            }
        }
    }

    #markFailed(id: string) {
        this.#failed.add(id);

        // Cancel dependents
        for (const depId of this.#dependents.get(id) ?? []) {
            const cancelled = this.#pending.delete(depId);
            if (cancelled) {
                // We need to let local side know that task was skipped due to dependency failure
                reply({
                    type: 'done',
                    id: depId,
                    result: undefined,
                    status: 'skipped',
                });
            }
        }
    }
}

type RunEvent = Extract<Event, { type: 'run' }>;

interface Task {
    type: string;
    handler: TaskHandler;
    state: unknown;
    dependsOn?: string[];
    recreateWith?: TaskHandler;
}

interface TaskState {
    handler: string;
    state: unknown;
}

function reply(event: Event) {
    log.debug('remote->local', 'event', event);
    process.send!(writeEvent(event));
}
