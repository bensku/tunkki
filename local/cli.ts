import { parseArgs } from 'node:util';
import type { DeployOptions } from '..';

export function getCliOptions(args: string[]): DeployOptions {
    const { values, positionals } = parseArgs({
        args,
        options: {
            debug: {
                type: 'boolean',
            },
        },
        strict: true,
        allowPositionals: true,
    });
    const mode = positionals[2];
    if (
        mode !== undefined &&
        mode !== 'printTasks' &&
        mode !== 'installAgent' &&
        mode !== 'plan' &&
        mode !== 'apply'
    ) {
        throw new Error('unsupported mode');
    }

    return {
        mode: mode,
        debug: values.debug,
    };
}
