import { type ParseArgsConfig, parseArgs } from 'node:util';
import { COMMAND_HELP, ROOT_HELP } from './help';

type Options = NonNullable<ParseArgsConfig['options']>;

export class CliExitError extends Error {
    constructor(
        readonly exitCode: number,
        message: string,
    ) {
        super(message);
    }
}

export type Command =
    | {
          kind: 'init';
          file: string;
          prefix?: string;
          dynamicArea?: string;
          caName?: string;
          caDuration?: string;
      }
    | {
          kind: 'new-ca';
          file: string;
          caName?: string;
          caDuration?: string;
      }
    | {
          kind: 'distrust-ca';
          file: string;
          selector?: string;
          selectorKind?: 'name' | 'cert';
          expired: boolean;
          all: boolean;
      }
    | {
          kind: 'lighthouse-add';
          file: string;
          underlayAddr: string;
          ip?: string;
      }
    | {
          kind: 'lighthouse-remove';
          file: string;
          selector: string;
          selectorKind?: 'ip' | 'underlay';
          all: boolean;
      }
    | {
          kind: 'static-ip';
          file: string;
          count?: number;
      };

export interface ParsedCli {
    command: Command;
    flags: {
        json: boolean;
        color: boolean;
    };
}

const TOP_COMMANDS = [
    'init',
    'new-ca',
    'distrust-ca',
    'lighthouse',
    'static-ip',
] as const;
type TopCommand = (typeof TOP_COMMANDS)[number];

function isTopCommand(s: string | undefined): s is TopCommand {
    return s !== undefined && (TOP_COMMANDS as readonly string[]).includes(s);
}

function requirePositional(
    args: string[],
    index: number,
    name: string,
    helpKey: string,
): string {
    const v = args[index];
    if (v === undefined) {
        throw new CliExitError(
            2,
            `missing required argument <${name}>\n${COMMAND_HELP[helpKey] ?? ROOT_HELP}`,
        );
    }
    return v;
}

function buildOptions(extra: Options): Options {
    return {
        json: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        ...extra,
    };
}

function parseSafely(
    args: string[],
    options: Options,
    helpKey: string,
): ReturnType<typeof parseArgs> {
    try {
        return parseArgs({
            args,
            options,
            strict: true,
            allowPositionals: true,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new CliExitError(
            2,
            `${msg}\n${COMMAND_HELP[helpKey] ?? ROOT_HELP}`,
        );
    }
}

function helpRequested(args: string[]): boolean {
    return args.includes('-h') || args.includes('--help');
}

export function parseCli(input: string[]): ParsedCli {
    if (input.length === 0 || input[0]?.startsWith('-')) {
        if (helpRequested(input)) {
            process.stdout.write(ROOT_HELP);
            throw new CliExitError(0, '');
        }
        throw new CliExitError(2, `no command given\n${ROOT_HELP}`);
    }

    const top = input[0];
    if (!isTopCommand(top)) {
        throw new CliExitError(2, `unknown command: ${top}\n${ROOT_HELP}`);
    }

    const rest = input.slice(1);

    if (top === 'lighthouse') {
        if (helpRequested(rest) && rest[0]?.startsWith('-')) {
            process.stdout.write(COMMAND_HELP.lighthouse ?? ROOT_HELP);
            throw new CliExitError(0, '');
        }
        if (rest.length === 0) {
            throw new CliExitError(
                2,
                `missing lighthouse subcommand (add|remove)\n${COMMAND_HELP.lighthouse}`,
            );
        }
        const sub = rest[0];
        const subRest = rest.slice(1);
        if (helpRequested(subRest)) {
            process.stdout.write(COMMAND_HELP.lighthouse ?? ROOT_HELP);
            throw new CliExitError(0, '');
        }
        if (sub === 'add') {
            return parseLighthouseAdd(subRest);
        }
        if (sub === 'remove') {
            return parseLighthouseRemove(subRest);
        }
        throw new CliExitError(
            2,
            `unknown lighthouse subcommand: ${sub}\n${COMMAND_HELP.lighthouse}`,
        );
    }

    if (helpRequested(rest)) {
        process.stdout.write(COMMAND_HELP[top] ?? ROOT_HELP);
        throw new CliExitError(0, '');
    }

    if (top === 'init') return parseInit(rest);
    if (top === 'new-ca') return parseNewCa(rest);
    if (top === 'distrust-ca') return parseDistrustCa(rest);
    if (top === 'static-ip') return parseStaticIp(rest);

    throw new CliExitError(2, `unhandled command: ${top}\n${ROOT_HELP}`);
}

function makeFlags(values: Record<string, unknown>): ParsedCli['flags'] {
    const noColor = values['no-color'] === true;
    const json = values.json === true;
    const color = !noColor && !json && Bun.enableANSIColors;
    return { json, color };
}

function parseInit(args: string[]): ParsedCli {
    const options = buildOptions({
        prefix: { type: 'string' },
        'dynamic-area': { type: 'string' },
        'ca-name': { type: 'string' },
        'ca-duration': { type: 'string' },
    });
    const parsed = parseSafely(args, options, 'init');
    const file = requirePositional(parsed.positionals, 0, 'file', 'init');
    const values = parsed.values as Record<string, unknown>;
    return {
        command: {
            kind: 'init',
            file,
            prefix: stringOrUndef(values.prefix),
            dynamicArea: stringOrUndef(values['dynamic-area']),
            caName: stringOrUndef(values['ca-name']),
            caDuration: stringOrUndef(values['ca-duration']),
        },
        flags: makeFlags(values),
    };
}

function parseNewCa(args: string[]): ParsedCli {
    const options = buildOptions({
        'ca-name': { type: 'string' },
        'ca-duration': { type: 'string' },
    });
    const parsed = parseSafely(args, options, 'new-ca');
    const file = requirePositional(parsed.positionals, 0, 'file', 'new-ca');
    const values = parsed.values as Record<string, unknown>;
    return {
        command: {
            kind: 'new-ca',
            file,
            caName: stringOrUndef(values['ca-name']),
            caDuration: stringOrUndef(values['ca-duration']),
        },
        flags: makeFlags(values),
    };
}

function parseDistrustCa(args: string[]): ParsedCli {
    const options = buildOptions({
        name: { type: 'string' },
        cert: { type: 'string' },
        expired: { type: 'boolean' },
        all: { type: 'boolean' },
    });
    const parsed = parseSafely(args, options, 'distrust-ca');
    const file = requirePositional(
        parsed.positionals,
        0,
        'file',
        'distrust-ca',
    );
    const values = parsed.values as Record<string, unknown>;

    let selector: string | undefined;
    let selectorKind: 'name' | 'cert' | undefined;
    if (typeof values.name === 'string') {
        selector = values.name;
        selectorKind = 'name';
    } else if (typeof values.cert === 'string') {
        selector = values.cert;
        selectorKind = 'cert';
    } else if (parsed.positionals[1] !== undefined) {
        selector = parsed.positionals[1];
    }

    const expired = values.expired === true;
    if (!expired && selector === undefined) {
        throw new CliExitError(
            2,
            `distrust-ca requires a selector or --expired\n${COMMAND_HELP['distrust-ca']}`,
        );
    }
    if (expired && selector !== undefined) {
        throw new CliExitError(
            2,
            `distrust-ca: --expired cannot be combined with a selector`,
        );
    }

    return {
        command: {
            kind: 'distrust-ca',
            file,
            selector,
            selectorKind,
            expired,
            all: values.all === true,
        },
        flags: makeFlags(values),
    };
}

function parseLighthouseAdd(args: string[]): ParsedCli {
    const options = buildOptions({
        ip: { type: 'string' },
    });
    const parsed = parseSafely(args, options, 'lighthouse');
    const file = requirePositional(parsed.positionals, 0, 'file', 'lighthouse');
    const underlayAddr = requirePositional(
        parsed.positionals,
        1,
        'underlayAddr',
        'lighthouse',
    );
    const values = parsed.values as Record<string, unknown>;
    return {
        command: {
            kind: 'lighthouse-add',
            file,
            underlayAddr,
            ip: stringOrUndef(values.ip),
        },
        flags: makeFlags(values),
    };
}

function parseLighthouseRemove(args: string[]): ParsedCli {
    const options = buildOptions({
        ip: { type: 'boolean' },
        underlay: { type: 'boolean' },
        all: { type: 'boolean' },
    });
    const parsed = parseSafely(args, options, 'lighthouse');
    const file = requirePositional(parsed.positionals, 0, 'file', 'lighthouse');
    const selector = requirePositional(
        parsed.positionals,
        1,
        'selector',
        'lighthouse',
    );
    const values = parsed.values as Record<string, unknown>;

    let selectorKind: 'ip' | 'underlay' | undefined;
    if (values.ip === true && values.underlay === true) {
        throw new CliExitError(
            2,
            `lighthouse remove: --ip and --underlay are mutually exclusive`,
        );
    }
    if (values.ip === true) selectorKind = 'ip';
    else if (values.underlay === true) selectorKind = 'underlay';

    return {
        command: {
            kind: 'lighthouse-remove',
            file,
            selector,
            selectorKind,
            all: values.all === true,
        },
        flags: makeFlags(values),
    };
}

function parseStaticIp(args: string[]): ParsedCli {
    const options = buildOptions({
        count: { type: 'string' },
    });
    const parsed = parseSafely(args, options, 'static-ip');
    const file = requirePositional(parsed.positionals, 0, 'file', 'static-ip');
    const values = parsed.values as Record<string, unknown>;

    let count: number | undefined;
    if (typeof values.count === 'string') {
        const n = Number(values.count);
        if (!Number.isInteger(n) || n < 1) {
            throw new CliExitError(
                2,
                `--count must be a positive integer\n${COMMAND_HELP['static-ip']}`,
            );
        }
        count = n;
    }

    return {
        command: { kind: 'static-ip', file, count },
        flags: makeFlags(values),
    };
}

function stringOrUndef(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}
