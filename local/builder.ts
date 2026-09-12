import type { Host } from '@bensku/tunkki';
import { log } from '../common/log';
import type { TaskOptions } from '../task';
import type { Task, TaskSource } from './task';
import { validateTasks } from './validate';

/**
 * Task sources. Filled BEFORE deploy() has been called!
 */
const taskSources: TaskSource[] = [];

export function addSource(src: TaskSource) {
    taskSources.push(src);
}

/**
 * Tasks by their host. Filled DURING deploy()!
 */
export const tasks: Task[] = [];
const idStack: string[] = [];
let currentHost: string | null = null;

/**
 * Reset all builder state — both sources and loaded tasks. Used by tests
 * that need a clean slate between runs.
 */
export function clearAll() {
    taskSources.length = 0;
    tasks.length = 0;
    idStack.length = 0;
    currentHost = null;
}

export function addTask(
    id: string,
    task: string,
    state: unknown,
    opts: TaskOptions,
) {
    if (!currentHost) {
        throw new Error('cannot add tasks outside on(...) block');
    }
    const after = opts.after ? [...opts.after] : [];
    const onChanged = opts.onChanged ? [...opts.onChanged] : [];
    if (opts.dependsOn) {
        after.push(...opts.dependsOn);
        onChanged.push(...opts.dependsOn);
    }
    const t = {
        id,
        host: currentHost,
        state,
        type: task,
        after,
        onChanged,
        localData: {} as { host: Host },
    };
    tasks.push(t);
    return t;
}

export function enterHost(hostId: string): number {
    if (currentHost !== null) {
        throw new Error('internal error: enterHost() called before exitHost()');
    }
    currentHost = hostId;
    return tasks.length;
}

export function exitHost() {
    if (currentHost === null) {
        throw new Error('internal error: exitHost() called twice');
    }
    currentHost = null;
}

export function pushId(id: string) {
    idStack.push(id);
}

export function popId() {
    idStack.pop();
}

export function qualifyId(id: string) {
    const path = [currentHost, ...idStack, id];
    return path.join('.');
}

export async function loadTasks(hosts: Host[]) {
    log.info(
        'loading task sources',
        'sources',
        taskSources.length,
        'hosts',
        hosts.length,
    );
    // Sources are run sequentially because enterHost/exitHost mutate global
    // state — two sources racing on the same host would collide.
    for (const [sourceIndex, src] of taskSources.entries()) {
        const source = `${sourceIndex + 1}/${taskSources.length}`;
        log.info('loading task source', source);
        let prev: Task | undefined;
        for (const host of hosts) {
            const taskCount = tasks.length;
            log.info('loading task source', source, 'host', host.id);
            prev = await src(host, prev);
            log.debug(
                'loaded task source',
                source,
                'host',
                host.id,
                'tasksAdded',
                tasks.length - taskCount,
            );
        }
        log.info('loaded task source', source);
    }
    log.info('validating tasks', 'count', tasks.length);
    validateTasks(tasks);
    log.info('validated tasks successfully');
}
