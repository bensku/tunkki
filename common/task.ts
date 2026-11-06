import type { Step } from '@bensku/tunkki/task';

export type TagSet = Record<string, string>;

export interface TaskHandler {
    apply: Step | Step[];
    cleanup?: (state: unknown) => Promise<unknown>;
}

export function stepsOf(handler: TaskHandler): Step[] {
    return Array.isArray(handler.apply) ? handler.apply : [handler.apply];
}
