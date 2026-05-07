import * as builder from '../local/builder';
import { registerHandler } from '../local/task';

export interface Step {
    location: 'remote' | 'local';
    handler: (state: unknown) => Promise<unknown>;
}

export function step<T>(
    location: Step['location'],
    handler: (state: T) => Promise<unknown>,
): Step {
    return {
        location,
        handler: handler as Step['handler'],
    };
}

export interface Output {
    id: string;
}
export type TaskType<S, O extends Output> = (
    id: string,
    state: S,
    opts?: {
        /**
         * Ids of tasks that must be applied before this task.
         * Optional, by default tasks run in effectively random order.
         */
        dependsOn?: string[];

        /**
         * If true, this task is executed host-by-host on hosts it applies to.
         * By default, tasks are executed in parallel on multiple hosts.
         */
        rolling?: boolean;
    },
) => O;

export function taskType<S, O>(
    name: string,
    handler: string,
    outputSource?: (id: string, state: S) => O,
): TaskType<S, O & { id: string }> {
    registerHandler(name, handler.replace('file://', '')); // Needed by loadHandlerCode and loadSteps etc.
    return (id, state, opts) => {
        builder.addTask(
            id,
            name,
            state,
            opts?.dependsOn,
            opts?.rolling ?? false,
        );
        return {
            id,
            ...(outputSource ? outputSource(id, state) : {}),
        } as O & { id: string };
    };
}
