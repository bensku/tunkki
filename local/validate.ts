import type { Task } from './task';

export function validateTasks(tasks: Task[]) {
    const taskIds = new Set<string>();
    for (const task of tasks) {
        if (taskIds.has(task.id)) {
            throw new Error(`task id ${task.id} is used more than once`);
        }
        taskIds.add(task.id);
    }
    for (const task of tasks) {
        for (const dep of task.deps) {
            if (dep === task.id) {
                throw new Error(
                    `task ${task.id} depends on itself or its own outputs`,
                );
            } else if (!taskIds.has(dep)) {
                throw new Error(
                    `task ${task.id} depends on nonexistent task ${dep}`,
                );
            }
        }
    }
}
