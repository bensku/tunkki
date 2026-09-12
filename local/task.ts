import { type Step, step } from '@bensku/tunkki/task';
import type { Host } from '..';
import { log } from '../common/log';
import type { TaskHandler } from '../common/task';

export interface Task {
    /**
     * Globally unique id of this task.
     */
    id: string;

    /**
     * Id of host this task will be deployed to.
     */
    host: string;

    /**
     * Task state. Diffed by runner with deep equality; if there is no change,
     * we do not need to re-run the task.
     */
    state: unknown;

    /**
     * Task type. I.e. what handler need to invoke on runner.
     */
    type: string;

    /**
     * This task must be executed after these tasks.
     */
    after: string[];

    /**
     * This task must be executed these tasks were changed, even if its own
     * state did not change at all.
     */
    onChanged?: string[];

    /**
     * Data that is passed to all local steps.
     */
    localData: Record<string, unknown> & { host: Host };
}

export type TaskSource = (
    host: Host,
    prevEnd: Task | undefined,
) => Promise<Task | undefined>;

/**
 * Task type names to handler ids.
 */
const handlers: Map<string, string> = new Map();

export function registerHandler(name: string, handler: string) {
    handlers.set(name, handler);
}

/**
 * Loads handlers needed by the given tasks as text.
 * @param tasks Tasks that remote will need handlers for.
 * @returns Handlers, for uploadHandlers event.
 */
export async function loadHandlerCode(
    tasks: Task[],
): Promise<Record<string, string>> {
    const code: Record<string, string> = {};
    for (const task of tasks) {
        if (!code[task.type] && !task.type.startsWith('$')) {
            // Need to load new handler ($delete and $noop are special cases and have no handlers)
            const handler = handlers.get(task.type);
            if (!handler) {
                throw new Error(`missing task handler: ${task.type}`);
            }
            log.debug(
                'loading task handler code',
                'type',
                task.type,
                'file',
                `${handler}.ts`,
            );
            const file = await Bun.file(`${handler}.ts`).text();
            code[task.type] = file;
            log.debug(
                'loaded task handler code',
                'type',
                task.type,
                'bytes',
                file.length,
            );
        }
    }
    return code;
}

/**
 * Loads handlers needed by given tasks locally and extracts the steps from
 * them.
 * @param tasks Tasks that we'll be deploying.
 * @returns Steps that can be executed locally as needed.
 */
export async function loadSteps(
    tasks: Task[],
): Promise<Record<string, Step[]>> {
    const steps: Record<string, Step[]> = {
        // Special case: no-nothing task. $noop is as dependent and dependency in rolling deploys
        $noop: [step('remote', async () => undefined)],
    };
    for (const task of tasks) {
        if (!steps[task.type]) {
            // Load new module and get apply steps
            // Unless we're deleting the task, in which case do horrible hacks
            // A task to be deleted does not exist locally, so we have no idea
            // what handler it might've used. The remote knows this, so just
            // make enough of a handler to get the step sent there
            const handler: TaskHandler =
                task.type !== '$delete'
                    ? await import(handlers.get(task.type)!)
                    : { apply: [{ handler: '', location: 'remote' }] };
            steps[task.type] = Array.isArray(handler.apply)
                ? handler.apply
                : [handler.apply];
        }
    }
    return steps;
}
