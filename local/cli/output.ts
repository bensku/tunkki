import type { ConnectionEvent, Event, Plan, Result } from '../..';
import { substituteState } from '../outputs';
import { type Colorizer, makeColor } from './colors';
import { renderDiff, renderValue } from './diff';

export interface OutputOptions {
    color: boolean;
    json: boolean;
    quiet: boolean;
    showUnchanged: boolean;
}

export function out(...parts: unknown[]): void {
    process.stdout.write(`${parts.map(stringify).join(' ')}\n`);
}

export function err(...parts: unknown[]): void {
    process.stderr.write(`${parts.map(stringify).join(' ')}\n`);
}

function stringify(v: unknown): string {
    if (typeof v === 'string') return v;
    return Bun.inspect(v, { colors: false, depth: 4 });
}

export function section(c: Colorizer, title: string): void {
    out(
        c.bold(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length - 4))}`),
    );
}

/**
 * Ids of internal $noop tasks, which are hidden unless verbose.
 */
export function noopIds(plan: Plan): Set<string> {
    return new Set(
        Object.values(plan.nodes)
            .filter(
                (node) =>
                    node.task.type === '$noop' ||
                    plan.old[node.task.id]?.handler === '$noop',
            )
            .map((node) => node.task.id),
    );
}

/**
 * Changes to show to the user, by host.
 */
export function visibleChanges(plan: Plan, hidden: Set<string>) {
    const byHost = (ids: string[], host: string) =>
        ids
            .filter(
                (id) => !hidden.has(id) && plan.nodes[id]?.task.host === host,
            )
            .sort();
    return Object.keys(plan.hosts).map((host) => ({
        host,
        created: byHost(plan.created, host),
        updated: byHost(plan.updated, host),
        maybe: byHost(plan.uncertain, host),
        replaced: byHost(plan.replaced, host),
        deleted: byHost(plan.deleted, host),
        unchanged: byHost(plan.unchanged, host),
    }));
}

/**
 * Number of changes the user would see.
 */
export function countChanges(plan: Plan, hidden: Set<string>): number {
    return visibleChanges(plan, hidden).reduce(
        (n, host) =>
            n +
            host.created.length +
            host.updated.length +
            host.maybe.length +
            host.replaced.length +
            host.deleted.length,
        0,
    );
}

/**
 * Whether applying the plan would do anything, including hidden work.
 */
export function hasWork(plan: Plan): boolean {
    return (
        plan.unchanged.length < Object.keys(plan.nodes).length ||
        plan.refresh.length > 0
    );
}

/**
 * Input of a task with outputs substituted where they are known.
 */
function resolvedState(plan: Plan, id: string): unknown {
    const state = plan.nodes[id]?.task.state;
    try {
        return substituteState(state, (ref) => plan.old[ref]?.output).value;
    } catch {
        return state;
    }
}

export function printPlan(
    plan: Plan,
    opts: OutputOptions,
    hidden: Set<string>,
): void {
    const c = makeColor(opts.color);
    const typeOf = (id: string) => c.dim(`(${plan.nodes[id]?.task.type})`);
    const oldState = (id: string) => plan.old[id]?.state;
    const totals = { add: 0, change: 0, maybe: 0, replace: 0, destroy: 0 };

    for (const changes of visibleChanges(plan, hidden)) {
        const entries: { line: string; body?: string[] }[] = [];
        for (const id of changes.created) {
            entries.push({
                line: `  ${c.green('+')} ${id} ${typeOf(id)}`,
                body: renderDiff(undefined, resolvedState(plan, id), c, 4),
            });
            totals.add++;
        }
        for (const id of changes.updated) {
            entries.push({
                line: `  ${c.yellow('~')} ${id} ${typeOf(id)}`,
                body: renderDiff(oldState(id), resolvedState(plan, id), c, 4),
            });
            totals.change++;
        }
        for (const id of changes.maybe) {
            entries.push({
                line: `  ${c.yellow('?')} ${id} ${typeOf(id)} ${c.dim('may change with its deps')}`,
            });
            totals.maybe++;
        }
        for (const id of changes.replaced) {
            const oldType = plan.old[id]?.handler;
            entries.push({
                line: `  ${c.yellow('±')} ${id} ${c.dim(`(${oldType} → ${plan.nodes[id]?.task.type})`)}`,
                body: renderDiff(oldState(id), resolvedState(plan, id), c, 4),
            });
            totals.replace++;
        }
        for (const id of changes.deleted) {
            entries.push({
                line: `  ${c.red('-')} ${id} ${typeOf(id)}`,
                body: renderDiff(oldState(id), undefined, c, 4),
            });
            totals.destroy++;
        }
        if (opts.showUnchanged) {
            for (const id of changes.unchanged) {
                entries.push({ line: c.dim(`  = ${id}`) });
            }
        }

        out(c.bold(`host ${changes.host}`));
        if (entries.length === 0) {
            out(c.dim('  (no changes)'));
        }
        for (const entry of entries) {
            out(entry.line);
            for (const line of entry.body ?? []) {
                out(line);
            }
        }
        out('');
    }

    out(
        `Plan: ${c.green(`${totals.add} to add`)}, ` +
            `${c.yellow(`${totals.change} to change`)}, ` +
            `${c.yellow(`${totals.replace} to replace`)}, ` +
            `${c.red(`${totals.destroy} to destroy`)}, ` +
            `${c.yellow(`${totals.maybe} may change`)}.`,
    );
}

export function liveProgress(event: Event, opts: OutputOptions): void {
    if (opts.quiet || opts.json) return;
    const c = makeColor(opts.color);
    let icon: string;
    if (event.type === 'started') {
        icon = c.dim('→');
    } else {
        switch (event.status) {
            case 'done':
                icon = c.green('✓');
                break;
            case 'unchanged':
                icon = c.dim('=');
                break;
            case 'error':
                icon = c.red('✗');
                break;
            case 'skipped':
                icon = c.dim('·');
                break;
            default:
                return;
        }
    }
    const tag = c.dim(`[${event.host.id}]`);
    let line = `${tag} ${icon} ${event.taskId}`;
    if (event.type === 'completed' && event.status === 'error' && event.error) {
        line += ` ${c.red(event.error)}`;
    }
    out(line);
}

export function connectionProgress(
    event: ConnectionEvent,
    opts: Pick<OutputOptions, 'json' | 'quiet' | 'color'>,
): void {
    if (opts.quiet || opts.json) return;
    const c = makeColor(opts.color);
    if (event.type === 'ready') {
        out(`${c.green('✓')} All hosts connected`);
        return;
    }
    const tag = c.dim(`[${event.host.id}]`);
    if (event.type === 'started') {
        out(`${tag} ${c.dim('→')} connecting`);
    } else if (event.status === 'done') {
        out(`${tag} ${c.green('✓')} connected`);
    } else {
        const message =
            event.error instanceof Error
                ? event.error.message
                : stringify(event.error);
        out(`${tag} ${c.red('✗')} connection failed: ${message}`);
    }
}

export function printSummary(results: Result[], opts: OutputOptions): void {
    const c = makeColor(opts.color);
    let totalDone = 0;
    let totalUnchanged = 0;
    let totalSkipped = 0;
    let totalErrored = 0;

    for (const r of results) {
        totalDone += r.completed.length;
        totalUnchanged += r.unchanged.length;
        totalSkipped += r.skipped.length;
        totalErrored += r.errored.length + (r.error ? 1 : 0);
    }

    if (totalErrored > 0) {
        out('');
        out(c.bold(c.red('Errors:')));
        for (const r of results) {
            for (const e of r.errored) {
                out(`  ${c.dim(`[${r.host}]`)} ${c.red(e.taskId)}: ${e.error}`);
            }
            if (r.error) {
                out(`  ${c.dim(`[${r.host}]`)} ${r.error}`);
            }
        }
    }

    out('');
    out(
        `${c.bold('Apply complete:')}` +
            ` ${c.green(`${totalDone} done`)}, ` +
            `${c.dim(`${totalUnchanged} unchanged`)}, ` +
            `${c.dim(`${totalSkipped} skipped`)}, ` +
            `${c.red(`${totalErrored} errored`)}` +
            ` across ${results.length} host(s).`,
    );
}

export function printJson(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function printJsonError(message: string): void {
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
}

export type { Colorizer };
export { makeColor, renderValue };
