import { log } from './common/log';
import type { TagSet } from './common/task';
import { applyPlan, type Result, type TaskEvent } from './local/apply';
import * as builder from './local/builder';
import { runCli } from './local/cli';
import { Connection } from './local/connection';
import { fetchState, makePlan, type Plan, type PlanMode } from './local/plan';
import type { Connector } from './protocol';

export * as protocols from './protocol';
export * as files from './task/files';
export * as nebula from './task/nebula';
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
 * Adds a set of tasks for a future deployment.
 * @param targets A set of tags that hosts must have for these tasks to be
 * deployed on them.
 * @param handler Handler that should add the tasks.
 * @param rolling Whether or not this set of tasks should receive a rolling
 * deployment. By default, the tasks are applied host-by-host. If set to
 * false, all tasks are applied in parallel, improving performance.
 */
export function on(
    targets: TagSet | string,
    handler: (host: Host) => Promise<void> | void,
    rolling: boolean = true,
): void {
    const targetTags =
        typeof targets === 'string' ? { host: targets } : targets;
    builder.addSource(async (host) => {
        const hostTags: TagSet = { ...host.tags, host: host.id };
        // If we have even one of requested tags, run handler for this host
        // Handler code can do more complicated host selection logic if it wishes to
        const shouldApply = Object.entries(targetTags).some(
            ([tag, value]) =>
                hostTags[tag] && new Bun.Glob(value).match(hostTags[tag]),
        );
        log.debug('load source', 'host', host.id, 'apply', shouldApply);
        if (!shouldApply) {
            return [];
        }
        const startIdx = builder.enterHost(host.id);
        try {
            await handler(host);
        } finally {
            builder.exitHost();
        }
        return builder.tasks.slice(startIdx).map((task) => task.id);
    }, rolling);
}

export interface Host {
    id: string;
    conn: Connector;
    tags?: TagSet;
}

export type ConnectionEvent =
    | {
          type: 'ready';
      }
    | {
          host: Host;
          type: 'started';
      }
    | {
          host: Host;
          type: 'completed';
          status: 'done';
      }
    | {
          host: Host;
          type: 'completed';
          status: 'error';
          error: unknown;
      };

/**
 * Connects to agents on remote hosts.
 */
export async function connect(
    hosts: Host[],
    callback?: (event: ConnectionEvent) => void,
): Promise<TargetPool> {
    const attempts = await Promise.allSettled(
        hosts.map(async (host) => {
            callback?.({ host, type: 'started' });
            let conn: Connection | undefined;
            try {
                conn = new Connection(await host.conn.connect(), host);
                await conn.handshake();
            } catch (error) {
                await conn?.close();
                callback?.({
                    host,
                    type: 'completed',
                    status: 'error',
                    error,
                });
                throw error;
            }
            callback?.({ host, type: 'completed', status: 'done' });
            return conn;
        }),
    );
    const failures = attempts
        .filter((conn) => conn.status === 'rejected')
        .map((conn) => conn.reason);
    const conns = attempts
        .filter((conn) => conn.status === 'fulfilled')
        .map((conn) => conn.value);
    if (failures.length > 0) {
        // On failure, close the successful connections before erroring!
        await Promise.allSettled(conns.map((conn) => conn.close()));
        throw new AggregateError(failures, 'connecting to hosts failed');
    }
    callback?.({ type: 'ready' });
    return new TargetPool(conns);
}

export type { Result, TaskEvent as Event } from './local/apply';
export type { Plan, PlanMode } from './local/plan';

export class TargetPool {
    #conns: Connection[];

    constructor(conns: Connection[]) {
        this.#conns = conns;
    }

    /**
     * Plans changes to a stack on all connected hosts.
     * @param stack Stack name.
     * @param mode Unless destroying, tasks are loaded from sources added
     * with on().
     */
    async plan(stack: string, mode: PlanMode = 'apply'): Promise<Plan> {
        const hosts = this.#conns.map((conn) => conn.host);
        if (mode !== 'destroy') {
            log.info('loading deployment tasks', 'hosts', hosts.length);
            await builder.loadTasks(hosts);
        }
        log.info('planning', 'stack', stack, 'mode', mode);
        const states = await Promise.all(
            this.#conns.map((conn) => fetchState(conn, stack)),
        );
        return makePlan({
            stack,
            mode,
            tasks: builder.tasks,
            rollingBlocks: builder.rollingBlocks,
            hosts: states,
        });
    }

    /**
     * Applies a plan, made by plan() now or earlier.
     * @param plan Plan to apply. All of its hosts must be connected.
     * @param callback Receives progress events.
     * @returns Results by host.
     */
    async execute(
        plan: Plan,
        callback?: (event: TaskEvent) => void,
    ): Promise<Result[]> {
        const conns = Object.keys(plan.hosts).map((host) => {
            const conn = this.#conns.find((conn) => conn.host.id === host);
            if (!conn) {
                throw new Error(`host ${host} in the plan is not connected`);
            }
            return conn;
        });
        return applyPlan(plan, conns, callback);
    }

    async close(): Promise<void> {
        await Promise.allSettled(this.#conns.map((conn) => conn.close()));
    }
}

/**
 * Plan, apply, destroy, list tasks, or install the agent - depending on CLI
 * arguments. If you just want to deploy things with tunkki CLI, this is almost
 * certainly what you want.
 *
 * For more fine-grained deployment automation, use `connect()` and the
 * `TargetPool` APIs by hand.
 * @param stack Stack to apply tasks in.
 * @param hosts List of hosts.
 */
export async function deploy(stack: string, hosts: Host[]): Promise<void> {
    await runCli(stack, hosts);
}
