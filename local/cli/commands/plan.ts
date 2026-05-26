import { connect, type Host } from '../../..';
import * as builder from '../../builder';
import type { Task } from '../../task';
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
            builder.tasks.filter((task) => task.host === host.id),
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
    const showInternal = ctx.cli.flags.logLevel <= 1;
    const noopIds = new Set<string>();
    if (!showInternal) {
        for (const tasks of tasksByHost.values()) {
            for (const t of tasks) {
                if (t.type === '$noop') noopIds.add(t.id);
            }
        }
    }
    const pool = await connect(ctx.hosts);
    try {
        const plans = await pool.plan(
            ctx.stack,
            ctx.cli.flags.reapply ? 'reapply' : 'apply',
        );
        if (ctx.cli.flags.json) {
            printJson({
                plans: plans.map((p) => ({
                    host: p.host.id,
                    unchanged: p.unchanged.filter((id) => !noopIds.has(id)),
                    created: p.created.filter((id) => !noopIds.has(id)),
                    updated: p.updated.filter((u) => !noopIds.has(u.id)),
                    deleted: p.deleted.filter((d) => !noopIds.has(d.id)),
                })),
            });
        } else {
            printPlan(
                plans,
                tasksByHost,
                {
                    color: ctx.cli.flags.color,
                    json: ctx.cli.flags.json,
                    quiet: ctx.cli.flags.quiet,
                    showUnchanged: showInternal,
                },
                noopIds,
            );
        }
        return 0;
    } finally {
        await pool.close();
    }
}
