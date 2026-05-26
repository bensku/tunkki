import { runDistrustCa } from './commands/distrust-ca';
import { runInit } from './commands/init';
import { runLighthouseAdd, runLighthouseRemove } from './commands/lighthouse';
import { runNewCa } from './commands/new-ca';
import { CliExitError, type ParsedCli, parseCli } from './parse';

export type { ParsedCli } from './parse';

export interface NebulaCliContext {
    cli: ParsedCli;
}

export async function runNebulaCli(): Promise<never> {
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

    const ctx: NebulaCliContext = { cli };

    try {
        const code = await dispatch(ctx);
        process.exit(code);
    } catch (e) {
        if (e instanceof CliExitError) {
            if (e.message) process.stderr.write(`${e.message}\n`);
            process.exit(e.exitCode);
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (cli.flags.json) {
            process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
        } else {
            process.stderr.write(`error: ${msg}\n`);
        }
        process.exit(1);
    }
}

async function dispatch(ctx: NebulaCliContext): Promise<number> {
    const c = ctx.cli.command;
    switch (c.kind) {
        case 'init':
            return runInit(c, ctx.cli.flags);
        case 'new-ca':
            return runNewCa(c, ctx.cli.flags);
        case 'distrust-ca':
            return runDistrustCa(c, ctx.cli.flags);
        case 'lighthouse-add':
            return runLighthouseAdd(c, ctx.cli.flags);
        case 'lighthouse-remove':
            return runLighthouseRemove(c, ctx.cli.flags);
    }
}
