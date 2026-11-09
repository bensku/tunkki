import type { Plan, PlanMode, Result, TargetPool } from '../../..';
import { readPlan } from '../../plan';
import { makeColor } from '../colors';
import {
    type CliContext,
    connectHosts,
    hiddenIds,
    reporterFor,
} from '../context';
import {
    countChanges,
    err,
    hasWork,
    out,
    printJson,
    printPlan,
    visibleChanges,
} from '../output';
import type { ParsedCli } from '../parse';
import type { Reporter } from '../reporter';
import { term } from '../terminal';

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

    const reporter = reporterFor(flags);
    const pool = await connectHosts(ctx.hosts, reporter);
    try {
        reporter.status('Planning');
        const plan = await pool.plan(ctx.stack, mode);
        reporter.status(null);
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
                        type: 'result',
                        plans: visibleChanges(plan, hidden),
                        results: [],
                    });
                }
                return 0;
            }
            // Hidden work, e.g. updating stored deps, is done without asking
        } else if (!flags.yes && !confirmApply(ctx, mode)) {
            return 0;
        }
        return await execute(pool, plan, flags, hidden, reporter);
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
    const reporter = reporterFor(flags);
    const pool = await connectHosts(hosts, reporter);
    try {
        return await execute(
            pool,
            plan,
            flags,
            hiddenIds(plan, flags),
            reporter,
        );
    } finally {
        await pool.close();
    }
}

async function execute(
    pool: TargetPool,
    plan: Plan,
    flags: Flags,
    hidden: Set<string>,
    reporter: Reporter,
): Promise<number> {
    // First Ctrl-C lets running tasks finish and stores their results,
    // second one exits right away
    const abort = new AbortController();
    const restore = term.onInterrupt(() => {
        if (abort.signal.aborted) {
            return false;
        }
        abort.abort();
        reporter.notice(
            'Interrupted: letting running tasks finish. Press Ctrl-C again to stop right away.',
        );
        return true;
    });

    let results: Result[];
    reporter.startApply(plan, hidden);
    try {
        results = await pool.execute(
            plan,
            (event) => reporter.task(event),
            abort.signal,
        );
    } finally {
        restore();
    }
    const interrupted = abort.signal.aborted;
    reporter.finishApply(results, interrupted);

    if (flags.json) {
        printJson({
            type: 'result',
            plans: visibleChanges(plan, hidden),
            results,
            interrupted,
        });
    }

    if (interrupted) {
        return 130;
    }
    const failed = results.some((r) => r.errored.length > 0 || r.error);
    return failed ? 1 : 0;
}
