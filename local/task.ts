import type { Step } from '@bensku/tunkki/task';
import { log } from '../common/log';
import { SHARED_MODULES, stepsOf, type TaskHandler } from '../common/task';

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
     * Task type, i.e. which handler applies it.
     */
    type: string;

    /**
     * Input of the task. May contain output tokens of other tasks.
     */
    state: unknown;

    /**
     * Tasks that must be applied before this one.
     */
    deps: string[];

    /**
     * Reapply this task when a dependency changed, even if this does not use
     * its outputs.
     */
    requireReapply: boolean;
}

/**
 * Task type names to paths of their handler modules.
 */
const handlers: Map<string, string> = new Map();

export function registerHandler(type: string, path: string) {
    handlers.set(type, path);
}

export function isRegistered(type: string): boolean {
    return type === '$noop' || handlers.has(type);
}

function handlerPath(type: string): string {
    const path = handlers.get(type);
    if (!path) {
        throw new Error(`no handler registered for task type ${type}`);
    }
    return path;
}

/**
 * Loads steps of a task type locally. $noop has none.
 */
export async function loadSteps(type: string): Promise<Step[]> {
    if (type === '$noop') {
        return [];
    }
    const handler: TaskHandler = await import(handlerPath(type));
    return stepsOf(handler);
}

const bundles: Map<string, Promise<string>> = new Map();

/**
 * Bundles a task type's handler module into a data URL that remotes can
 * import.
 */
export function bundleHandler(type: string): Promise<string> {
    let bundle = bundles.get(type);
    if (!bundle) {
        bundle = buildBundle(type);
        bundles.set(type, bundle);
    }
    return bundle;
}

/**
 * Leaves modules that the agent provides out of bundles (see
 * remote/shared.ts). Unlike Bun's `external`, this does not match their
 * subpaths, e.g. `@bensku/tunkki/task/util` is still bundled.
 */
const sharedModules: Bun.BunPlugin = {
    name: 'tunkki-shared-modules',
    setup(build) {
        build.onResolve({ filter: /^@bensku\/tunkki(\/.*)?$/ }, (args) =>
            SHARED_MODULES.includes(args.path)
                ? { path: args.path, external: true }
                : undefined,
        );
    },
};

async function buildBundle(type: string): Promise<string> {
    const result = await Bun.build({
        entrypoints: [handlerPath(type)],
        target: 'bun',
        format: 'esm',
        plugins: [sharedModules],
    });
    const output = result.outputs[0];
    if (!result.success || !output) {
        throw new AggregateError(
            result.logs,
            `failed to bundle handler for ${type}`,
        );
    }
    const code = await output.text();
    log.debug('bundled handler', 'type', type, 'bytes', code.length);
    return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
