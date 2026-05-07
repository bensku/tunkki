import type { TagSet } from '../common/task';
import type { Task } from './task';

export const tasks: Task[] = [];
const idStack: string[] = [];
const targetStack: TagSet[] = [];

export function addTask(
    id: string,
    task: string,
    state: unknown,
    dependsOn: string[] | undefined,
    rolling: boolean,
) {
    tasks.push({
        id: idStack.join('.') + id,
        applyOn: targetStack.at(-1) ?? { host: '*' },
        state,
        type: task,
        dependsOn,
        rolling,
    });
}

export function pushId(id: string) {
    idStack.push(id);
}

export function popId() {
    idStack.pop();
}

export function pushTargets(tags: TagSet) {
    targetStack.push(tags);
}

export function popTargets() {
    targetStack.pop();
}
