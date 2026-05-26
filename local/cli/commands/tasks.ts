import { makeColor } from '../colors';
import { err, out, printJson } from '../output';
import { buildTasksByHost, type CliContext } from './plan';

export async function run(ctx: CliContext): Promise<number> {
    if (ctx.hosts.length === 0) {
        err('no hosts match --target');
        return 2;
    }

    const tasksByHost = buildTasksByHost(ctx.hosts);
    const flags = ctx.cli.flags;
    const includeState = flags.logLevel <= 1;
    const showInternal = flags.logLevel <= 1;

    if (flags.json) {
        printJson({
            hosts: ctx.hosts.map((h) => {
                const tasks = tasksByHost.get(h.id) ?? [];
                return {
                    id: h.id,
                    tasks: tasks
                        .filter((t) => showInternal || t.type !== '$noop')
                        .map((t) => {
                            const base: Record<string, unknown> = {
                                id: t.id,
                                type: t.type,
                                after: t.after ?? [],
                            };
                            if (includeState) base.state = t.state;
                            return base;
                        }),
                };
            }),
        });
        return 0;
    }

    const c = makeColor(flags.color);
    for (const host of ctx.hosts) {
        const tasks = (tasksByHost.get(host.id) ?? [])
            .filter((t) => showInternal || t.type !== '$noop')
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id));
        out(c.bold(`host ${host.id}`));
        if (tasks.length === 0) {
            out(c.dim('  (no tasks)'));
            out('');
            continue;
        }

        const idWidth = Math.max(2, ...tasks.map((t) => t.id.length));
        const typeWidth = Math.max(4, ...tasks.map((t) => t.type.length));
        out(
            c.dim(
                `  ${'id'.padEnd(idWidth)}  ${'type'.padEnd(typeWidth)}  after`,
            ),
        );
        for (const t of tasks) {
            const dep = (t.after ?? []).join(', ');
            out(
                `  ${t.id.padEnd(idWidth)}  ${t.type.padEnd(typeWidth)}  ${c.dim(dep)}`,
            );
        }
        out('');
    }

    return 0;
}
