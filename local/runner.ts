import type { Host } from '@bensku/tunkki';
import type { Step } from '@bensku/tunkki/task';
import type { StepStatus } from '../common/event';
import { LOG_LEVEL, log } from '../common/log';
import type { Connection } from './connection';
import { loadHandlerCode, loadSteps, type Task } from './task';

export interface Plan {
    host: Host;

    unchanged: string[];
    created: string[];
    updated: { id: string; oldState: unknown }[];
    deleted: { id: string; oldState: unknown }[];
}

export async function plan(
    stack: string,
    conn: Connection,
    tasks: Task[],
    reapply: boolean,
): Promise<Plan> {
    // Configure the remote
    await conn.send({
        type: 'settings',
        stack,
        concurrency: 4, // TODO
        logLevel: LOG_LEVEL,
    });

    // Upload task handlers that will be needed to remote
    const handlers = await loadHandlerCode(tasks);
    await conn.send({
        type: 'uploadHandlers',
        handlers,
    });

    // Collect status events and wait for ready in background
    const planPromise = (async () => {
        const plan: Plan = {
            host: conn.host,
            unchanged: [],
            created: [],
            updated: [],
            deleted: [],
        };
        for await (const event of conn.listen()) {
            log.debug('remote->local', event);
            switch (event.type) {
                case 'fatal': {
                    throw new Error(
                        `fatal error on host ${conn.host.id}: ${event.error}`,
                    );
                }
                case 'status': {
                    switch (event.status) {
                        case 'unchanged':
                            plan.unchanged.push(event.id);
                            break;
                        case 'created':
                            plan.created.push(event.id);
                            break;
                        case 'updated':
                            plan.updated.push({
                                id: event.id,
                                oldState: event.oldState,
                            });
                            break;
                        case 'deleted':
                            plan.deleted.push({
                                id: event.id,
                                oldState: event.oldState,
                            });
                            break;
                    }
                    break;
                }
                case 'ready': {
                    return plan; // Quit listening and return finished plan
                }
            }
        }
        throw new Error('remote did not become ready');
    })();

    // Send tasks to remote
    for (const task of tasks) {
        await conn.send({
            type: 'task',
            id: task.id,
            state: task.state,
            taskType: task.type,
            reapply: reapply ? true : undefined,
        });
    }
    await conn.send({
        type: 'tasksSent',
    });

    // Patch onChangeds to plan. Iterate to a fixed point so transitive
    // promotion works: if B has onChanged=[A] and is promoted because A
    // moved, then C with onChanged=[B] must also be promoted in a subsequent
    // pass (B is no longer "unchanged" from C's perspective).
    const plan = await planPromise;
    const unchanged = new Set(plan.unchanged);
    let progress = true;
    while (progress) {
        progress = false;
        for (const task of tasks) {
            if (!unchanged.has(task.id)) continue;
            for (const dep of task.onChanged ?? []) {
                if (!unchanged.has(dep)) {
                    // onChanged has changed, move this task to changed
                    log.debug(
                        'change detected in onChanged',
                        'dep',
                        dep,
                        'task',
                        task.id,
                    );
                    unchanged.delete(task.id);
                    const idx = plan.unchanged.indexOf(task.id);
                    plan.unchanged.splice(idx, 1);
                    plan.updated.push({
                        id: task.id,
                        oldState: task.state, // State did not actually change, we'll just pretend it did
                    });
                    // ... and let remote know!
                    await conn.send({
                        type: 'task',
                        id: task.id,
                        state: task.state, // TODO avoid resending state
                        taskType: task.type,
                        reapply: true,
                    });
                    progress = true;
                    break;
                }
            }
        }
    }

    return plan;
}

export interface Event {
    host: Host;
    type: 'started' | 'completed';
    taskId: string;
    status: StepStatus;
    error?: string;
}

export async function newExecutor(
    conn: Connection,
    changed: Task[],
    oldStates: Map<string, unknown>,
): Promise<[AsyncGenerator<Event>, (task: Task) => void, () => void]> {
    // Load handlers locally, not all steps run on remote'
    // TODO maybe load this once outside of runner?
    const steps = await loadSteps(changed);

    // Shutdown signal: the caller flips this when the scheduler is done so
    // listenEvents can stop awaiting further remote responses. Without it,
    // any task the scheduler resolved locally (e.g. via skip-cascade) leaves
    // listenEvents hanging on `conn.listen()` forever.
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((r) => (resolveShutdown = r));
    const SHUTDOWN_SENTINEL = Symbol('shutdown');

    async function* listenEvents(): AsyncGenerator<Event> {
        if (changed.length === 0) {
            return;
        }

        const taskMap = new Map(changed.map((t) => [t.id, t]));
        const currentStep: Map<string, number> = new Map();

        const iter = conn.listen()[Symbol.asyncIterator]();
        while (true) {
            const next = await Promise.race([
                iter.next(),
                shutdown.then(() => SHUTDOWN_SENTINEL),
            ]);
            if (typeof next === 'symbol') {
                log.debug('executor shutdown', 'host', conn.host.id);
                return;
            }
            if (next.done) return;
            const event = next.value;
            switch (event.type) {
                case 'fatal': {
                    throw new Error(
                        `fatal error on host ${conn.host.id}: ${event.error}`,
                    );
                }
                case 'done': {
                    const task = taskMap.get(event.id)!;
                    switch (event.status) {
                        case 'error':
                            yield {
                                host: conn.host,
                                type: 'completed',
                                taskId: event.id,
                                status: 'error',
                                error: event.result as string,
                            };
                            break;
                        case 'skipped':
                            yield {
                                host: conn.host,
                                type: 'completed',
                                taskId: event.id,
                                status: 'skipped',
                            };
                            break;
                        case 'done': {
                            const nextStep =
                                (currentStep.get(event.id) ?? 0) + 1;
                            if (nextStep === steps[task.type]?.length) {
                                yield {
                                    host: conn.host,
                                    type: 'completed',
                                    taskId: event.id,
                                    status: 'done',
                                };
                            } else {
                                currentStep.set(event.id, nextStep);
                                await runStep(
                                    conn,
                                    steps,
                                    task,
                                    nextStep,
                                    event.result,
                                );
                            }
                            break;
                        }
                    }
                    break;
                }
                case 'run': {
                    // Local self-sends run events to support rolling tasks
                    // As rolling tasks are completed, next hosts can begin executing them
                    const task = taskMap.get(event.id);
                    // Rolling tasks don't necessarily apply on all hosts
                    if (task) {
                        await runStep(
                            conn,
                            steps,
                            task,
                            0,
                            task.state,
                            oldStates.get(task.id),
                        );
                    }
                    break;
                }
            }
        }
    }

    const submitTask = (task: Task) => {
        return runStep(
            conn,
            steps,
            task,
            0,
            task.state,
            oldStates.get(task.id),
        );
    };

    return [listenEvents(), submitTask, resolveShutdown];
}

async function runStep(
    conn: Connection,
    steps: Record<string, Step[]>,
    task: Task,
    stepIdx: number,
    state: unknown,
    oldState?: unknown,
) {
    const taskSteps = steps[task.type];
    if (!taskSteps) {
        throw new Error(
            `internal error: task ${task.id} steps not loaded (type ${task.type})`,
        );
    }
    const step = taskSteps.at(stepIdx);
    if (!step) {
        throw new Error(); // Validation should've failed this well before we got to runTasks!
    }

    // Inject host into localData before first step
    if (stepIdx === 0) {
        task.localData.host = conn.host;
    }

    if (step.location === 'local') {
        (async () => {
            let result: unknown;
            let error: unknown;
            try {
                // oldState is only meaningful for step 0 of an update;
                // subsequent steps receive their predecessor's result as state.
                result =
                    stepIdx === 0
                        ? await step.handler(state, task.localData, oldState)
                        : await step.handler(state, task.localData);
            } catch (e) {
                error = e;
            }
            // Send event locally to reuse remote step code paths!
            const status = error ? 'error' : 'done';
            conn.sendToSelf({
                type: 'done',
                id: task.id,
                status,
                result: error ? error : result,
            });

            if (stepIdx === taskSteps.length - 1) {
                // If this was the last step, let remote know to release dependents!
                await conn.send({
                    type: 'done',
                    id: task.id,
                    status,
                    result: undefined,
                });
            }
        })();
    } else {
        // Send task to remote; we'll get done back asynchronously
        await conn.send({
            type: 'run',
            id: task.id,
            // First step's state was already sent in plan phase
            state: stepIdx === 0 ? undefined : state,
            step: stepIdx,
        });
    }
}
