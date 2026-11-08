import { SHARED_MODULES } from '../common/task';
import * as task from '../task';

const modules: Record<string, Record<string, unknown>> = {
    '@bensku/tunkki/task': task,
};

/**
 * Lets handler bundles import modules of the agent itself. They are bundled
 * with these modules marked as external, and would not find them otherwise.
 */
export function provideSharedModules() {
    Bun.plugin({
        name: 'tunkki-shared-modules',
        setup(build) {
            for (const specifier of SHARED_MODULES) {
                const exports = modules[specifier];
                if (!exports) {
                    throw new Error(`agent does not provide ${specifier}`);
                }
                build.module(specifier, () => ({ exports, loader: 'object' }));
            }
        },
    });
}
