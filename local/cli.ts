import { parseArgs } from 'node:util';

export interface DeployOptions {
    mode: 'printTasks' | 'installAgent' | 'plan' | 'apply';

    logLevel: number;
}

export function getCliOptions(args: string[]): DeployOptions {
    const { values, positionals } = parseArgs({
        args,
        options: {
            debug: {
                type: 'boolean',
            },
            logLevel: {
                type: 'string',
                default: 'info',
            },
        },
        strict: true,
        allowPositionals: true,
    });
    const mode = positionals[2] ?? 'plan';
    if (
        mode !== undefined &&
        mode !== 'printTasks' &&
        mode !== 'installAgent' &&
        mode !== 'plan' &&
        mode !== 'apply'
    ) {
        throw new Error('unsupported mode');
    }

    let logLevel: number;
    switch (values.logLevel) {
        case 'debug':
            logLevel = 0;
            break;
        case 'info':
            logLevel = 1;
            break;
        case 'error':
            logLevel = 2;
            break;
        case 'none':
            logLevel = 3;
            break;
        default:
            logLevel = 1;
            break;
    }

    return {
        mode: mode,
        logLevel,
    };
}
