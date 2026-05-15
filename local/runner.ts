import type { Host } from '..';
import type { StepStatus } from '../common/event';
import { LOG_LEVEL, log } from '../common/log';
import type { Step } from '../task';
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
    const plan = (async () => {
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
            dependsOn: task.dependsOn,
        });
    }
    await conn.send({
        type: 'tasksSent',
    });

    return plan;
}

export interface Event {
    host: Host;
    type: 'completed' | 'hostCompleted';
    taskId: string;
    status: StepStatus;
    error?: string;
}

export async function* execute(
    conn: Connection,
    tasks: Task[],
    oldStates: Map<string, unknown>,
    rollFirst: boolean,
): AsyncGenerator<Event> {
    if (tasks.length === 0) {
        return { completed: [], skipped: [], errored: [] };
    }

    // Load handlers locally, not all steps run on remote
    const steps = await loadSteps(tasks);

    const taskMap: Map<string, Task> = new Map();
    const currentStep: Map<string, number> = new Map();
    let completedCount = 0;

    // Start first step of each task
    for (const task of tasks) {
        taskMap.set(task.id, task);
        if (!task.rolling || rollFirst) {
            await runStep(
                conn,
                steps,
                task,
                0,
                task.state,
                oldStates.get(task.id),
            );
        }
    }

    // Listen to events from remote.
    // Run further steps and mark tasks as completed as needed.
    for await (const event of conn.listen()) {
        switch (event.type) {
            case 'done':
                {
                    const task = taskMap.get(event.id)!;
                    switch (event.status) {
                        case 'error':
                            completedCount++;
                            yield {
                                host: conn.host,
                                type: 'completed',
                                taskId: event.id,
                                status: 'error',
                                error: event.result as string,
                            };
                            if (task.rolling) {
                                yield {
                                    host: conn.host,
                                    type: 'hostCompleted',
                                    taskId: event.id,
                                    status: 'error',
                                };
                            }
                            break;
                        case 'skipped':
                            // Typically, tasks are skipped due to errored (transitive) dependencies
                            completedCount++;
                            yield {
                                host: conn.host,
                                type: 'completed',
                                taskId: event.id,
                                status: 'skipped',
                            };
                            if (task.rolling) {
                                // This kind of skipped task should be treated as an error that stops
                                // the rolling deploy!
                                yield {
                                    host: conn.host,
                                    type: 'hostCompleted',
                                    taskId: event.id,
                                    status: 'error',
                                };
                            }
                            break;
                        case 'done': {
                            const next = (currentStep.get(event.id) ?? 0) + 1;
                            if (next === steps[task.type]?.length) {
                                completedCount++;
                                yield {
                                    host: conn.host,
                                    type: 'completed',
                                    taskId: event.id,
                                    status: 'done',
                                };
                                if (task.rolling) {
                                    yield {
                                        host: conn.host,
                                        type: 'hostCompleted',
                                        taskId: event.id,
                                        status: 'done',
                                    };
                                }
                            } else {
                                currentStep.set(event.id, next);
                                await runStep(
                                    conn,
                                    steps,
                                    task,
                                    next,
                                    event.result,
                                );
                            }
                            break;
                        }
                    }
                }
                break;
            case 'run': {
                // Local self-sends run events to support rolling tasks
                // As rolling tasks are completed, next hosts can begin executing them
                const task = taskMap.get(event.id);
                // Rolling tasks don't necessarily apply on all hosts
                if (task) {
                    // We'll report to caller once the task is done
                    await runStep(
                        conn,
                        steps,
                        task,
                        0,
                        task.state,
                        oldStates.get(task.id),
                    );
                } else {
                    // Report to caller immediately!
                    yield {
                        host: conn.host,
                        type: 'hostCompleted',
                        taskId: event.id,
                        status: 'skipped',
                    };
                }
                break;
            }
        }
        if (completedCount === tasks.length) {
            break;
        }
    }
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
        throw new Error();
    }
    const step = taskSteps.at(stepIdx);
    if (!step) {
        throw new Error(); // Validation should've failed this well before we got to runTasks!
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
                        ? await step.handler(state, oldState)
                        : await step.handler(state);
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
