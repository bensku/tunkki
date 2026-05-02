import type { Result } from '../..';
import type { Event, Plan } from '../runner';
import type { Task } from '../task';
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

export function printPlan(
    plans: Plan[],
    tasksByHost: Map<string, Task[]>,
    opts: OutputOptions,
): void {
    const c = makeColor(opts.color);
    let totalAdd = 0;
    let totalChange = 0;
    let totalDestroy = 0;

    for (const plan of plans) {
        const tasks = tasksByHost.get(plan.host.id) ?? [];
        const taskById = new Map(tasks.map((t) => [t.id, t]));

        const entries: { id: string; line: string; body?: string[] }[] = [];

        for (const id of [...plan.created].sort()) {
            const task = taskById.get(id);
            const typeLabel = task ? c.dim(`(${task.type})`) : '';
            entries.push({
                id,
                line: `  ${c.green('+')} ${id} ${typeLabel}`.trimEnd(),
                body:
                    task !== undefined
                        ? renderDiff(undefined, task.state, c, 4)
                        : undefined,
            });
            totalAdd++;
        }

        for (const upd of [...plan.updated].sort((a, b) =>
            a.id.localeCompare(b.id),
        )) {
            const task = taskById.get(upd.id);
            const typeLabel = task ? c.dim(`(${task.type})`) : '';
            const newState = task?.state;
            entries.push({
                id: upd.id,
                line: `  ${c.yellow('~')} ${upd.id} ${typeLabel}`.trimEnd(),
                body: renderDiff(upd.oldState, newState, c, 4),
            });
            totalChange++;
        }

        for (const del of [...plan.deleted].sort((a, b) =>
            a.id.localeCompare(b.id),
        )) {
            entries.push({
                id: del.id,
                line: `  ${c.red('-')} ${del.id}`,
                body: renderDiff(del.oldState, undefined, c, 4),
            });
            totalDestroy++;
        }

        if (opts.showUnchanged) {
            for (const id of [...plan.unchanged].sort()) {
                entries.push({
                    id,
                    line: c.dim(`  = ${id}`),
                });
            }
        }

        out(c.bold(`host ${plan.host.id}`));
        if (entries.length === 0) {
            out(c.dim('  (no changes)'));
        } else {
            for (const e of entries) {
                out(e.line);
                if (e.body) {
                    for (const bl of e.body) out(bl);
                }
            }
        }
        out('');
    }

    out(
        `Plan: ${c.green(`${totalAdd} to add`)}, ` +
            `${c.yellow(`${totalChange} to change`)}, ` +
            `${c.red(`${totalDestroy} to destroy`)}.`,
    );
}

export function liveProgress(event: Event, opts: OutputOptions): void {
    if (opts.quiet || opts.json) return;
    const c = makeColor(opts.color);
    let icon: string;
    switch (event.status) {
        case 'done':
            icon = c.green('✓');
            break;
        case 'error':
            icon = c.red('✗');
            break;
        case 'skipped':
            icon = c.dim('·');
            break;
    }
    const tag = c.dim(`[${event.host.id}]`);
    let line = `${tag} ${icon} ${event.taskId}`;
    if (event.status === 'error' && event.error) {
        line += ` ${c.red(event.error)}`;
    }
    out(line);
}

export function printSummary(results: Result[], opts: OutputOptions): void {
    const c = makeColor(opts.color);
    let totalDone = 0;
    let totalSkipped = 0;
    let totalErrored = 0;

    for (const r of results) {
        totalDone += r.completed.length;
        totalSkipped += r.skipped.length;
        totalErrored += r.errored.length;
    }

    if (totalErrored > 0) {
        out('');
        out(c.bold(c.red('Errors:')));
        for (const r of results) {
            for (const e of r.errored) {
                out(`  ${c.dim(`[${r.host}]`)} ${c.red(e.taskId)}: ${e.error}`);
            }
        }
    }

    out('');
    out(
        `${c.bold('Apply complete:')}` +
            ` ${c.green(`${totalDone} done`)}, ` +
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
