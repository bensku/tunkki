import type { Host } from '@bensku/tunkki';
import * as builder from '../local/builder';
import { registerHandler } from '../local/task';

export interface Step {
    location: 'remote' | 'local';
    handler: (
        state: unknown,
        localData?: LocalData,
        oldState?: unknown,
    ) => Promise<unknown>;
}

interface LocalData {
    host: Host;
    [key: string]: unknown;
}

export function step<T, O = unknown, L = unknown>(
    location: Step['location'],
    handler: (state: T, localData: LocalData & L, oldState?: T) => Promise<O>,
): Step {
    return {
        location,
        handler: handler as Step['handler'],
    };
}

export interface Output {
    id: string;
}
export interface TaskOptions {
    /**
     * Ids of tasks that must be applied before this task.
     * Optional, by default tasks run in effectively random order.
     */
    after?: string[];

    /**
     * If any of the tasks listed here are changed, this task will also be
     * considered changed. Optional, can be useful for e.g. reloading services
     * after uploading updated binaries.
     */
    onChanged?: string[];
}
export type TaskType<S, O extends Output> = (
    id: string,
    state: S,
    opts?: TaskOptions,
) => O;

export function taskType<S, O>(
    name: string,
    handler: string,
    outputSource?: (id: string, state: S) => O,
): TaskType<S, O & { id: string }> {
    registerHandler(name, handler.replace('file://', '')); // Needed by loadHandlerCode and loadSteps etc.
    return (id, state, opts) => {
        const qualifiedId = builder.qualifyId(id);
        builder.addTask(qualifiedId, name, state, opts ?? {});
        return {
            id: qualifiedId,
            ...(outputSource ? outputSource(id, state) : {}),
        } as O & { id: string };
    };
}

export function combine<S, O>(
    // biome-ignore lint/suspicious/noConfusingVoidType: we need to allow handler to omit return statement
    handler: (state: S, opts: TaskOptions) => O | void,
): TaskType<S, O & { id: string }> {
    return (id, state, opts) => {
        builder.pushId(id);
        const output = handler(state, opts ?? {});
        builder.popId();
        return {
            id: builder.tasks.at(-1)?.id,
            ...(output ?? {}),
        } as O & { id: string };
    };
}
