import { log } from '../common/log';
import type { Event } from './runner';
import type { Task } from './task';

interface Node {
    task: Task;
    dependents: string[];

    doneDeps: number;
    status: 'created' | 'started' | 'done' | 'error' | 'skipped';
}

export interface ScheduledTask {
    task: Task;
    status: 'ready' | 'skipped';
}

export function newTaskScheduler(
    tasks: Task[],
): [() => AsyncGenerator<ScheduledTask>, (event: Event) => void] {
    // Create nodes from tasks for later usage
    const nodes: Map<string, Node> = new Map();
    for (const task of tasks) {
        nodes.set(task.id, {
            task,
            dependents: [],
            doneDeps: 0,
            status: 'created',
        });
    }
    // Fill dependency back-edges
    for (const task of tasks) {
        for (const id of task.after ?? []) {
            nodes.get(id)?.dependents.push(task.id);
        }
    }

    // Track task count so we know when to return
    let pending = tasks.length;

    const schedulerQueue: ScheduledTask[] = [];
    const queueTask = (node: Node) => {
        if (
            node.status !== 'done' &&
            node.task.after?.length === node.doneDeps
        ) {
            schedulerQueue.push({
                task: node.task,
                status: 'ready',
            });
        } // else: completed or not yet ready; either way, don't queue it
        log.debug(
            'cannot queue task yet due to dependencies',
            'needed',
            node.task.after.length,
            'done',
            node.doneDeps,
        );
    };

    const skipTask = (node: Node) => {
        if (node.status === 'skipped') return; // idempotent
        node.status = 'skipped';
        schedulerQueue.push({
            task: node.task,
            status: 'skipped',
        });

        // Recursively skip
        for (const child of node.dependents) {
            skipTask(nodes.get(child)!);
        }
    };

    let wake!: () => void;
    let waker = new Promise<void>((r) => (wake = r));
    const handleCompleted = (event: Event) => {
        if (event.type !== 'completed') {
            return; // Not interested in other kinds of events
        }

        const node = nodes.get(event.taskId);
        if (!node) {
            throw new Error(`internal error: ${event.taskId} has no node!`);
        }
        node.status = event.status;
        pending--;
        log.debug('task completed', 'pending', pending, 'status', event.status);

        if (event.status === 'done') {
            // Try starting our dependents
            for (const dep of node.dependents) {
                const node = nodes.get(dep)!;
                node.doneDeps++;
                queueTask(node);
            }
        } else {
            // Cascade skip to dependents. skipTask is idempotent — a node
            // that's already been marked skipped (e.g. via a sibling's
            // cascade) is left alone.
            for (const dep of node.dependents) {
                skipTask(nodes.get(dep)!);
            }
        }

        wake();
        waker = new Promise<void>((r) => (wake = r));
    };

    async function* scheduleTasks(): AsyncGenerator<ScheduledTask> {
        // Schedule all tasks that don't have dependencies for immediate execution
        for (const task of tasks) {
            if (task.after?.length === 0) {
                queueTask(nodes.get(task.id)!);
            }
        }

        // Yield tasks as they become available
        while (pending > 0) {
            while (schedulerQueue.length) {
                yield schedulerQueue.shift()!;
            }
            if (pending > 0) {
                await waker;
            }
        }
    }

    return [scheduleTasks, handleCompleted];
}
