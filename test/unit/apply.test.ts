import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { connect, type Host, on, type PlanMode } from '../..';
import * as builder from '../../local/builder';
import { combine, taskType } from '../../task';
import { fakeHost, readState, writeState } from './fake-host';
import type { TestState } from './fixtures/log';

const basic = taskType<TestState, unknown, { value: unknown }>(
    'test.basic',
    import.meta.resolve('./fixtures/basic'),
);
const other = taskType<TestState, unknown>(
    'test.other',
    import.meta.resolve('./fixtures/other'),
);
const multi = taskType<TestState, unknown>(
    'test.multi',
    import.meta.resolve('./fixtures/multi'),
);
const broken = taskType<TestState, unknown>(
    'test.broken',
    import.meta.resolve('./fixtures/broken'),
);
const history = taskType<TestState, unknown>(
    'test.history',
    import.meta.resolve('./fixtures/history'),
);

declare global {
    var applyTest: { calls: string[] };
}

let dir: string;
let hosts: Host[];

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-apply-'));
    hosts = [fakeHost('h1', dir), fakeHost('h2', dir)];
    globalThis.applyTest = { calls: [] };
});

afterEach(async () => {
    builder.clearAll();
    await fs.rm(dir, { recursive: true });
});

/**
 * Defines tasks, then plans and applies them.
 * @returns Plan, results and handler calls made while applying.
 */
async function deploy(define: () => void, mode: PlanMode = 'apply') {
    builder.clearAll();
    define();
    const pool = await connect(hosts);
    try {
        const plan = await pool.plan('prod', mode);
        globalThis.applyTest.calls = [];
        const results = await pool.execute(plan);
        return { plan, results, calls: globalThis.applyTest.calls };
    } finally {
        await pool.close();
    }
}

function resultOf(
    results: Awaited<ReturnType<typeof deploy>>['results'],
    host: string,
) {
    return results.find((result) => result.host === host);
}

describe('apply', () => {
    test('creates, then does nothing without changes', async () => {
        const define = () =>
            on('h1', () => {
                basic('a', { name: 'a', value: 1 });
            });
        const first = await deploy(define);
        expect(first.calls).toEqual(['basic:apply:a']);
        expect(await readState(dir, 'h1', 'prod')).toEqual({
            'h1.a': {
                handler: 'test.basic',
                state: { name: 'a', value: 1 },
                output: { value: 1 },
                deps: [],
            },
        });

        const second = await deploy(define);
        expect(second.plan.unchanged).toEqual(['h1.a']);
        expect(second.calls).toEqual([]);
        expect(resultOf(second.results, 'h1')).toMatchObject({
            completed: [],
            unchanged: [],
        });
    });

    test('maybe-changed tasks that turn out unchanged send nothing', async () => {
        const define = (value: number) => () =>
            on('h1', () => {
                const a = basic('a', { name: 'a', value });
                basic('b', { name: 'b' }, { dependencies: [a.id] });
            });
        await deploy(define(1));
        const second = await deploy(define(2));
        expect(second.plan.uncertain).toEqual(['h1.b']);
        expect(second.calls).toEqual(['basic:apply:a']);
        expect(resultOf(second.results, 'h1')?.unchanged).toEqual(['h1.b']);
    });

    test('reapplyOnDepChange runs when a dep was applied', async () => {
        const define = (value: number) => () =>
            on('h1', () => {
                const a = basic('a', { name: 'a', value });
                basic(
                    'b',
                    { name: 'b' },
                    { dependencies: [a.id], requireReapply: true },
                );
            });
        await deploy(define(1));
        const second = await deploy(define(2));
        expect(second.calls).toEqual(['basic:apply:a', 'basic:apply:b']);
    });

    test('reapplyOnDepChange passes through combine', async () => {
        const pair = combine<TestState, unknown>((state, opts) => {
            const first = basic('first', state, opts);
            basic('second', { name: 'second' }, { dependencies: [first.id] });
        });
        const define = (value: number) => () =>
            on('h1', () => {
                const p = pair('pair', { name: 'first', value });
                basic(
                    'svc',
                    { name: 'svc' },
                    { dependencies: [p.id], requireReapply: true },
                );
            });
        await deploy(define(1));

        const unchanged = await deploy(define(1));
        expect(unchanged.calls).toEqual([]);

        const changed = await deploy(define(2));
        expect(changed.calls).toEqual(['basic:apply:first', 'basic:apply:svc']);
    });

    test('outputs are used on the same host and across hosts', async () => {
        await deploy(() => {
            let a: ReturnType<typeof basic> | undefined;
            on('h1', () => {
                a = basic('a', { name: 'a', value: 80 });
                basic('b', { name: 'b', value: a.outputs.value });
            });
            on('h2', () => {
                basic('c', { name: 'c', value: `port ${a?.outputs.value}` });
            });
        });
        expect((await readState(dir, 'h1', 'prod'))['h1.b']).toMatchObject({
            state: { name: 'b', value: 80 },
            deps: ['h1.a'],
        });
        expect((await readState(dir, 'h2', 'prod'))['h2.c']).toMatchObject({
            state: { name: 'c', value: 'port 80' },
            deps: ['h1.a'],
        });
    });

    test('unresolved outputs fail the task', async () => {
        const { results } = await deploy(() =>
            on('h1', () => {
                const a = basic('a', { name: 'a' });
                const outputs = a.outputs as unknown as Record<string, unknown>;
                basic('b', { name: 'b', value: outputs.missing });
            }),
        );
        expect(resultOf(results, 'h1')?.errored).toEqual([
            {
                taskId: 'h1.b',
                error: expect.stringContaining(
                    'unresolved outputs: $tunkki{h1.a/missing}',
                ),
            },
        ]);
    });

    test('type changes clean up with the old handler first', async () => {
        await deploy(() =>
            on('h1', () => {
                basic('x', { name: 'x' });
            }),
        );
        const { calls } = await deploy(() =>
            on('h1', () => {
                other('x', { name: 'x' });
            }),
        );
        expect(calls).toEqual(['basic:cleanup:x', 'other:apply:x']);
    });

    test('deletes after their old dependents, and before creates', async () => {
        await deploy(() =>
            on('h1', () => {
                const base = basic('base', { name: 'base' });
                basic('user', { name: 'user' }, { dependencies: [base.id] });
                basic('old', { name: 'old' });
            }),
        );
        const { calls } = await deploy(() =>
            on('h1', () => {
                basic('user', { name: 'user', value: 'no base' });
                basic('new', { name: 'new' });
            }),
        );
        expect(calls.indexOf('basic:apply:user')).toBeLessThan(
            calls.indexOf('basic:cleanup:base'),
        );
        expect(calls.indexOf('basic:cleanup:old')).toBeLessThan(
            calls.indexOf('basic:apply:new'),
        );
    });

    test('local steps get the host and old state', async () => {
        await deploy(() =>
            on('h1', () => {
                multi('m', { name: 'm', value: 1 });
            }),
        );
        await deploy(() =>
            on('h1', () => {
                multi('m', { name: 'm', value: 2 });
            }),
        );
        expect((await readState(dir, 'h1', 'prod'))['h1.m']?.output).toEqual({
            host: 'h1',
            old: 1,
        });
    });

    test('steps and cleanup get the old output', async () => {
        const define = (value: number) => () =>
            on('h1', () => {
                history('h', { name: 'h', value });
            });
        expect((await deploy(define(1))).calls).toEqual([
            'history:local:h:none',
            'history:remote:h:none',
        ]);
        expect((await deploy(define(2))).calls).toEqual([
            'history:local:h:{"value":1}',
            'history:remote:h:{"value":1}',
        ]);
        expect((await deploy(() => {})).calls).toEqual([
            'history:cleanup:h:{"value":2}',
        ]);
    });

    test('replaced tasks get no old output', async () => {
        await deploy(() =>
            on('h1', () => {
                basic('x', { name: 'x', value: 1 });
            }),
        );
        const { calls } = await deploy(() =>
            on('h1', () => {
                history('x', { name: 'x', value: 2 });
            }),
        );
        expect(calls).toEqual([
            'basic:cleanup:x',
            'history:local:x:none',
            'history:remote:x:none',
        ]);
    });

    test('failed steps are not committed and retry next time', async () => {
        const define = () =>
            on('h1', () => {
                multi('m', { name: 'm', fail: true });
            });
        const { results } = await deploy(define);
        expect(resultOf(results, 'h1')?.errored[0]?.error).toContain(
            'm failed',
        );
        expect(await readState(dir, 'h1', 'prod')).toEqual({});

        const retry = await deploy(define);
        expect(retry.plan.created).toEqual(['h1.m']);
    });

    test('nothing returned by a step that is not last fails the task', async () => {
        const { results } = await deploy(() =>
            on('h1', () => {
                broken('b', { name: 'b' });
            }),
        );
        expect(resultOf(results, 'h1')?.errored[0]?.error).toContain(
            'step 0 returned nothing',
        );
    });

    test('failure halts a rolling block', async () => {
        const { results, calls } = await deploy(() =>
            on('*', (host) => {
                basic('x', { name: host.id, fail: host.id === 'h1' });
            }),
        );
        expect(calls).toEqual(['basic:apply:h1']);
        expect(resultOf(results, 'h2')?.skipped).toEqual(['h2.x']);
    });

    test('rolling blocks wait for the previous host', async () => {
        const { calls } = await deploy(() =>
            on('*', (host) => {
                basic('a', { name: `${host.id}.a` });
                basic('b', { name: `${host.id}.b` });
            }),
        );
        expect(calls.slice(2).sort()).toEqual([
            'basic:apply:h2.a',
            'basic:apply:h2.b',
        ]);
    });

    test('stale plans are rejected', async () => {
        builder.clearAll();
        on('h1', () => {
            basic('a', { name: 'a' });
        });
        const pool = await connect(hosts);
        try {
            const stale = await pool.plan('prod', 'apply');
            await pool.execute(await pool.plan('prod', 'apply'));
            expect(pool.execute(stale)).rejects.toThrow(
                /failed to start applying/,
            );
        } finally {
            await pool.close();
        }
        expect(globalThis.applyTest.calls).toEqual(['basic:apply:a']);
    });

    test('old records get deps without running anything', async () => {
        await writeState(dir, 'h1', 'prod', {
            'h1.a': { handler: 'test.basic', state: { name: 'a' } },
            'h1.b': { handler: 'test.basic', state: { name: 'b' } },
            'h1.b-end': { handler: '$noop', state: {} },
        });
        const { calls } = await deploy(() =>
            on('h1', () => {
                const a = basic('a', { name: 'a' });
                basic('b', { name: 'b' }, { dependencies: [a.id] });
            }),
        );
        expect(calls).toEqual([]);
        expect(await readState(dir, 'h1', 'prod')).toEqual({
            'h1.a': { handler: 'test.basic', state: { name: 'a' } },
            'h1.b': {
                handler: 'test.basic',
                state: { name: 'b' },
                deps: ['h1.a'],
            },
        });
    });

    test('destroy cleans up in reverse dependency order', async () => {
        const define = () =>
            on('h1', () => {
                const a = basic('a', { name: 'a' });
                basic('b', { name: 'b' }, { dependencies: [a.id] });
            });
        await deploy(define);
        const { calls } = await deploy(define, 'destroy');
        expect(calls).toEqual(['basic:cleanup:b', 'basic:cleanup:a']);
        expect(await readState(dir, 'h1', 'prod')).toEqual({});
    });
});
