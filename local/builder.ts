import type { Host } from '@bensku/tunkki';
import { log } from '../common/log';
import type { TaskOptions } from '../task';
import { findRefs, replaceRefs } from './outputs';
import type { Task } from './task';
import { validateTasks } from './validate';

/**
 * Adds tasks for a host and returns their ids.
 */
export type TaskSource = (host: Host) => Promise<string[]>;

/**
 * Task sources. Filled BEFORE deploy() has been called!
 */
const taskSources: { load: TaskSource; rolling: boolean }[] = [];

export function addSource(load: TaskSource, rolling: boolean) {
    taskSources.push({ load, rolling });
}

/**
 * Tasks of all hosts. Filled by loadTasks().
 */
export const tasks: Task[] = [];

/**
 * Rolling blocks. Each block lists ids of its tasks per host, in host order.
 * Hosts without tasks in the block are left out. Filled by loadTasks().
 */
export const rollingBlocks: string[][][] = [];

const idStack: string[] = [];
let currentHost: string | null = null;

/**
 * Reset all builder state — both sources and loaded tasks. Used by tests
 * that need a clean slate between runs.
 */
export function clearAll() {
    taskSources.length = 0;
    tasks.length = 0;
    rollingBlocks.length = 0;
    idStack.length = 0;
    currentHost = null;
}

export function addTask(
    id: string,
    type: string,
    state: unknown,
    opts: TaskOptions,
): Task {
    if (!currentHost) {
        throw new Error('cannot add tasks outside on(...) block');
    }
    const task: Task = {
        id,
        host: currentHost,
        type,
        state,
        deps: [...(opts.dependencies ?? [])],
        requireReapply: opts.requireReapply ?? false,
    };
    tasks.push(task);
    return task;
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
    tasks.length = 0;
    rollingBlocks.length = 0;
    log.info(
        'loading task sources',
        'sources',
        taskSources.length,
        'hosts',
        hosts.length,
    );
    // Sources are run sequentially because enterHost/exitHost mutate global state
    // Two sources racing on the same host would collide!
    for (const [sourceIndex, src] of taskSources.entries()) {
        const source = `${sourceIndex + 1}/${taskSources.length}`;
        const block: string[][] = [];
        for (const host of hosts) {
            log.info('loading task source', source, 'host', host.id);
            const ids = await src.load(host);
            log.debug('loaded task source', source, 'host', host.id, ids);
            if (ids.length > 0) {
                block.push(ids);
            }
        }
        if (src.rolling && block.length > 1) {
            rollingBlocks.push(block);
        }
    }

    // Output proxies may have been placed in state after tasks were added,
    // so they can only be replaced now
    for (const task of tasks) {
        task.state = replaceRefs(task.state);
        const refs = findRefs(task.state).map((ref) => ref.id);
        task.deps = [...new Set([...task.deps, ...refs])];
    }

    log.info('validating tasks', 'count', tasks.length);
    validateTasks(tasks);
    log.info('validated tasks successfully');
}
