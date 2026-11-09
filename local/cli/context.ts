import { connect, type Host, type Plan, type TargetPool } from '../..';
import { makeColor } from './colors';
import { noopIds } from './output';
import type { ParsedCli } from './parse';
import { makeReporter, type Reporter } from './reporter';
import { term } from './terminal';

export interface CliContext {
    stack: string;
    hosts: Host[];
    cli: ParsedCli;
}

type Flags = ParsedCli['flags'];

/**
 * Ids of tasks that are not shown at the current log level.
 */
export function hiddenIds(plan: Plan, flags: Flags): Set<string> {
    return flags.logLevel <= 1 ? new Set() : noopIds(plan);
}

export function reporterFor(flags: Flags): Reporter {
    return makeReporter({
        color: makeColor(flags.color),
        json: flags.json,
        quiet: flags.quiet,
        verbose: flags.logLevel <= 1,
        live: term.interactive,
    });
}

/**
 * Connects to hosts, showing progress.
 */
export function connectHosts(
    hosts: Host[],
    reporter: Reporter,
): Promise<TargetPool> {
    reporter.startConnect(hosts.map((host) => host.id));
    return connect(hosts, (event) => reporter.connection(event), {
        // When the user might need to authenticate, e.g. by touching their
        // security key, make it clear which host is asking
        concurrency: process.stdin.isTTY ? 1 : undefined,
    });
}
