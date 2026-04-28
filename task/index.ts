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
    dependsOn?: string[],
) => O;

export function taskType<S, O>(
    name: string,
    handler: string,
    outputSource?: (id: string, state: S) => O,
): TaskType<S, O & { id: string }> {
    registerHandler(name, handler.replace('file://', '')); // Needed by loadHandlerCode and loadSteps etc.
    return (id, state, dependsOn) => {
        builder.addTask(id, name, state, dependsOn);
        return {
            id,
            ...(outputSource ? outputSource(id, state) : {}),
        } as O & { id: string };
    };
}
