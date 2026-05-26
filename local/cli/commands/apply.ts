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

    const pool = await connect(ctx.hosts);
    const tasksByHost = buildTasksByHost(ctx.hosts);
    const showInternal = flags.logLevel <= 1;
    const noopIds = new Set<string>();
    if (!showInternal) {
        for (const tasks of tasksByHost.values()) {
            for (const t of tasks) {
                if (t.type === '$noop') noopIds.add(t.id);
            }
        }
    }
    try {
        const plans = await pool.plan(
            ctx.stack,
            flags.reapply ? 'reapply' : 'apply',
        );

        const visibleChange = (id: string) => !noopIds.has(id);
        const totalChanges = plans.reduce(
            (n, p) =>
                n +
                p.created.filter(visibleChange).length +
                p.updated.filter((u) => visibleChange(u.id)).length +
                p.deleted.filter((d) => visibleChange(d.id)).length,
            0,
        );

        if (!flags.json) {
            printPlan(
                plans,
                tasksByHost,
                {
                    color: flags.color,
                    json: false,
                    quiet: flags.quiet,
                    showUnchanged: flags.logLevel <= 1,
                },
                noopIds,
            );
        }

        if (totalChanges === 0) {
            if (!flags.json) {
                process.stdout.write('No changes.\n');
            } else {
                printJson({
                    plans: stripPlans(plans, noopIds),
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
            if (noopIds.has(event.taskId)) return;
            liveProgress(event, {
                color: flags.color,
                json: flags.json,
                quiet: flags.quiet,
                showUnchanged: false,
            });
        });

        if (flags.json) {
            printJson({
                plans: stripPlans(plans, noopIds),
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
            const summaryResults =
                noopIds.size === 0
                    ? results
                    : results.map((r) => ({
                          ...r,
                          completed: r.completed.filter(
                              (id) => !noopIds.has(id),
                          ),
                          skipped: r.skipped.filter((id) => !noopIds.has(id)),
                          errored: r.errored.filter(
                              (e) => !noopIds.has(e.taskId),
                          ),
                      }));
            printSummary(summaryResults, {
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
    noopIds: Set<string>,
) {
    return plans.map((p) => ({
        host: p.host.id,
        unchanged: p.unchanged.filter((id) => !noopIds.has(id)),
        created: p.created.filter((id) => !noopIds.has(id)),
        updated: p.updated.filter((u) => !noopIds.has(u.id)),
        deleted: p.deleted.filter((d) => !noopIds.has(d.id)),
    }));
}
