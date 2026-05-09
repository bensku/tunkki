import type { TagSet } from './common/task';
import * as builder from './local/builder';
import { runCli } from './local/cli';
import { Connection } from './local/connection';
import * as runner from './local/runner';
import { filterTasks, type Task } from './local/task';
import type { Connector } from './protocol';

export * as protocols from './protocol';
export * as podman from './task/podman';
export * as systemd from './task/systemd';

/**
 * Groups tasks together. Tasks inside a group get then group's id as prefix
 * to their own ids. The group handler may also select which outputs to expose
 * for other code.
 * @param id Globally unique group id.
 * @param handler Callback that creates tasks inside the group.
 * @returns Outputs of handler, if any.
 */
export async function group<T>(
    id: string,
    handler: () => Promise<T> | T,
): Promise<T> {
    builder.pushId(id);
    const outputs = await handler();
    builder.popId();
    return outputs;
}

/**
 * Constrains tasks to be only applied on select hosts.
 * @param targets Tags or host id that the tasks should be applied to.
 * If multiple tags are given, OR semantics are used. Globbing is supported
 * for tag values.
 * @param handler Callback that creates the tasks.
 * @returns Outputs of handler, if any.
 */
export async function on<T>(
    targets: TagSet | string,
    handler: () => Promise<T> | T,
): Promise<T> {
    builder.pushTargets(
        typeof targets === 'string' ? { host: targets } : targets,
    );
    const outputs = await handler();
    builder.popTargets();
    return outputs;
}

export interface Host {
    id: string;
    conn: Connector;
    tags?: TagSet;
}

export async function connect(hosts: Host[]): Promise<TargetPool> {
    // Load tasks for each host
    const tasks: Map<string, Task[]> = new Map();
    for (const host of hosts) {
        tasks.set(
            host.id,
            filterTasks(builder.tasks, { ...host.tags, host: host.id }),
        );
    }

    // Attempt to connect to hosts
    const attempts = await Promise.allSettled(
        hosts.map((host) => host.conn.connect()),
    );
    const failures = attempts
        .filter((conn) => conn.status === 'rejected')
        .map((conn) => conn.reason);
    const successes = attempts
        .filter((conn) => conn.status === 'fulfilled')
        .map((conn) => conn.value);
    if (failures.length > 0) {
        // On failure, close the successful connections before erroring!
        for (const conn of successes) {
            conn.close();
        }
        throw new AggregateError(failures, 'connecting to hosts failed');
    }
    // biome-ignore lint/style/noNonNullAssertion: there are no failures, indices in successes are same as indices in hosts
    const conns = successes.map((conn, i) => new Connection(conn, hosts[i]!));
    return new TargetPool(conns, tasks);
}

export type Plan = runner.Plan;

export type Event = runner.Event;

export interface Result {
    /**
     * Id of host that was deployed to.
     */
    host: string;
    completed: string[];
    skipped: string[];
    errored: {
        taskId: string;
        error: string;
    }[];
}

async function* mergeAsync<T>(gens: AsyncGenerator<T>[]): AsyncGenerator<T> {
    const next = (g: AsyncGenerator<T>, i: number) =>
        g.next().then((r) => ({ g, i, r }));
    const pending = new Map(gens.map((g, i) => [i, next(g, i)]));
    while (pending.size) {
        const { g, i, r } = await Promise.race(pending.values());
        if (r.done) {
            pending.delete(i);
        } else {
            yield r.value;
            pending.set(i, next(g, i));
        }
    }
}

export class TargetPool {
    #conns: Connection[];
    #stage = 0;
    #hostTasks: Map<string, Task[]>;

    constructor(conns: Connection[], hostTasks: Map<string, Task[]>) {
        this.#conns = conns;
        this.#hostTasks = hostTasks;
    }

    async plan(stack: string, destroy?: boolean): Promise<Plan[]> {
        if (this.#stage > 0) {
            throw new Error('already planned');
        }
        this.#stage = 1;
        return await Promise.all(
            this.#conns.map((conn) =>
                runner.plan(
                    stack,
                    conn,
                    destroy ? [] : (this.#hostTasks.get(conn.host.id) ?? []),
                ),
            ),
        );
    }

    async execute(
        plans: Plan[],
        callback?: (event: Event) => void,
    ): Promise<Result[]> {
        if (this.#stage < 1) {
            throw new Error('not yet planned');
        }
        if (this.#stage > 1) {
            throw new Error('already executed');
        }
        this.#stage = 2;

        // Execute normal tasks in parallel
        // First connection also starts rolling tasks
        const generators = plans.map((plan) => {
            const conn = this.#conns.find((conn) => conn.host === plan.host)!;
            const tasks = this.#hostTasks.get(plan.host.id) ?? [];

            // Figure out which tasks we should tell remote to execute
            const existing: Set<string> = new Set();
            tasks.forEach((task) => void existing.add(task.id));

            const changed: Set<string> = new Set();
            plan.created.forEach((entry) => void changed.add(entry));
            plan.updated.forEach((entry) => void changed.add(entry.id));
            plan.deleted.forEach((entry) => {
                // If task does not exist locally, create one with dummy data
                // Remote has the old real state available for cleanup
                if (!existing.has(entry.id)) {
                    tasks.push({
                        id: entry.id,
                        type: '$delete',
                        applyOn: {},
                        state: undefined,
                    });
                }
                changed.add(entry.id);
            });
            const changedTasks = tasks.filter((task) => changed.has(task.id));

            return runner.execute(conn, changedTasks, this.#conns[0] === conn);
        });

        const rollToNext = (prev: Host, id: string) => {
            // Start task on next connection!
            const idx = this.#conns.findIndex((conn) => conn.host === prev);
            const next = this.#conns[idx + 1];
            if (next) {
                next.sendToSelf({
                    type: 'run',
                    id,
                    // Neither step or state are actually used by runner
                    step: -1,
                    state: undefined,
                });
            }
        };

        // Collect per-host results and start rolling tasks as they complete in previous hosts
        const byHost = new Map<string, Result>(
            plans.map((plan) => [
                plan.host.id,
                {
                    host: plan.host.id,
                    completed: [],
                    skipped: [],
                    errored: [],
                },
            ]),
        );
        for await (const event of mergeAsync(generators)) {
            callback?.(event);
            switch (event.type) {
                case 'completed': {
                    const result = byHost.get(event.host.id);
                    if (!result) {
                        throw new Error(
                            `unknown host in event: ${event.host.id}`,
                        );
                    }
                    switch (event.status) {
                        case 'done':
                            result.completed.push(event.taskId);
                            break;
                        case 'skipped':
                            result.skipped.push(event.taskId);
                            break;
                        case 'error':
                            result.errored.push({
                                taskId: event.taskId,
                                error: event.error ?? 'unknown',
                            });
                            break;
                    }
                    break;
                }
                case 'hostCompleted': {
                    // Rolling task finished on one host, put it to next one
                    // FIXME currently even if there is an error, what could go wrong?
                    rollToNext(event.host, event.taskId);
                    break;
                }
            }
        }

        return [...byHost.values()];
    }

    async close(): Promise<void> {
        await Promise.allSettled(this.#conns.map((conn) => conn.close()));
    }
}

/**
 * Plan, apply, destroy, list tasks, or install the agent — driven by CLI
 * subcommands read from `Bun.argv`. This is the entry point a user's
 * deployment script calls. To inspect and apply plans programmatically,
 * use the lower-level `connect()` / `TargetPool` directly instead.
 * @param stack Stack to apply tasks in.
 * @param hosts List of hosts.
 */
export async function deploy(stack: string, hosts: Host[]): Promise<void> {
    await runCli(stack, hosts);
}
