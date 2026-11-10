import type { Host } from '@bensku/tunkki';
import * as builder from '../local/builder';
import { withOutputRef } from '../local/outputs';
import { registerHandler } from '../local/task';

export { log } from '../common/log';

export interface Step {
    location: 'remote' | 'local';
    handler: (
        state: unknown,
        localData?: LocalData,
        oldState?: unknown,
        oldOutput?: unknown,
    ) => Promise<unknown>;
}

interface LocalData {
    host: Host;
    [key: string]: unknown;
}

/**
 * Defines a step of a task type.
 * @param location Where the step runs.
 * @param handler Runs the step. Gets the output of the previous step (or
 * input of the task, for the first step). Only the first step gets the task's
 * old input as oldState. All steps get the old output of the task (what its
 * last step returned when it was last applied) as oldOutput. Both are
 * undefined when the task is created or replaced.
 * @template T Input of the step.
 * @template O Output of the step.
 * @template L Extra local data.
 * @template P Output of the task, i.e. of its last step.
 */
export function step<T, O = unknown, L = unknown, P = unknown>(
    location: Step['location'],
    handler: (
        state: T,
        localData: LocalData & L,
        oldState?: T,
        oldOutput?: P,
    ) => Promise<O>,
): Step {
    return {
        location,
        handler: handler as Step['handler'],
    };
}

export interface TaskOutput {
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

export type TaskType<S, O extends TaskOutput> = (
    id: string,
    state: S,
    opts?: TaskOptions,
) => O;

/**
 * Defines a task type.
 * @param name Unique name of the task type.
 * @param handler Path of the module that implements it.
 * @param outputSource Adds extra fields to what the task type returns.
 * @returns The task type. What it returns also has fields of the value the
 * last step of the task returns (R). These can be used in inputs of other
 * tasks to refer to the value. The id and fields from outputSource take
 * precedence over fields of R with same names.
 */
/**
 * What a task type returns: its own fields merged with fields of its output.
 */
export type WithOutputs<O, R> = TaskOutput & O & Omit<R, keyof O | 'id'>;

export function taskType<S, O, R = unknown>(
    name: string,
    handler: string,
    outputSource?: (
        id: string,
        state: S,
        opts: { dependencies: string[] },
    ) => O,
): TaskType<S, WithOutputs<O, R>> {
    registerHandler(name, handler.replace('file://', ''));
    return (id, state, opts) => {
        const qualifiedId = builder.qualifyId(id);
        const task = builder.addTask(qualifiedId, name, state, opts ?? {});
        return withOutputRef(qualifiedId, {
            id: qualifiedId,
            ...outputSource?.(qualifiedId, state, { dependencies: task.deps }),
        }) as WithOutputs<O, R>;
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
                dependencies: builder.tasks
                    .slice(startIdx)
                    .map((task) => task.id),
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

/**
 * Checks if the given value is known plan-time. This may be useful when
 * writing validation logic for your task's inputs.
 * @param value Value to check.
 * @returns True if value is known plan-time, false if it is an output from
 * another task.
 */
export function isKnown(value: unknown): boolean {
    if (typeof value === 'string') {
        return !value.includes('$tunkki{');
    }
    return typeof value === 'number' || typeof value === 'boolean';
}
