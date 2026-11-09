import { writePlan } from '../../plan';
import {
    type CliContext,
    connectHosts,
    hiddenIds,
    reporterFor,
} from '../context';
import { err, printJson, printPlan, visibleChanges } from '../output';

export { type CliContext, hiddenIds } from '../context';

export async function run(ctx: CliContext): Promise<number> {
    if (ctx.hosts.length === 0) {
        err('no hosts match --target');
        return 2;
    }

    const flags = ctx.cli.flags;
    const reporter = reporterFor(flags);
    const pool = await connectHosts(ctx.hosts, reporter);
    try {
        reporter.status('Planning');
        const plan = await pool.plan(
            ctx.stack,
            flags.reapply ? 'reapply' : 'apply',
        );
        reporter.status(null);
        if (flags.planFile) {
            await writePlan(flags.planFile, plan);
        }
        const hidden = hiddenIds(plan, flags);
        if (flags.json) {
            printJson({ type: 'result', plans: visibleChanges(plan, hidden) });
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
