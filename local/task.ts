import type { Step } from '@bensku/tunkki/task';
import type { TagSet, TaskHandler } from '../common/task';

export interface Task {
    /**
     * Globally unique id of this task.
     */
    id: string;

    /**
     * If one of these tag,value pairs is found, run this task.
     */
    applyOn: TagSet;

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
     * If this task cannot begin execution before other tasks have finished,
     * ids of those other tasks.
     */
    dependsOn?: string[];
}

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
        if (!code[task.type]) {
            // Need to load new handler
            const file = await Bun.file(`${handlers.get(task.type)}.ts`).text();
            code[task.type] = file;
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
    const steps: Record<string, Step[]> = {};
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

/**
 * Filters tasks that are not applicable to given tags out.
 * @param tasks List of all tasks.
 * @param tags Tags to filter with. For example, hosts's tags
 * @returns Filtered list of tasks.
 */
export function filterTasks(tasks: Task[], tags: TagSet) {
    return tasks.filter((task) => {
        for (const [tag, value] of Object.entries(task.applyOn)) {
            if (tags[tag] && new Bun.Glob(value).match(tags[tag])) {
                return true;
            }
        }
        return false;
    });
}
