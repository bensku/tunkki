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
): [
    () => AsyncGenerator<ScheduledTask>,
    (event: Event, initial: boolean) => void,
] {
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
        if (node.task.after?.length === node.doneDeps) {
            if (node.status !== 'done') {
                log.debug(
                    'task queued',
                    'task',
                    node.task.id,
                    'status',
                    node.status,
                );
                schedulerQueue.push({
                    task: node.task,
                    status: 'ready',
                });
            } // else: task already done
        } else if (node.status !== 'done') {
            log.debug(
                'pending dependencies',
                'task',
                node.task.id,
                'needed',
                node.task.after,
                'done',
                node.doneDeps,
            );
        }
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
    const handleCompleted = (event: Event, initial: boolean) => {
        if (event.type !== 'completed') {
            return; // Not interested in other kinds of events
        }

        const node = nodes.get(event.taskId);
        if (!node) {
            throw new Error(`internal error: ${event.taskId} has no node!`);
        }
        node.status = event.status;
        pending--;
        log.debug(
            'task completed',
            'task',
            event.taskId,
            'pending',
            pending,
            'status',
            event.status,
        );

        if (event.status === 'done') {
            // Try starting our dependents
            for (const dep of node.dependents) {
                const node = nodes.get(dep)!;
                node.doneDeps++;
                if (!initial) {
                    queueTask(node);
                } // else: we'll get this when looping over ALL tasks later
            }
        } else {
            // Cascade skip to dependents
            for (const dep of node.dependents) {
                skipTask(nodes.get(dep)!);
            }
        }
        if (!initial) {
            wake();
            waker = new Promise<void>((r) => (wake = r));
        }
    };

    async function* scheduleTasks(): AsyncGenerator<ScheduledTask> {
        // Try to schedule all tasks for execution. queueTask can handle dependency tracking
        for (const task of tasks) {
            queueTask(nodes.get(task.id)!);
        }
        log.debug(
            'initial scheduler pass complete',
            'pending',
            pending,
            'total',
            tasks.length,
        );

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
