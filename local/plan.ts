import { deserialize, serialize } from 'bun:jsc';
import * as fs from 'node:fs/promises';
import type { StateFile, TaskRecord } from '../common/event';
import { log } from '../common/log';
import type { Connection } from './connection';
import { findRefs, substituteState } from './outputs';
import { isRegistered, type Task } from './task';

export type PlanMode = 'apply' | 'reapply' | 'destroy';

export interface Plan {
    version: 1;
    stack: string;
    mode: PlanMode;
    hosts: Record<string, { stateHash: string }>;

    created: string[];
    /**
     * Input differs from the stored one.
     */
    updated: string[];

    /**
     * Not changed itself, but a dependency change might require reapply.
     */
    uncertain: string[];

    /**
     * Task type changed: cleaned up with the old handler, then applied with
     * the new one.
     */
    replaced: string[];

    /**
     * Tasks that are no longer present in new desired state.
     */
    deleted: string[];

    /**
     * Tasks that we know for sure did not change.
     */
    unchanged: string[];

    /**
     * Unchanged tasks whose records are to be rewritten without rerunning anything.
     */
    refresh: string[];

    /**
     * Stored records of all hosts.
     */
    old: Record<string, TaskRecord>;

    /**
     * All tasks, including deleted ones.
     */
    nodes: Record<string, Node>;

    barriers: Barrier[];
}

export interface Node {
    task: Task;

    /**
     * Tasks that must finish before this one starts.
     */
    after: string[];

    /**
     * Tasks that have this one in their after.
     */
    dependents: string[];
}

/**
 * Blocked tasks start once every task in wait has finished. If one of them
 * fails, blocked tasks are skipped.
 */
export interface Barrier {
    wait: string[];
    blocked: string[];
}

/**
 * State of one host, as returned by its remote.
 */
export interface HostState {
    host: string;
    tasks: StateFile;
    stateHash: string;
}

export interface PlanInput {
    stack: string;
    mode: PlanMode;
    tasks: Task[];
    rollingBlocks: string[][][];
    hosts: HostState[];
}

/**
 * Requests the stored state of a stack from a remote.
 */
export async function fetchState(
    conn: Connection,
    stack: string,
): Promise<HostState> {
    await conn.send({ type: 'plan', stack });
    const result = await conn.next();
    if (result.type !== 'planResult' || result.stack !== stack) {
        throw new Error(
            `host ${conn.host.id} sent unexpected event ${result.type}`,
        );
    } else if (result.error) {
        throw new Error(
            `host ${conn.host.id} failed to read state: ${result.error}`,
        );
    }
    return {
        host: conn.host.id,
        tasks: result.tasks,
        stateHash: result.stateHash,
    };
}

/**
 * Plans how to get from the stored state of hosts to the given tasks.
 */
export function makePlan(input: PlanInput): Plan {
    const tasks = input.mode === 'destroy' ? [] : input.tasks;
    const old: Record<string, TaskRecord> = {};
    const oldHost: Record<string, string> = {};
    for (const { host, tasks: records } of input.hosts) {
        for (const [id, record] of Object.entries(records)) {
            if (oldHost[id]) {
                throw new Error(
                    `task ${id} is stored on both ${oldHost[id]} and ${host}`,
                );
            }
            old[id] = record;
            oldHost[id] = host;
        }
    }

    const diff = diffTasks(tasks, old, input.mode);
    const nodes: Record<string, Node> = {};
    for (const task of tasks) {
        nodes[task.id] = { task, after: [...task.deps], dependents: [] };
    }
    for (const id of diff.deleted) {
        const record = old[id] as TaskRecord;
        nodes[id] = {
            task: {
                id,
                host: oldHost[id] as string,
                type: record.handler,
                state: record.state,
                deps: record.deps ?? [],
                requireReapply: false,
            },
            after: [],
            dependents: [],
        };
    }

    const barriers = orderDeletes(diff, nodes, old);
    for (const block of input.rollingBlocks) {
        for (let i = 1; i < block.length; i++) {
            barriers.push({
                wait: block[i - 1] as string[],
                blocked: block[i] as string[],
            });
        }
    }

    for (const node of Object.values(nodes)) {
        for (const id of node.after) {
            nodes[id]?.dependents.push(node.task.id);
        }
    }
    const maybe = cascade(diff, nodes);
    checkCycles(nodes, barriers);
    checkHandlers(diff, nodes, old);

    const unchanged = diff.unchanged.filter((id) => !maybe.includes(id));
    return {
        version: 1,
        stack: input.stack,
        mode: input.mode,
        hosts: Object.fromEntries(
            input.hosts.map((host) => [
                host.host,
                { stateHash: host.stateHash },
            ]),
        ),
        ...diff,
        uncertain: maybe,
        unchanged,
        refresh: unchanged.filter(
            (id) => !sameIds(old[id]?.deps ?? [], nodes[id]?.task.deps ?? []),
        ),
        old,
        nodes,
        barriers,
    };
}

/**
 * Converts a value to what it would be after storing as JSON.
 */
export function toJson(value: unknown): unknown {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

interface Diff {
    created: string[];
    updated: string[];
    replaced: string[];
    deleted: string[];
    unchanged: string[];
}

/**
 * Compares tasks to stored records, without cascading changes.
 */
export function diffTasks(
    tasks: Task[],
    old: Record<string, TaskRecord>,
    mode: PlanMode,
): Diff {
    const diff: Diff = {
        created: [],
        updated: [],
        replaced: [],
        deleted: [],
        unchanged: [],
    };
    const ids = new Set(tasks.map((task) => task.id));
    const oldOutput = (id: string) => old[id]?.output;
    for (const task of tasks) {
        const record = old[task.id];
        if (!record) {
            diff.created.push(task.id);
        } else if (record.handler !== task.type) {
            diff.replaced.push(task.id);
        } else if (mode === 'reapply') {
            diff.updated.push(task.id);
        } else {
            const input = substituteState(task.state, oldOutput);
            const changed =
                input.unresolved.length > 0 ||
                !Bun.deepEquals(toJson(input.value), record.state);
            (changed ? diff.updated : diff.unchanged).push(task.id);
        }
    }

    // Tasks stored by old versions have no outputs. If something uses them,
    // the task must run to produce one.
    for (const task of tasks) {
        for (const ref of findRefs(task.state)) {
            const index = diff.unchanged.indexOf(ref.id);
            if (index !== -1 && old[ref.id]?.output === undefined) {
                diff.unchanged.splice(index, 1);
                diff.updated.push(ref.id);
            }
        }
    }

    diff.deleted = Object.keys(old).filter((id) => !ids.has(id));
    return diff;
}

/**
 * Adds ordering for deleted tasks.
 * @returns Barriers that delete tasks before other changes on their hosts.
 */
function orderDeletes(
    diff: Diff,
    nodes: Record<string, Node>,
    old: Record<string, TaskRecord>,
): Barrier[] {
    const oldDependents: Record<string, string[]> = {};
    for (const [id, record] of Object.entries(old)) {
        for (const dep of record.deps ?? []) {
            oldDependents[dep] ??= [];
            oldDependents[dep].push(id);
        }
    }
    const deleted = new Set(diff.deleted);

    const unordered: Record<string, string[]> = {};
    for (const id of diff.deleted) {
        const node = nodes[id] as Node;

        // Kept tasks that used this one stop using it before it goes away
        const keptDependents = new Set<string>();
        const seen = new Set<string>();
        const visit = (current: string) => {
            for (const dependent of oldDependents[current] ?? []) {
                if (seen.has(dependent)) continue;
                seen.add(dependent);
                if (!deleted.has(dependent) && nodes[dependent]) {
                    keptDependents.add(dependent);
                }
                visit(dependent);
            }
        };
        visit(id);

        // Deleted tasks that used this one are deleted before it
        const deletedDependents = (oldDependents[id] ?? []).filter((dep) =>
            deleted.has(dep),
        );
        node.after = [...keptDependents, ...deletedDependents];

        if (keptDependents.size === 0) {
            unordered[node.task.host] ??= [];
            unordered[node.task.host]?.push(id);
        }
    }

    // Everything else is deleted before changes on the same host, in case
    // they would conflict (e.g. a renamed task)
    const barriers: Barrier[] = [];
    const changed = [...diff.created, ...diff.updated, ...diff.replaced];
    for (const [host, wait] of Object.entries(unordered)) {
        const blocked = changed.filter((id) => nodes[id]?.task.host === host);
        if (blocked.length > 0) {
            barriers.push({ wait, blocked });
        }
    }
    return barriers;
}

/**
 * Finds tasks that might need to be reapplied because their dependencies changed.
 */
function cascade(diff: Diff, nodes: Record<string, Node>): string[] {
    const definite = new Set([
        ...diff.created,
        ...diff.updated,
        ...diff.replaced,
        ...diff.deleted,
    ]);
    const maybe = new Set<string>();
    const queue = [...diff.created, ...diff.updated, ...diff.replaced];
    while (queue.length > 0) {
        const id = queue.pop() as string;
        for (const dependent of nodes[id]?.dependents ?? []) {
            if (!definite.has(dependent) && !maybe.has(dependent)) {
                maybe.add(dependent);
                queue.push(dependent);
            }
        }
    }
    return [...maybe];
}

function checkCycles(nodes: Record<string, Node>, barriers: Barrier[]) {
    // Barriers are vertices of their own, so that they don't need an edge
    // from every task in wait to every blocked task
    const edges = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    const addEdge = (from: string, to: string) => {
        edges.set(from, [...(edges.get(from) ?? []), to]);
        indegree.set(to, (indegree.get(to) ?? 0) + 1);
    };
    for (const node of Object.values(nodes)) {
        indegree.set(node.task.id, indegree.get(node.task.id) ?? 0);
        for (const id of node.after) {
            addEdge(id, node.task.id);
        }
    }
    barriers.forEach((barrier, i) => {
        const vertex = `\0barrier${i}`;
        indegree.set(vertex, indegree.get(vertex) ?? 0);
        for (const id of barrier.wait) addEdge(id, vertex);
        for (const id of barrier.blocked) addEdge(vertex, id);
    });

    // Kahn's algorithm: whatever cannot be sorted is in or after a cycle
    const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
    while (queue.length > 0) {
        const id = queue.pop() as string;
        indegree.delete(id);
        for (const next of edges.get(id) ?? []) {
            const n = (indegree.get(next) ?? 0) - 1;
            indegree.set(next, n);
            if (n === 0) queue.push(next);
        }
    }
    const stuck = [...indegree.keys()].filter((id) => nodes[id]);
    if (indegree.size > 0) {
        throw new Error(
            `dependency cycle, possibly through a rolling deployment, among tasks: ${stuck.join(', ')}`,
        );
    }
}

function checkHandlers(
    diff: Diff,
    nodes: Record<string, Node>,
    old: Record<string, TaskRecord>,
) {
    const missing: string[] = [];
    const check = (id: string, type: string) => {
        if (!isRegistered(type)) {
            missing.push(`${id} (${type})`);
        }
    };
    for (const id of [...diff.created, ...diff.updated, ...diff.replaced]) {
        check(id, nodes[id]?.task.type ?? '');
    }
    for (const id of [...diff.replaced, ...diff.deleted]) {
        check(id, old[id]?.handler ?? '');
    }
    if (missing.length > 0) {
        throw new Error(
            `no handler registered for task types of: ${missing.join(', ')}`,
        );
    }
}

function sameIds(a: string[], b: string[]): boolean {
    return Bun.deepEquals([...a].sort(), [...b].sort());
}

interface PlanFileHeader {
    version: number;
    bunVersion: string;
    stack: string;
}

/**
 * Writes a plan to a file.
 */
export async function writePlan(path: string, plan: Plan) {
    const header: PlanFileHeader = {
        version: plan.version,
        bunVersion: Bun.version,
        stack: plan.stack,
    };
    const data = Buffer.concat([
        Buffer.from(`${JSON.stringify(header)}\n`),
        new Uint8Array(serialize(plan)),
    ]);
    // Avoid writing to possibly world-readable file by recreating it
    await fs.rm(path, { force: true });
    await fs.writeFile(path, data, { mode: 0o600 });
    log.info('wrote plan', 'file', path);
}

export async function readPlan(path: string): Promise<Plan> {
    const bytes = await Bun.file(path).bytes();
    const newline = bytes.indexOf(10);
    const header: PlanFileHeader = JSON.parse(
        new TextDecoder().decode(bytes.subarray(0, newline)),
    );
    if (header.version !== 1) {
        throw new Error(
            `plan file has version ${header.version}, but only 1 is supported`,
        );
    } else if (header.bunVersion !== Bun.version) {
        throw new Error(
            `plan file was written by Bun ${header.bunVersion}, but this is Bun ${Bun.version}`,
        );
    }
    return deserialize(bytes.subarray(newline + 1)) as Plan;
}
