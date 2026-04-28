import type { Host } from '@bensku/tunkki';
import type { TagSet } from '../common/task';
import type { Task } from './task';

export const tasks: Task[] = [];
const idStack: string[] = [];
const targetStack: TagSet[] = [];
let sequentialCount = 0;

export const hosts: Host[] = [];

export function addTask(
    id: string,
    task: string,
    state: unknown,
    dependsOn?: string[],
) {
    if (sequentialCount !== 0) {
        const prev = tasks.at(-1);
        if (prev) {
            if (dependsOn === undefined) {
                dependsOn = [prev.id];
            } else {
                dependsOn.push(prev.id);
            }
        }
    }
    tasks.push({
        id: idStack.join('.') + id,
        applyOn: targetStack.at(-1) ?? { host: '*' },
        state,
        type: task,
        dependsOn,
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

export function beginSequential() {
    sequentialCount++;
}

export function endSequential() {
    sequentialCount--;
}
