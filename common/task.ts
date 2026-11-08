import type { Step } from '@bensku/tunkki/task';

export type TagSet = Record<string, string>;

/**
 * Modules of tunkki that the agent provides to handlers, so they are left out
 * of handler bundles. Handlers then share them with the agent, e.g. its
 * configured logger.
 */
export const SHARED_MODULES = ['@bensku/tunkki/task'];

export interface TaskHandler {
    apply: Step | Step[];
    cleanup?: (state: unknown, output?: unknown) => Promise<unknown>;
}

export function stepsOf(handler: TaskHandler): Step[] {
    return Array.isArray(handler.apply) ? handler.apply : [handler.apply];
}
