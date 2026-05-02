import { connect, type Host } from '../../..';
import * as builder from '../../builder';
import { filterTasks, type Task } from '../../task';
import { err, printJson, printPlan } from '../output';
import type { ParsedCli } from '../parse';

export interface CliContext {
    stack: string;
    hosts: Host[];
    cli: ParsedCli;
}

export function buildTasksByHost(hosts: Host[]): Map<string, Task[]> {
    const map = new Map<string, Task[]>();
    for (const host of hosts) {
        map.set(
            host.id,
            filterTasks(builder.tasks, { ...host.tags, host: host.id }),
        );
    }
    return map;
}

export async function run(ctx: CliContext): Promise<number> {
    if (ctx.hosts.length === 0) {
        err('no hosts match --target');
        return 2;
    }

    const tasksByHost = buildTasksByHost(ctx.hosts);
    const pool = await connect(ctx.hosts);
    try {
        const plans = await pool.plan(ctx.stack);
        if (ctx.cli.flags.json) {
            printJson({
                plans: plans.map((p) => ({
                    host: p.host.id,
                    unchanged: p.unchanged,
                    created: p.created,
                    updated: p.updated,
                    deleted: p.deleted,
                })),
            });
        } else {
            printPlan(plans, tasksByHost, {
                color: ctx.cli.flags.color,
                json: ctx.cli.flags.json,
                quiet: ctx.cli.flags.quiet,
                showUnchanged: ctx.cli.flags.logLevel <= 1,
            });
        }
        return 0;
    } finally {
        await pool.close();
    }
}
