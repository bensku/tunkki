import { connect, type Host, type Plan } from '../../..';
import { writePlan } from '../../plan';
import {
    connectionProgress,
    err,
    noopIds,
    printJson,
    printPlan,
    visibleChanges,
} from '../output';
import type { ParsedCli } from '../parse';

export interface CliContext {
    stack: string;
    hosts: Host[];
    cli: ParsedCli;
}

/**
 * Ids of tasks that are not shown at the current log level.
 */
export function hiddenIds(plan: Plan, flags: ParsedCli['flags']): Set<string> {
    return flags.logLevel <= 1 ? new Set() : noopIds(plan);
}

export async function run(ctx: CliContext): Promise<number> {
    if (ctx.hosts.length === 0) {
        err('no hosts match --target');
        return 2;
    }

    const flags = ctx.cli.flags;
    const pool = await connect(ctx.hosts, (event) =>
        connectionProgress(event, flags),
    );
    try {
        const plan = await pool.plan(
            ctx.stack,
            flags.reapply ? 'reapply' : 'apply',
        );
        if (flags.planFile) {
            await writePlan(flags.planFile, plan);
        }
        const hidden = hiddenIds(plan, flags);
        if (flags.json) {
            printJson({ plans: visibleChanges(plan, hidden) });
        } else {
            printPlan(
                plan,
                {
                    color: flags.color,
                    json: false,
                    quiet: flags.quiet,
                    showUnchanged: flags.logLevel <= 1,
                },
                hidden,
            );
        }
        return 0;
    } finally {
        await pool.close();
    }
}
