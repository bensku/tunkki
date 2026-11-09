import type { ConnectionEvent, Event, Plan, Result } from '../..';
import { formatError } from '../../common/error';
import type { Colorizer } from './colors';
import { duration, term } from './terminal';

/**
 * Shows progress of connecting, planning and applying.
 */
export interface Reporter {
    /**
     * Starts showing progress of connecting to hosts.
     */
    startConnect(hosts: string[]): void;
    connection(event: ConnectionEvent): void;

    /**
     * Shows that something is going on, until the next call. Null shows
     * nothing.
     */
    status(text: string | null): void;

    /**
     * Prints a notice that is not tied to a host or task.
     */
    notice(text: string): void;

    startApply(plan: Plan, hidden: Set<string>): void;
    task(event: Event): void;

    /**
     * Prints the apply summary.
     * @param interrupted Whether the user interrupted the apply.
     */
    finishApply(results: Result[], interrupted: boolean): void;
}

export interface ReporterOptions {
    color: Colorizer;
    json: boolean;
    quiet: boolean;
    verbose: boolean;
    live: boolean;
}

export function makeReporter(opts: ReporterOptions): Reporter {
    return opts.json ? new JsonReporter() : new HumanReporter(opts);
}

/**
 * Name of a task without its host prefix.
 */
export function shortId(id: string, host: string): string {
    return id.startsWith(`${host}.`) ? id.slice(host.length + 1) : id;
}

/**
 * Text to show for a prompt from a transport.
 */
function promptText(prompt: string): string {
    return /user presence/i.test(prompt) ? 'touch your security key' : prompt;
}

type ConnState =
    | 'queued'
    | 'authenticating'
    | 'handshaking'
    | 'done'
    | 'error'
    | 'skipped';

interface HostConn {
    id: string;
    state: ConnState;
    prompt?: string;
    since: number;
}

interface HostProgress {
    id: string;
    /**
     * Visible tasks that need to be applied, whatever the result.
     */
    total: number;
    finished: number;
    changed: number;
    failed: number;
    skipped: number;
    running: Map<string, number>;
    started?: number;
    ended?: number;
}

interface ApplyState {
    plan: Plan;
    hidden: Set<string>;
    started: number;
    hosts: Map<string, HostProgress>;
    finished: Set<string>;
    startTimes: Map<string, number>;
    durations: { id: string; host: string; ms: number }[];
    actions: Map<string, string>;
    waitsFor: Map<string, string[]>;
    hostWidth: number;
    nameWidth: number;
}

/**
 * Progress for humans, either drawn live or printed line by line.
 */
class HumanReporter implements Reporter {
    #c: Colorizer;
    #opts: ReporterOptions;
    /**
     * Whether progress is drawn live, instead of printed line by line.
     */
    #live: boolean;
    #conns = new Map<string, HostConn>();
    #connStarted = 0;
    #status: { text: string; since: number } | null = null;
    #apply: ApplyState | null = null;

    constructor(opts: ReporterOptions) {
        this.#c = opts.color;
        this.#opts = opts;
        this.#live = opts.live && !opts.quiet;
    }

    // Connections

    startConnect(hosts: string[]) {
        const now = performance.now();
        this.#connStarted = now;
        this.#conns = new Map(
            hosts.map((id) => [id, { id, state: 'queued', since: now }]),
        );
        this.#update();
    }

    connection(event: ConnectionEvent) {
        const c = this.#c;
        if (event.type === 'message') {
            // These may arrive at any time, not just while connecting
            this.#print(
                `${c.dim(`[${event.host.id}]`)} ${c.dim(event.message)}`,
                'stderr',
            );
            return;
        } else if (event.type === 'ready') {
            const hosts = this.#conns.size;
            this.#conns.clear();
            this.#update();
            if (!this.#opts.quiet) {
                this.#print(
                    `${c.green('✓')} Connected to ${hosts} host${hosts === 1 ? '' : 's'} ${c.dim(`in ${duration(performance.now() - this.#connStarted)}`)}`,
                );
            }
            return;
        }

        const id = event.host.id;
        const now = performance.now();
        const conn = this.#conns.get(id) ?? {
            id,
            state: 'queued',
            since: now,
        };
        this.#conns.set(id, conn);
        const tag = c.dim(`[${id}]`);
        switch (event.type) {
            case 'started':
                conn.state = 'authenticating';
                conn.since = now;
                if (this.#opts.verbose && !this.#live) {
                    this.#print(`${tag} connecting`);
                }
                break;
            case 'prompt':
                conn.prompt = promptText(event.prompt);
                if (!this.#live) {
                    // The user must see this, even when quiet
                    this.#print(`${tag} ${c.yellow(conn.prompt)}`);
                }
                break;
            case 'authenticated':
                conn.state = 'handshaking';
                conn.prompt = undefined;
                conn.since = now;
                break;
            case 'completed':
                conn.state =
                    event.status === 'done'
                        ? 'done'
                        : event.status === 'error'
                          ? 'error'
                          : 'skipped';
                conn.prompt = undefined;
                if (event.status === 'error') {
                    this.#print(
                        `${c.red('✗')} ${id} ${indented(formatError(event.error), c.red)}`,
                        'stderr',
                    );
                } else if (
                    event.status === 'done' &&
                    this.#opts.verbose &&
                    !this.#live
                ) {
                    this.#print(
                        `${tag} ${c.green('connected')} ${c.dim(duration(now - conn.since))}`,
                    );
                }
                break;
        }
        this.#update();
    }

    #renderConns(): string[] {
        const c = this.#c;
        const conns = [...this.#conns.values()];
        const done = conns.filter((conn) => conn.state === 'done').length;
        const now = performance.now();
        const width = Math.max(...conns.map((conn) => conn.id.length));
        const lines = [
            `${c.cyan(term.spinner)} Connecting ${c.dim(`${done}/${conns.length} hosts  ${duration(now - this.#connStarted)}`)}`,
        ];
        let queued = 0;
        for (const conn of conns) {
            const name = `    ${conn.id.padEnd(width)}  `;
            const since = c.dim(duration(now - conn.since));
            if (conn.prompt) {
                lines.push(`${name}${c.yellow(conn.prompt)} ${since}`);
            } else if (conn.state === 'authenticating') {
                lines.push(`${name}authenticating ${since}`);
            } else if (conn.state === 'handshaking') {
                lines.push(`${name}starting agent ${since}`);
            } else if (conn.state === 'queued') {
                queued++;
            }
        }
        if (queued > 0) {
            lines.push(c.dim(`    ${queued} more queued`));
        }
        return lines;
    }

    // Status and notices

    status(text: string | null) {
        this.#status = text ? { text, since: performance.now() } : null;
        this.#update();
    }

    notice(text: string) {
        this.#print(this.#c.yellow(text));
    }

    // Apply

    startApply(plan: Plan, hidden: Set<string>) {
        const actions = new Map<string, string>();
        for (const id of plan.created) actions.set(id, '+');
        for (const id of [...plan.updated, ...plan.uncertain])
            actions.set(id, '~');
        for (const id of plan.replaced) actions.set(id, '±');
        for (const id of plan.deleted) actions.set(id, '-');

        const waitsFor = new Map<string, string[]>();
        for (const [id, node] of Object.entries(plan.nodes)) {
            waitsFor.set(id, [...node.after]);
        }
        for (const barrier of plan.barriers) {
            for (const id of barrier.blocked) {
                waitsFor.get(id)?.push(...barrier.wait);
            }
        }

        const unchanged = new Set(plan.unchanged);
        let hostWidth = 0;
        let nameWidth = 0;
        const hosts = new Map<string, HostProgress>(
            Object.keys(plan.hosts).map((id) => [
                id,
                {
                    id,
                    total: 0,
                    finished: 0,
                    changed: 0,
                    failed: 0,
                    skipped: 0,
                    running: new Map(),
                },
            ]),
        );
        for (const [id, node] of Object.entries(plan.nodes)) {
            const host = hosts.get(node.task.host);
            if (host && !unchanged.has(id) && !hidden.has(id)) {
                host.total++;
                hostWidth = Math.max(hostWidth, host.id.length);
                nameWidth = Math.max(nameWidth, shortId(id, host.id).length);
            }
        }

        this.#apply = {
            plan,
            hidden,
            started: performance.now(),
            hosts,
            finished: unchanged,
            startTimes: new Map(),
            durations: [],
            actions,
            waitsFor,
            hostWidth,
            // Long names would push everything else too far
            nameWidth: Math.min(nameWidth, 32),
        };
        this.#update();
    }

    task(event: Event) {
        const apply = this.#apply;
        if (!apply) {
            return;
        }
        const c = this.#c;
        const now = performance.now();
        const id = event.taskId;
        const hostId = event.host.id;
        const host = apply.hosts.get(hostId);
        const hidden = apply.hidden.has(id);

        if (event.type === 'started') {
            apply.startTimes.set(id, now);
            if (host && !hidden) {
                host.running.set(id, now);
                host.started ??= now;
            }
            if (this.#opts.verbose && !this.#live && !hidden) {
                this.#print(
                    `${c.dim('→')} ${this.#taskLabel(apply, hostId, id)} ${c.dim('started')}`,
                );
            }
            this.#update();
            return;
        }

        apply.finished.add(id);
        const startedAt = apply.startTimes.get(id);
        const took = startedAt === undefined ? undefined : now - startedAt;
        if (!host || hidden) {
            this.#update();
            return;
        }
        host.running.delete(id);
        host.finished++;
        if (host.finished === host.total) {
            host.ended = now;
        }

        const name = shortId(id, hostId);
        const line = (icon: string, rest = '') =>
            `${icon} ${this.#taskLabel(apply, hostId, id)}${rest}`;
        const time = c.dim(
            took === undefined ? '      ' : duration(took).padStart(6),
        );
        const type = c.dim(apply.plan.nodes[id]?.task.type ?? '');
        switch (event.status) {
            case 'done': {
                host.changed++;
                if (took !== undefined) {
                    apply.durations.push({ id: name, host: hostId, ms: took });
                }
                const action = apply.actions.get(id) ?? '~';
                const icon =
                    action === '+'
                        ? c.green(action)
                        : action === '-'
                          ? c.red(action)
                          : c.yellow(action);
                if (!this.#opts.quiet) {
                    this.#print(line(icon, ` ${time}  ${type}`));
                }
                break;
            }
            case 'error':
                host.failed++;
                this.#print(
                    `${line(c.red('✗'), ` ${time}  ${type}`)}\n${indent(c.red(event.error ?? 'unknown error'), 4)}`,
                );
                break;
            case 'unchanged':
                if (this.#opts.verbose) {
                    this.#print(c.dim(line('=', ' unchanged')));
                }
                break;
            case 'skipped':
                host.skipped++;
                if (this.#opts.verbose) {
                    this.#print(c.dim(line('·', ' skipped')));
                }
                break;
        }
        this.#update();
    }

    /**
     * Host and name of a task, padded to line up with other tasks.
     */
    #taskLabel(apply: ApplyState, host: string, id: string): string {
        const name = shortId(id, host);
        return `${host.padEnd(apply.hostWidth)}  ${name.padEnd(apply.nameWidth)}`;
    }

    #renderApply(apply: ApplyState): string[] {
        const c = this.#c;
        const now = performance.now();
        const hosts = activeHosts(apply);
        const total = hosts.reduce((n, host) => n + host.total, 0);
        const finished = hosts.reduce((n, host) => n + host.finished, 0);
        const width = Math.max(...hosts.map((host) => host.id.length));

        const active: string[] = [];
        const waiting: string[] = [];
        const done: string[] = [];
        for (const host of hosts) {
            const name = `  ${host.id.padEnd(width)}  `;
            if (host.finished === host.total) {
                done.push(name + this.#hostResult(host));
            } else if (host.running.size > 0) {
                const tasks = [...host.running]
                    .sort(([, a], [, b]) => a - b)
                    .map(
                        ([id, since]) =>
                            `${shortId(id, host.id)} ${c.dim(duration(now - since))}`,
                    )
                    .join(c.dim(', '));
                active.push(
                    `${name}${bar(host.finished, host.total, c)} ${c.dim(`${host.finished}/${host.total}`)}  ${tasks}`,
                );
            } else {
                const blockers = this.#blockers(apply, host.id);
                waiting.push(
                    name +
                        c.dim(
                            blockers.length > 0
                                ? `waiting for ${blockers.join(', ')}`
                                : `${bar(host.finished, host.total, c)} ${host.finished}/${host.total}`,
                        ),
                );
            }
        }

        const lines = [
            `${c.cyan(term.spinner)} Applying ${c.dim(`${finished}/${total} tasks  ${duration(now - apply.started)}`)}`,
            ...active,
            ...waiting,
            ...done,
        ];
        // Keep the region small enough for the terminal
        const max = Math.max(4, (process.stdout.rows ?? 24) - 2);
        if (lines.length > max) {
            const hidden = lines.length - max + 1;
            return [
                ...lines.slice(0, max - 1),
                c.dim(`  … ${hidden} more hosts`),
            ];
        }
        return lines;
    }

    /**
     * Other hosts whose tasks the host's remaining tasks are waiting for.
     */
    #blockers(apply: ApplyState, host: string): string[] {
        const blockers = new Set<string>();
        for (const [id, node] of Object.entries(apply.plan.nodes)) {
            if (node.task.host !== host || apply.finished.has(id)) {
                continue;
            }
            for (const wait of apply.waitsFor.get(id) ?? []) {
                const other = apply.plan.nodes[wait]?.task.host;
                if (other && other !== host && !apply.finished.has(wait)) {
                    blockers.add(other);
                }
            }
        }
        return [...blockers].sort();
    }

    #hostResult(host: HostProgress): string {
        const c = this.#c;
        const parts = [`${host.changed} changed`];
        if (host.failed > 0) parts.push(c.red(`${host.failed} failed`));
        if (host.skipped > 0) parts.push(`${host.skipped} skipped`);
        const icon =
            host.failed > 0
                ? c.red('✗')
                : host.skipped > 0
                  ? c.yellow('–')
                  : c.green('✓');
        const took =
            host.started !== undefined && host.ended !== undefined
                ? c.dim(` in ${duration(host.ended - host.started)}`)
                : '';
        return `${icon} ${parts.join(', ')}${took}`;
    }

    finishApply(results: Result[], interrupted: boolean) {
        const apply = this.#apply;
        this.#apply = null;
        this.#update();
        if (!apply) {
            return;
        }
        const c = this.#c;
        const elapsed = duration(performance.now() - apply.started);
        const lines: string[] = [''];

        const hosts = activeHosts(apply);
        const failures = results.some(
            (result) => result.errored.length > 0 || result.error,
        );
        if (hosts.length === 0 && !failures) {
            // Only hidden work was done, which the user wasn't shown
            return;
        }
        if (hosts.length > 1 && !this.#opts.quiet) {
            const width = Math.max(...hosts.map((host) => host.id.length));
            for (const host of hosts) {
                lines.push(
                    `  ${host.id.padEnd(width)}  ${this.#hostResult(host)}`,
                );
            }
            lines.push('');
        }

        const visible = (id: string) => !apply.hidden.has(id);
        let changed = 0;
        let failed = 0;
        let skipped = 0;
        let unchanged = apply.plan.unchanged.filter(visible).length;
        const errors: string[] = [];
        for (const result of results) {
            changed += result.completed.filter(visible).length;
            skipped += result.skipped.filter(visible).length;
            unchanged += result.unchanged.filter(visible).length;
            for (const e of result.errored) {
                if (visible(e.taskId)) {
                    failed++;
                    errors.push(
                        `  ${c.red('✗')} ${result.host}  ${shortId(e.taskId, result.host)}`,
                    );
                }
            }
            if (result.error) {
                failed++;
                errors.push(
                    `  ${c.red('✗')} ${result.host}  ${indented(result.error, c.red)}`,
                );
            }
        }
        if (errors.length > 0) {
            lines.push(c.bold(c.red('Failed:')), ...errors, '');
        }

        const counts = [
            c.green(`${changed} changed`),
            failed > 0 ? c.red(`${failed} failed`) : `${failed} failed`,
            `${skipped} skipped`,
            c.dim(`${unchanged} unchanged`),
        ].join(', ');
        const verb = interrupted ? c.yellow('Interrupted') : 'Applied';
        lines.push(`${c.bold(`${verb} in ${elapsed}:`)} ${counts}`);

        const slowest = apply.durations
            .filter((task) => task.ms >= 1000)
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 3);
        if (
            slowest.length > 0 &&
            apply.durations.length > 3 &&
            !this.#opts.quiet
        ) {
            lines.push(
                c.dim(
                    `Slowest: ${slowest.map((task) => `${task.id} on ${task.host} ${duration(task.ms)}`).join(' · ')}`,
                ),
            );
        }
        this.#print(lines.join('\n'));
    }

    // Drawing

    #update() {
        if (!this.#live) {
            return;
        }
        const apply = this.#apply;
        if (apply && activeHosts(apply).length > 0) {
            term.live(() => this.#renderApply(apply));
        } else if (this.#conns.size > 0) {
            term.live(() => this.#renderConns());
        } else if (this.#status) {
            const status = this.#status;
            term.live(() => [
                `${this.#c.cyan(term.spinner)} ${status.text} ${this.#c.dim(duration(performance.now() - status.since))}`,
            ]);
        } else {
            term.stop();
        }
    }

    #print(text: string, stream: 'stdout' | 'stderr' = 'stdout') {
        term.write(stream, `${text}\n`);
    }
}

/**
 * Hosts that have visible tasks to apply.
 */
function activeHosts(apply: ApplyState): HostProgress[] {
    return [...apply.hosts.values()].filter((host) => host.total > 0);
}

function bar(done: number, total: number, c: Colorizer): string {
    const width = 16;
    const filled = total === 0 ? width : Math.round((done / total) * width);
    return c.green('━'.repeat(filled)) + c.dim('─'.repeat(width - filled));
}

function indent(text: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    return text
        .split('\n')
        .map((line) => pad + line)
        .join('\n');
}

/**
 * First line of text, then the rest indented under it.
 */
function indented(text: string, color: (s: string) => string): string {
    const [first, ...rest] = text.split('\n');
    return [color(first ?? ''), ...rest.map((line) => `    ${line}`)].join(
        '\n',
    );
}

/**
 * Progress as newline-delimited JSON, one event per line.
 */
class JsonReporter implements Reporter {
    #startTimes = new Map<string, number>();

    startConnect() {}

    connection(event: ConnectionEvent) {
        if (event.type === 'ready') {
            return;
        }
        const base = { type: 'connection', host: event.host.id };
        switch (event.type) {
            case 'started':
            case 'authenticated':
                emit({ ...base, status: event.type });
                break;
            case 'prompt':
                emit({ ...base, status: 'prompt', prompt: event.prompt });
                break;
            case 'message':
                emit({ ...base, status: 'message', message: event.message });
                break;
            case 'completed':
                emit({
                    ...base,
                    status:
                        event.status === 'done' ? 'connected' : event.status,
                    error:
                        event.status === 'error'
                            ? formatError(event.error)
                            : undefined,
                });
                break;
        }
    }

    status() {}

    notice(text: string) {
        emit({ type: 'notice', message: text });
    }

    startApply() {}

    task(event: Event) {
        const now = performance.now();
        if (event.type === 'started') {
            this.#startTimes.set(event.taskId, now);
        }
        const started = this.#startTimes.get(event.taskId);
        emit({
            type: 'task',
            host: event.host.id,
            task: event.taskId,
            status: event.status,
            error: event.error,
            durationMs:
                event.type === 'completed' && started !== undefined
                    ? Math.round(now - started)
                    : undefined,
        });
    }

    finishApply() {}
}

function emit(payload: unknown) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}
