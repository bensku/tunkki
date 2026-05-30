import type { Host } from '../..';
import { type Message, setupLogger } from '../../common/log';
import { makeColor } from './colors';
import * as applyCmd from './commands/apply';
import * as destroyCmd from './commands/destroy';
import * as installAgentCmd from './commands/install-agent';
import * as planCmd from './commands/plan';
import * as tasksCmd from './commands/tasks';
import { err, printJsonError } from './output';
import { CliExitError, filterHosts, type ParsedCli, parseCli } from './parse';

export type { ParsedCli } from './parse';

export interface CliContext {
    stack: string;
    hosts: Host[];
    cli: ParsedCli;
}

const COMMAND_RUNNERS: Record<
    ParsedCli['command'],
    (ctx: CliContext) => Promise<number>
> = {
    plan: planCmd.run,
    apply: applyCmd.run,
    destroy: destroyCmd.run,
    tasks: tasksCmd.run,
    'install-agent': installAgentCmd.run,
};

function levelLabel(level: 0 | 1 | 2): string {
    return level === 0 ? 'debug' : level === 1 ? 'info' : 'error';
}

function setupCliLogger(flags: ParsedCli['flags']): void {
    const c = makeColor(flags.color);
    setupLogger((event: Message) => {
        const tag = c.dim(`[${levelLabel(event.level)}]`);
        const parts = event.msg
            .map((p) =>
                typeof p === 'string'
                    ? p
                    : Bun.inspect(p, { colors: false, depth: 4 }),
            )
            .join(' ');
        process.stderr.write(`${tag} ${parts}\n`);
    }, flags.logLevel);
}

/**
 * Run the CLI for the user's deploy script.
 *
 * Reads `Bun.argv`, dispatches to the requested subcommand, and exits with the
 * command's exit code. The user's `deploy(stack, hosts)` keeps the same shape
 * — this function is what it dispatches to.
 */
export async function runCli(stack: string, hosts: Host[]): Promise<never> {
    let cli: ParsedCli;
    try {
        cli = parseCli(Bun.argv.slice(2));
    } catch (e) {
        if (e instanceof CliExitError) {
            if (e.message) process.stderr.write(`${e.message}\n`);
            process.exit(e.exitCode);
        }
        throw e;
    }

    setupCliLogger(cli.flags);

    const filteredHosts = filterHosts(hosts, cli.targets);
    const ctx: CliContext = {
        stack: cli.flags.stackOverride ?? stack,
        hosts: filteredHosts,
        cli,
    };

    try {
        const code = await COMMAND_RUNNERS[cli.command](ctx);
        process.exit(code);
    } catch (e) {
        const msg = Bun.inspect(e);
        if (cli.flags.json) {
            printJsonError(msg);
        } else {
            const c = makeColor(cli.flags.color);
            err(c.red('error:'), msg);
        }
        process.exit(1);
    }
}
