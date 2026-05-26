import { type ParseArgsConfig, parseArgs } from 'node:util';
import type { Host } from '../..';
import type { TagSet } from '../../common/task';
import { COMMAND_HELP, ROOT_HELP } from './help';

type Options = NonNullable<ParseArgsConfig['options']>;

export type Command = 'plan' | 'apply' | 'destroy' | 'tasks' | 'install-agent';

const COMMANDS: readonly Command[] = [
    'plan',
    'apply',
    'destroy',
    'tasks',
    'install-agent',
];

export interface ParsedCli {
    command: Command;
    flags: {
        yes: boolean;
        json: boolean;
        color: boolean;
        quiet: boolean;
        reapply: boolean;
        /** 0 debug | 1 info | 2 error | 3 silent */
        logLevel: number;
        stackOverride?: string;
    };
    /** OR-ed across multiple --target flags. */
    targets: TagSet[];
    /** Remaining positionals after subcommand stripping. */
    raw: string[];
}

export class CliExitError extends Error {
    constructor(
        readonly exitCode: number,
        message: string,
    ) {
        super(message);
    }
}

interface PrePass {
    args: string[];
    verbose: number;
    quiet: boolean;
}

/**
 * Pre-pass: extract counted -v / -vv / --verbose / -q / --quiet from args
 * before handing off to parseArgs (which doesn't natively count). The token
 * "-vv" is also accepted as shorthand for two -v flags.
 */
function prePass(input: string[]): PrePass {
    const out: string[] = [];
    let verbose = 0;
    let quiet = false;
    for (const token of input) {
        if (token === '-v' || token === '--verbose') {
            verbose++;
        } else if (token === '-vv') {
            verbose += 2;
        } else if (token === '-q' || token === '--quiet') {
            quiet = true;
        } else {
            out.push(token);
        }
    }
    return { args: out, verbose, quiet };
}

function logLevelFrom(verbose: number, quiet: boolean): number {
    if (quiet) return 3;
    if (verbose >= 2) return 0;
    if (verbose === 1) return 1;
    return 2;
}

function parseTargetSpec(spec: string): TagSet {
    const set: TagSet = {};
    for (const pair of spec.split(',')) {
        const eq = pair.indexOf('=');
        if (eq === -1) {
            throw new CliExitError(
                2,
                `invalid --target value (expected key=value): ${pair}`,
            );
        }
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (!k) {
            throw new CliExitError(2, `invalid --target value: ${pair}`);
        }
        set[k] = v;
    }
    return set;
}

function isCommand(s: string | undefined): s is Command {
    return s !== undefined && (COMMANDS as readonly string[]).includes(s);
}

/**
 * Parse the CLI from raw argv (e.g. `Bun.argv.slice(2)`).
 *
 * Throws CliExitError on user-facing errors so the caller can decide how to
 * report (pretty stderr vs JSON).
 */
export function parseCli(input: string[]): ParsedCli {
    // Step 1: pull out verbose/quiet flags
    const pre = prePass(input);
    let args = pre.args;

    // Step 2: identify subcommand
    if (args.length === 0 || args[0]?.startsWith('-')) {
        // No subcommand. If they asked for help, print root help; otherwise
        // print usage and exit non-zero.
        if (args.includes('-h') || args.includes('--help')) {
            process.stdout.write(ROOT_HELP);
            throw new CliExitError(0, '');
        }
        throw new CliExitError(2, `no command given\n${ROOT_HELP}`);
    }
    const first = args[0];
    if (!isCommand(first)) {
        throw new CliExitError(2, `unknown command: ${first}\n${ROOT_HELP}`);
    }
    const command: Command = first;
    args = args.slice(1);

    // Step 3: short-circuit help before any further validation
    if (args.includes('-h') || args.includes('--help')) {
        process.stdout.write(COMMAND_HELP[command] ?? ROOT_HELP);
        throw new CliExitError(0, '');
    }

    // Step 4: build the option set for the subcommand
    const wantsTarget =
        command === 'plan' ||
        command === 'apply' ||
        command === 'destroy' ||
        command === 'tasks' ||
        command === 'install-agent';
    const wantsStack =
        command === 'plan' || command === 'apply' || command === 'destroy';
    const wantsYes = command === 'apply' || command === 'destroy';
    const wantsHost = command === 'tasks';
    const wantsReapply = command === 'plan' || command === 'apply';

    const options: Options = {
        json: { type: 'boolean' },
        'no-color': { type: 'boolean' },
    };
    if (wantsTarget) options.target = { type: 'string', multiple: true };
    if (wantsStack) options.stack = { type: 'string' };
    if (wantsYes) options.yes = { type: 'boolean', short: 'y' };
    if (wantsHost) options.host = { type: 'string' };
    if (wantsReapply) options.reapply = { type: 'boolean' };

    let parsed: ReturnType<typeof parseArgs>;
    try {
        parsed = parseArgs({
            args,
            options,
            strict: true,
            allowPositionals: true,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new CliExitError(2, `${msg}\nRun with --help for usage.`);
    }

    const values = parsed.values as Record<string, unknown>;

    // Step 5: targets
    const targets: TagSet[] = [];
    const rawTargets = (values.target as string[] | undefined) ?? [];
    for (const t of rawTargets) {
        targets.push(parseTargetSpec(t));
    }
    if (wantsHost && typeof values.host === 'string') {
        targets.push({ host: values.host });
    }

    // Step 6: color resolution. Bun.enableANSIColors already accounts for
    // TTY status and the NO_COLOR / FORCE_COLOR env vars; we only need to
    // override it when the user explicitly opts out or asks for JSON output.
    const noColor = values['no-color'] === true;
    const json = values.json === true;
    const color = !noColor && !json && Bun.enableANSIColors;

    return {
        command,
        flags: {
            yes: values.yes === true,
            json,
            color,
            quiet: pre.quiet,
            reapply: values.reapply === true,
            logLevel: logLevelFrom(pre.verbose, pre.quiet),
            stackOverride:
                typeof values.stack === 'string' ? values.stack : undefined,
        },
        targets,
        raw: parsed.positionals,
    };
}

/**
 * Match a host against a TagSet using the same glob rules as filterTasks.
 * All key=value pairs in `target` must match for the host to qualify.
 */
function hostMatches(host: Host, target: TagSet): boolean {
    const tags: TagSet = { ...host.tags, host: host.id };
    for (const [k, v] of Object.entries(target)) {
        const actual = tags[k];
        if (actual === undefined) return false;
        if (!new Bun.Glob(v).match(actual)) return false;
    }
    return true;
}

/**
 * Filter hosts by --target flags. Empty targets returns all hosts. Multiple
 * --target flags combine with OR.
 */
export function filterHosts(hosts: Host[], targets: TagSet[]): Host[] {
    if (targets.length === 0) return hosts;
    return hosts.filter((host) => targets.some((t) => hostMatches(host, t)));
}
