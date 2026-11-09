import type { Plan } from '../..';
import { substituteState } from '../outputs';
import { makeColor } from './colors';
import { renderDiff } from './diff';
import { shortId } from './reporter';
import { term } from './terminal';

export interface OutputOptions {
    color: boolean;
    json: boolean;
    quiet: boolean;
    showUnchanged: boolean;
}

export function out(...parts: unknown[]): void {
    term.write('stdout', `${parts.map(stringify).join(' ')}\n`);
}

export function err(...parts: unknown[]): void {
    term.write('stderr', `${parts.map(stringify).join(' ')}\n`);
}

function stringify(v: unknown): string {
    if (typeof v === 'string') return v;
    return Bun.inspect(v, { colors: false, depth: 4 });
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

    // Hosts often get the same changes, so they are shown together
    const groups = new Map<string, string[]>();
    const unchangedHosts: string[] = [];
    for (const changes of visibleChanges(plan, hidden)) {
        const host = changes.host;
        const name = (id: string) => shortId(id, host);
        const lines: string[] = [];
        const entry = (line: string, body?: string[]) => {
            lines.push(line, ...(body ?? []));
        };
        for (const id of changes.created) {
            entry(
                `  ${c.green('+')} ${name(id)} ${typeOf(id)}`,
                renderDiff(undefined, resolvedState(plan, id), c, 4),
            );
            totals.add++;
        }
        for (const id of changes.updated) {
            entry(
                `  ${c.yellow('~')} ${name(id)} ${typeOf(id)}`,
                renderDiff(oldState(id), resolvedState(plan, id), c, 4),
            );
            totals.change++;
        }
        for (const id of changes.maybe) {
            entry(
                `  ${c.yellow('?')} ${name(id)} ${typeOf(id)} ${c.dim('may change with its deps')}`,
            );
            totals.maybe++;
        }
        for (const id of changes.replaced) {
            const oldType = plan.old[id]?.handler;
            entry(
                `  ${c.yellow('±')} ${name(id)} ${c.dim(`(${oldType} → ${plan.nodes[id]?.task.type})`)}`,
                renderDiff(oldState(id), resolvedState(plan, id), c, 4),
            );
            totals.replace++;
        }
        for (const id of changes.deleted) {
            entry(
                `  ${c.red('-')} ${name(id)} ${typeOf(id)}`,
                renderDiff(oldState(id), undefined, c, 4),
            );
            totals.destroy++;
        }
        if (lines.length === 0 && !opts.showUnchanged) {
            unchangedHosts.push(host);
            continue;
        }
        if (opts.showUnchanged) {
            for (const id of changes.unchanged) {
                entry(c.dim(`  = ${name(id)}`));
            }
        }
        const key = lines.join('\n');
        groups.set(key, [...(groups.get(key) ?? []), host]);
    }

    for (const [body, hosts] of groups) {
        out(
            c.bold(
                `${hosts.length === 1 ? 'host' : 'hosts'} ${hosts.join(', ')}`,
            ),
        );
        out(body.length > 0 ? body : c.dim('  (no changes)'));
        out('');
    }
    if (unchangedHosts.length > 0) {
        out(c.dim(`No changes on ${unchangedHosts.join(', ')}.`));
    }

    out(
        `Plan: ${c.green(`${totals.add} to add`)}, ` +
            `${c.yellow(`${totals.change} to change`)}, ` +
            `${c.yellow(`${totals.replace} to replace`)}, ` +
            `${c.red(`${totals.destroy} to destroy`)}, ` +
            `${c.yellow(`${totals.maybe} may change`)}.`,
    );
}

export function printJson(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function printJsonError(message: string): void {
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
}
