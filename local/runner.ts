import type { StepStatus } from '../common/event';
import type { Step } from '../task';
import type { Connection } from './connection';
import { loadHandlerCode, loadSteps, type Task } from './task';

export interface Plan {
    unchanged: string[];
    created: string[];
    updated: { id: string; oldState: unknown }[];
    deleted: { id: string; oldState: unknown }[];
}

export async function plan(
    conn: Connection,
    tasks: Task[],
    options: { debug?: boolean },
): Promise<Plan> {
    // Upload task handlers that will be needed to remote
    const handlers = await loadHandlerCode(tasks);
    await conn.send({
        type: 'uploadHandlers',
        handlers,
    });
    if (options.debug) {
        console.log('sent handlers');
    }

    // Collect status events and wait for ready in background
    const plan = (async () => {
        const plan: Plan = {
            unchanged: [],
            created: [],
            updated: [],
            deleted: [],
        };
        for await (const event of conn.listen()) {
            if (options.debug) {
                console.log('received event', event);
            }
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
    if (options.debug) {
        console.log('all tasks sent');
    }

    return plan;
}

export async function execute(conn: Connection, tasks: Task[]) {
    if (tasks.length === 0) {
        return;
    }

    // Load handlers locally, not all steps run on remote
    const steps = await loadSteps(tasks);

    const taskMap: Map<string, Task> = new Map();
    const currentStep: Map<string, number> = new Map();
    const completed: Map<string, StepStatus> = new Map();
    const errors: Map<string, string> = new Map();

    // Start first step of each task
    for (const task of tasks) {
        taskMap.set(task.id, task);
        await runStep(conn, steps, task, 0, task.state);
    }

    // Listen to events from remote.
    // Run further steps and mark tasks as completed as needed.
    for await (const event of conn.listen()) {
        switch (event.type) {
            case 'done':
                {
                    switch (event.status) {
                        case 'error':
                            errors.set(event.id, event.result as string);
                            completed.set(event.id, event.status);
                            break;
                        case 'skipped':
                            // Typically, tasks are skipped due to errored (transitive) dependencies
                            completed.set(event.id, event.status);
                            break;
                        case 'done': {
                            const next = (currentStep.get(event.id) ?? 0) + 1;
                            if (
                                next ===
                                steps[taskMap.get(event.id)!.type]?.length
                            ) {
                                completed.set(event.id, 'done');
                            } else {
                                const task = taskMap.get(event.id);
                                if (!task) {
                                    throw new Error(
                                        `unknown task id from remote: ${event.id}`,
                                    );
                                }
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
        }
        if (completed.size === tasks.length) {
            break;
        }
    }

    if (completed.size !== tasks.length) {
        throw new Error(
            `connection closed with ${tasks.length - completed.size} task(s) outstanding`,
        );
    }
    if (errors.size > 0) {
        throw new AggregateError(
            [...errors].map(([id, msg]) => new Error(`${id}: ${msg}`)),
            'one or more tasks failed',
        );
    }
}

async function runStep(
    conn: Connection,
    steps: Record<string, Step[]>,
    task: Task,
    stepIdx: number,
    state: unknown,
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
                result = await step.handler(state);
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
