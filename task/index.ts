import type { Host } from '@bensku/tunkki';
import * as builder from '../local/builder';
import { outputRef } from '../local/outputs';
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
     * Ids of tasks that must be applied before this task. Tasks whose output
     * this task uses as input are handled automatically and need not to be
     * added here.
     */
    dependencies?: string[];

    /**
     * If set, this task is reapplied whenever one of its deps was applied,
     * even if its own input did not change. Useful for e.g. restarting
     * services after their binaries have been updated.
     */
    requireReapply?: boolean;
}

export type TaskType<S, O extends Output> = (
    id: string,
    state: S,
    opts?: TaskOptions,
) => O;

/**
 * Defines a task type.
 * @param name Unique name of the task type.
 * @param handler Path of the module that implements it.
 * @param outputSource Adds extra fields to what the task type returns.
 * @returns The task type. Tasks it creates have `outputs`, which can be used
 * in inputs of other tasks to refer to the value the last step returns (R).
 */
export function taskType<S, O, R = unknown>(
    name: string,
    handler: string,
    outputSource?: (id: string, state: S, opts: { dependencies: string[] }) => O,
): TaskType<S, O & { id: string; outputs: R }> {
    registerHandler(name, handler.replace('file://', ''));
    return (id, state, opts) => {
        const qualifiedId = builder.qualifyId(id);
        const task = builder.addTask(qualifiedId, name, state, opts ?? {});
        return {
            id: qualifiedId,
            outputs: outputRef(qualifiedId) as R,
            ...outputSource?.(qualifiedId, state, { dependencies: task.deps }),
        } as O & { id: string; outputs: R };
    };
}

export function combine<S, O>(
    // biome-ignore lint/suspicious/noConfusingVoidType: we need to allow handler to omit return statement
    handler: (state: S, opts: TaskOptions) => O | void,
): TaskType<S, O & { id: string }> {
    return (id, state, opts) => {
        const startIdx = builder.tasks.length;
        builder.pushId(id);
        const output = handler(state, opts ?? {});

        // Tasks that depend on the combined task depend on all tasks in it
        const end = builder.addTask(
            builder.qualifyId(`${id}-end`),
            '$noop',
            {},
            {
                dependencies: builder.tasks.slice(startIdx).map((task) => task.id),
                requireReapply: true,
            },
        );
        builder.popId();
        return {
            id: end.id,
            ...(output ?? {}),
        } as O & { id: string };
    };
}
