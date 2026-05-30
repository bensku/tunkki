import type { Task } from './task';

export function validateTasks(tasks: Task[]) {
    const taskIds = new Set(tasks.map((task) => task.id));
    for (const task of tasks) {
        for (const dep of task.after) {
            if (dep === task.id) {
                throw new Error(
                    `task ${task.id} tried to reference itself in after`,
                );
            } else if (!taskIds.has(dep)) {
                throw new Error(
                    `task ${task.id} tried to reference nonexistent task ${dep} in after`,
                );
            }
        }
        for (const dep of task.onChanged ?? []) {
            if (dep === task.id) {
                throw new Error(
                    `task ${task.id} tried to reference itself in onChanged`,
                );
            } else if (!taskIds.has(dep)) {
                throw new Error(
                    `task ${task.id} tried to reference nonexistent task ${dep} in onChanged`,
                );
            }
        }
    }
}
