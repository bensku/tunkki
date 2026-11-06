import type { Event, Plan, PlanMode, TargetPool } from '../../..';
import { connect } from '../../..';
import { readPlan } from '../../plan';
import { makeColor } from '../colors';
import {
    connectionProgress,
    countChanges,
    err,
    hasWork,
    liveProgress,
    out,
    printJson,
    printPlan,
    printSummary,
    visibleChanges,
} from '../output';
import type { ParsedCli } from '../parse';
import { type CliContext, hiddenIds } from './plan';

type Flags = ParsedCli['flags'];

export function run(ctx: CliContext): Promise<number> {
    const flags = ctx.cli.flags;
    if (flags.planFile) {
        return applyPlanFile(ctx, flags.planFile);
    }
    return planAndApply(ctx, flags.reapply ? 'reapply' : 'apply');
}

/**
 * Plans, asks for confirmation and applies.
 */
export async function planAndApply(
    ctx: CliContext,
    mode: PlanMode,
): Promise<number> {
    if (ctx.hosts.length === 0) {
        err('no hosts match --target');
        return 2;
    }
    const flags = ctx.cli.flags;
    if (flags.json && !flags.yes) {
        err(
            `--json requires --yes for ${ctx.cli.command} (no interactive prompts allowed)`,
        );
        return 2;
    }

    const pool = await connect(ctx.hosts, (event) =>
        connectionProgress(event, flags),
    );
    try {
        const plan = await pool.plan(ctx.stack, mode);
        const hidden = hiddenIds(plan, flags);
        if (!flags.json) {
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

        if (countChanges(plan, hidden) === 0) {
            if (!flags.json) {
                out(mode === 'destroy' ? 'Nothing to destroy.' : 'No changes.');
            }
            if (!hasWork(plan)) {
                if (flags.json) {
                    printJson({
                        plans: visibleChanges(plan, hidden),
                        results: [],
                        events: [],
                    });
                }
                return 0;
            }
            // Hidden work, e.g. updating stored deps, is done without asking
        } else if (!flags.yes && !confirmApply(ctx, mode)) {
            return 0;
        }
        return await execute(pool, plan, flags, hidden);
    } finally {
        await pool.close();
    }
}

function confirmApply(ctx: CliContext, mode: PlanMode): boolean {
    if (mode === 'destroy') {
        const c = makeColor(ctx.cli.flags.color);
        out(c.bold(c.red(`About to destroy stack "${ctx.stack}".`)));
        return confirm('Continue?');
    }
    return confirm('Apply these changes?');
}

/**
 * Applies a plan from a file, without asking. It was approved when it was
 * made.
 */
async function applyPlanFile(ctx: CliContext, path: string): Promise<number> {
    const plan = await readPlan(path);
    if (plan.stack !== ctx.stack) {
        err(`plan is for stack ${plan.stack}, not ${ctx.stack}`);
        return 2;
    }
    const hosts = [];
    for (const id of Object.keys(plan.hosts)) {
        const host = ctx.hosts.find((host) => host.id === id);
        if (!host) {
            err(`plan has host ${id}, which this script does not have`);
            return 2;
        }
        hosts.push(host);
    }

    const flags = ctx.cli.flags;
    const pool = await connect(hosts, (event) =>
        connectionProgress(event, flags),
    );
    try {
        return await execute(pool, plan, flags, hiddenIds(plan, flags));
    } finally {
        await pool.close();
    }
}

async function execute(
    pool: TargetPool,
    plan: Plan,
    flags: Flags,
    hidden: Set<string>,
): Promise<number> {
    const outputOpts = {
        color: flags.color,
        json: flags.json,
        quiet: flags.quiet,
        showUnchanged: false,
    };
    const events: Event[] = [];
    const results = await pool.execute(plan, (event) => {
        events.push(event);
        if (!hidden.has(event.taskId)) {
            liveProgress(event, outputOpts);
        }
    });

    if (flags.json) {
        printJson({
            plans: visibleChanges(plan, hidden),
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
        const visible = (id: string) => !hidden.has(id);
        printSummary(
            results.map((r) => ({
                ...r,
                completed: r.completed.filter(visible),
                unchanged: r.unchanged.filter(visible),
                skipped: r.skipped.filter(visible),
                errored: r.errored.filter((e) => visible(e.taskId)),
            })),
            outputOpts,
        );
    }

    const failed = results.some((r) => r.errored.length > 0 || r.error);
    return failed ? 1 : 0;
}
