import type { TagSet } from './common/task';
import * as builder from './local/builder';
import { getCliOptions } from './local/cli';
import { Connection } from './local/connection';
import { execute, plan } from './local/runner';
import { filterTasks, type Task } from './local/task';
import type { Connector } from './protocol';

export * as protocols from './protocol';
export * as podman from './task/podman';

export async function group(
    id: string,
    handler: () => Promise<void> | void,
): Promise<void> {
    builder.pushId(id);
    await handler();
    builder.popId();
}

export async function on(
    targets: TagSet | string,
    handler: () => Promise<void> | void,
): Promise<void> {
    builder.pushTargets(
        typeof targets === 'string' ? { host: targets } : targets,
    );
    await handler();
    builder.popTargets();
}

export async function sequential(
    handler: () => Promise<void> | void,
): Promise<void> {
    builder.beginSequential();
    await handler();
    builder.endSequential();
}

export interface Host {
    id: string;
    conn: Connector;
    tags?: TagSet;
}

export function hosts(hosts: Host[]): void {
    builder.hosts.push(...hosts);
}

export interface DeployOptions {
    /**
     * Enable interactive mode, in which Tunkki parses CLI arguments, presents
     * plan to the user and (if approved) deploys it.
     */
    interactive?: boolean;

    mode?: 'printTasks' | 'installAgent' | 'plan' | 'apply';

    debug?: boolean;
}

export async function deploy(options: DeployOptions) {
    if (options.interactive !== false) {
        options.interactive = true;
    }
    if (options.interactive) {
        // In interactive mode, allow CLI options to override options
        options = { ...options, ...getCliOptions(Bun.argv) };
    }

    const mode = options.mode ?? 'plan';

    const allTasks = builder.tasks;
    const hosts = builder.hosts;

    // Filter tasks to the hosts
    const tasks: Map<string, Task[]> = new Map();
    for (const host of hosts) {
        tasks.set(
            host.id,
            filterTasks(allTasks, { ...host.tags, host: host.id }),
        );
    }

    if (mode === 'printTasks') {
        console.log(tasks); // TODO better UI
        return;
    } else if (mode === 'installAgent') {
        for (const host of hosts) {
            const result = await host.conn.upload(
                `${import.meta.dir}/tunkki`,
                '/opt/tunkki/tunkki',
            );
            if (!result) {
                console.error(
                    `Transport for ${host.id} does not support installAgent`,
                );
            }
        }
        return;
    }

    // Connect to hosts. Use allSettled so a single failed connect doesn't
    // strand the connections we did open.
    if (options.interactive) {
        console.log(`Connecting to hosts ${hosts.map((host) => host.id)}...`);
    }
    const settled = await Promise.allSettled(
        hosts.map((host) => host.conn.connect()),
    );
    const targets: { conn: Connection; hostTasks: Task[] }[] = [];
    const connectFailures: unknown[] = [];
    for (const [i, result] of settled.entries()) {
        const host = hosts[i]!;
        if (result.status === 'fulfilled') {
            if (options.interactive) {
                console.log('Connected to', host.id);
            }
            targets.push({
                conn: new Connection(result.value, host),
                hostTasks: tasks.get(host.id)!,
            });
        } else {
            connectFailures.push(result.reason);
        }
    }

    try {
        if (connectFailures.length > 0) {
            throw new AggregateError(
                connectFailures,
                'failed to connect to one or more hosts',
            );
        }
        console.log('Planning...');
        const planned = await Promise.all(
            targets.map(async ({ conn, hostTasks }) => ({
                conn,
                hostTasks,
                plan: await plan(conn, hostTasks, { debug: options.debug }),
            })),
        );
        console.log(planned.map((p) => p.plan));

        console.log('Applying...');
        await Promise.all(
            planned.map(({ conn, hostTasks, plan }) => {
                // Get new and changed tasks...
                const tasks = hostTasks.filter(
                    (t) => !plan.unchanged.includes(t.id),
                );
                // and add deleted ones from the plan
                for (const deleted of plan.deleted) {
                    // Remove has old state of the task and will use it to actually perform deletion
                    tasks.push({
                        id: deleted.id,
                        type: '$delete',
                        applyOn: {},
                        state: undefined,
                    });
                }
                return execute(conn, tasks);
            }),
        );
        console.log('Plan successfully applied.');
    } finally {
        console.log('Closing connections...');
        await Promise.allSettled(targets.map(({ conn }) => conn.close()));
    }
}
