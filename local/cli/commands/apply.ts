import type { Event, Result } from '../../..';
import { connect } from '../../..';
import {
    err,
    liveProgress,
    printJson,
    printPlan,
    printSummary,
} from '../output';
import { buildTasksByHost, type CliContext } from './plan';

export async function run(ctx: CliContext): Promise<number> {
    if (ctx.hosts.length === 0) {
        err('no hosts match --target');
        return 2;
    }

    const flags = ctx.cli.flags;
    if (flags.json && !flags.yes) {
        err('--json requires --yes for apply (no interactive prompts allowed)');
        return 2;
    }

    const tasksByHost = buildTasksByHost(ctx.hosts);
    const pool = await connect(ctx.hosts);
    try {
        const plans = await pool.plan(ctx.stack);

        const totalChanges = plans.reduce(
            (n, p) =>
                n + p.created.length + p.updated.length + p.deleted.length,
            0,
        );

        if (!flags.json) {
            printPlan(plans, tasksByHost, {
                color: flags.color,
                json: false,
                quiet: flags.quiet,
                showUnchanged: flags.logLevel <= 1,
            });
        }

        if (totalChanges === 0) {
            if (!flags.json) {
                process.stdout.write('No changes.\n');
            } else {
                printJson({
                    plans: stripPlans(plans),
                    results: [],
                    events: [],
                });
            }
            return 0;
        }

        if (!flags.yes) {
            const ok = confirm('Apply these changes?');
            if (!ok) return 0;
        }

        const events: Event[] = [];
        const results: Result[] = await pool.execute(plans, (event) => {
            events.push(event);
            liveProgress(event, {
                color: flags.color,
                json: flags.json,
                quiet: flags.quiet,
                showUnchanged: false,
            });
        });

        if (flags.json) {
            printJson({
                plans: stripPlans(plans),
                results,
                events: events.map((e) => ({
                    host: e.host.id,
                    type: e.type,
                    taskId: e.taskId,
                    status: e.status,
                    error: e.error,
                })),
            });
        } else {
            printSummary(results, {
                color: flags.color,
                json: false,
                quiet: flags.quiet,
                showUnchanged: false,
            });
        }

        const anyErrored = results.some((r) => r.errored.length > 0);
        return anyErrored ? 1 : 0;
    } finally {
        await pool.close();
    }
}

function stripPlans(
    plans: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>['plan']>>,
) {
    return plans.map((p) => ({
        host: p.host.id,
        unchanged: p.unchanged,
        created: p.created,
        updated: p.updated,
        deleted: p.deleted,
    }));
}
