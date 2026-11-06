import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StateFile } from '../../common/event';
import {
    makePlan,
    type Plan,
    type PlanMode,
    readPlan,
    writePlan,
} from '../../local/plan';
import { registerHandler, type Task } from '../../local/task';

beforeAll(() => {
    registerHandler('test.a', 'unused');
    registerHandler('test.b', 'unused');
});

function task(id: string, opts: Partial<Task> = {}): Task {
    return {
        id,
        host: id.split('.')[0] as string,
        type: 'test.a',
        state: {},
        deps: [],
        requireReapply: false,
        ...opts,
    };
}

function plan(
    tasks: Task[],
    records: Record<string, StateFile>,
    opts: { mode?: PlanMode; rollingBlocks?: string[][][] } = {},
): Plan {
    const hosts = { h1: {}, h2: {}, ...records };
    return makePlan({
        stack: 'prod',
        mode: opts.mode ?? 'apply',
        tasks,
        rollingBlocks: opts.rollingBlocks ?? [],
        hosts: Object.entries(hosts).map(([host, tasks]) => ({
            host,
            tasks,
            stateHash: `hash-${host}`,
        })),
    });
}

/**
 * Categories of a plan, without empty ones.
 */
function categories(p: Plan) {
    const all = {
        created: p.created,
        updated: p.updated,
        maybe: p.uncertain,
        replaced: p.replaced,
        deleted: p.deleted,
        unchanged: p.unchanged,
        refresh: p.refresh,
    };
    return Object.fromEntries(
        Object.entries(all)
            .filter(([, ids]) => ids.length > 0)
            .map(([key, ids]) => [key, [...ids].sort()]),
    );
}

describe('diff', () => {
    test('categorizes tasks by their records', () => {
        const p = plan(
            [
                task('h1.new'),
                task('h1.same', { state: { v: 1 } }),
                task('h1.changed', { state: { v: 2 } }),
                task('h1.retyped', { type: 'test.b' }),
            ],
            {
                h1: {
                    'h1.same': { handler: 'test.a', state: { v: 1 }, deps: [] },
                    'h1.changed': {
                        handler: 'test.a',
                        state: { v: 1 },
                        deps: [],
                    },
                    'h1.retyped': { handler: 'test.a', state: {}, deps: [] },
                    'h1.gone': { handler: 'test.a', state: {}, deps: [] },
                },
            },
        );
        expect(categories(p)).toEqual({
            created: ['h1.new'],
            updated: ['h1.changed'],
            replaced: ['h1.retyped'],
            deleted: ['h1.gone'],
            unchanged: ['h1.same'],
        });
        expect(p.hosts).toEqual({
            h1: { stateHash: 'hash-h1' },
            h2: { stateHash: 'hash-h2' },
        });
        expect(p.nodes['h1.gone']?.task).toMatchObject({
            host: 'h1',
            type: 'test.a',
        });
    });

    test('compares inputs as stored in JSON', () => {
        const p = plan(
            [task('h1.file', { state: { content: new Uint8Array([7, 8]) } })],
            {
                h1: {
                    'h1.file': {
                        handler: 'test.a',
                        state: { content: { 0: 7, 1: 8 } },
                        deps: [],
                    },
                },
            },
        );
        expect(categories(p)).toEqual({ unchanged: ['h1.file'] });
    });

    test('substitutes known outputs before comparing', () => {
        const p = plan(
            [
                task('h1.a'),
                task('h1.same', {
                    state: { port: '$tunkki{h1.a/port}' },
                    deps: ['h1.a'],
                }),
                task('h2.unknown', {
                    state: { port: '$tunkki{h1.a/other}' },
                    deps: ['h1.a'],
                }),
            ],
            {
                h1: {
                    'h1.a': {
                        handler: 'test.a',
                        state: {},
                        output: { port: 80 },
                        deps: [],
                    },
                    'h1.same': {
                        handler: 'test.a',
                        state: { port: 80 },
                        deps: ['h1.a'],
                    },
                },
                h2: {
                    'h2.unknown': {
                        handler: 'test.a',
                        state: { port: 80 },
                        deps: ['h1.a'],
                    },
                },
            },
        );
        expect(categories(p)).toEqual({
            updated: ['h2.unknown'],
            unchanged: ['h1.a', 'h1.same'],
        });
    });

    test('runs unchanged tasks whose outputs are used but not stored', () => {
        const p = plan(
            [
                task('h1.a'),
                task('h1.b', {
                    state: { port: '$tunkki{h1.a/port}' },
                    deps: ['h1.a'],
                }),
            ],
            { h1: { 'h1.a': { handler: 'test.a', state: {} } } },
        );
        expect(categories(p)).toEqual({
            created: ['h1.b'],
            updated: ['h1.a'],
        });
    });

    test('cascades changes to dependents as maybe', () => {
        const record = { handler: 'test.a', state: {}, deps: [] };
        const p = plan(
            [
                task('h1.a', { state: { v: 2 } }),
                task('h1.b', { deps: ['h1.a'] }),
                task('h2.c', { deps: ['h1.b'] }),
                task('h2.d', { deps: ['h1.a'], state: { v: 2 } }),
                task('h2.e'),
            ],
            {
                h1: {
                    'h1.a': record,
                    'h1.b': { ...record, deps: ['h1.a'] },
                },
                h2: {
                    'h2.c': { ...record, deps: ['h1.b'] },
                    'h2.d': { ...record, deps: ['h1.a'] },
                    'h2.e': record,
                },
            },
        );
        expect(categories(p)).toEqual({
            updated: ['h1.a', 'h2.d'],
            maybe: ['h1.b', 'h2.c'],
            unchanged: ['h2.e'],
        });
    });

    test('refreshes unchanged records whose deps differ', () => {
        const p = plan(
            [
                task('h1.a'),
                task('h1.b', { deps: ['h1.a'] }),
                task('h1.c', { deps: ['h1.a', 'h1.b'] }),
            ],
            {
                h1: {
                    'h1.a': { handler: 'test.a', state: {} },
                    'h1.b': { handler: 'test.a', state: {} },
                    'h1.c': {
                        handler: 'test.a',
                        state: {},
                        deps: ['h1.b', 'h1.a'],
                    },
                },
            },
        );
        // Missing deps are the same as none, and order does not matter
        expect(categories(p)).toEqual({
            unchanged: ['h1.a', 'h1.b', 'h1.c'],
            refresh: ['h1.b'],
        });
    });

    test('reapply updates every kept task', () => {
        const record = { handler: 'test.a', state: {}, deps: [] };
        const p = plan(
            [
                task('h1.new'),
                task('h1.same'),
                task('h1.retyped', { type: 'test.b' }),
            ],
            { h1: { 'h1.same': record, 'h1.retyped': record } },
            { mode: 'reapply' },
        );
        expect(categories(p)).toEqual({
            created: ['h1.new'],
            updated: ['h1.same'],
            replaced: ['h1.retyped'],
        });
    });

    test('destroy deletes everything', () => {
        const p = plan(
            [task('h1.a')],
            { h1: { 'h1.a': { handler: 'test.a', state: {} } } },
            { mode: 'destroy' },
        );
        expect(categories(p)).toEqual({ deleted: ['h1.a'] });
    });

    test('rejects missing handlers, except $noop', () => {
        expect(() =>
            plan([], {
                h1: {
                    'h1.end': { handler: '$noop', state: {} },
                    'h1.custom': { handler: 'test.removed', state: {} },
                },
            }),
        ).toThrow(/h1.custom \(test.removed\)/);
    });
});

describe('order', () => {
    test('deletes after their old dependents, and before other changes', () => {
        const p = plan(
            [
                task('h1.kept', { state: { v: 2 } }),
                task('h1.new'),
                task('h2.new'),
            ],
            {
                h1: {
                    // Used by kept task, so waits for it
                    'h1.used': { handler: 'test.a', state: {} },
                    'h1.kept': {
                        handler: 'test.a',
                        state: {},
                        deps: ['h1.used'],
                    },
                    // Chain of deletes: base is deleted after top
                    'h1.base': { handler: 'test.a', state: {} },
                    'h1.top': {
                        handler: 'test.a',
                        state: {},
                        deps: ['h1.base'],
                    },
                },
            },
        );
        expect(p.nodes['h1.used']?.after).toEqual(['h1.kept']);
        expect(p.nodes['h1.base']?.after).toEqual(['h1.top']);
        expect(p.nodes['h1.top']?.after).toEqual([]);
        expect(p.barriers).toEqual([
            {
                wait: ['h1.base', 'h1.top'],
                blocked: ['h1.new', 'h1.kept'],
            },
        ]);
    });

    test('deletes wait for kept tasks that used them transitively', () => {
        const record = { handler: 'test.a', state: {} };
        const p = plan(
            [task('h1.middle'), task('h1.top', { deps: ['h1.middle'] })],
            {
                h1: {
                    'h1.base': record,
                    'h1.middle': { ...record, deps: ['h1.base'] },
                    'h1.top': { ...record, deps: ['h1.middle'] },
                },
            },
        );
        expect([...(p.nodes['h1.base']?.after ?? [])].sort()).toEqual([
            'h1.middle',
            'h1.top',
        ]);
        expect(p.barriers).toEqual([]);
    });

    test('rolling blocks become barriers between hosts', () => {
        const p = plan(
            [task('h1.a'), task('h2.a'), task('h3.a')],
            {},
            {
                rollingBlocks: [[['h1.a'], ['h2.a'], ['h3.a']]],
            },
        );
        expect(p.barriers).toEqual([
            { wait: ['h1.a'], blocked: ['h2.a'] },
            { wait: ['h2.a'], blocked: ['h3.a'] },
        ]);
    });

    test('rejects dependency cycles', () => {
        expect(() =>
            plan(
                [
                    task('h1.a', { deps: ['h1.b'] }),
                    task('h1.b', { deps: ['h1.a'] }),
                ],
                {},
            ),
        ).toThrow(/cycle.*h1.a, h1.b|cycle.*h1.b, h1.a/);
    });

    test('rejects cycles through rolling blocks', () => {
        // h1.a waits for h2.b, which waits for h1.a in rolling order
        expect(() =>
            plan(
                [task('h1.a', { deps: ['h2.b'] }), task('h2.b')],
                {},
                { rollingBlocks: [[['h1.a'], ['h2.b']]] },
            ),
        ).toThrow(/cycle/);
    });
});

describe('upgrade from old state', () => {
    // Old versions add rolling -end tasks to every on() block, and store no
    // deps or outputs
    const oldState: StateFile = {
        'h1.svc': { handler: 'test.a', state: { v: 1 } },
        'h1.group.file': { handler: 'test.b', state: { v: 1 } },
        'h1.group.group-end': { handler: '$noop', state: {} },
        'h1.group.group-end-end': { handler: '$noop', state: {} },
    };
    const tasks = [
        task('h1.svc', { state: { v: 1 } }),
        task('h1.group.file', { type: 'test.b', state: { v: 1 } }),
        task('h1.group.group-end', {
            type: '$noop',
            deps: ['h1.group.file'],
            requireReapply: true,
        }),
    ];

    test('only drops rolling -end tasks and backfills deps', () => {
        const p = plan(tasks, { h1: oldState });
        expect(categories(p)).toEqual({
            deleted: ['h1.group.group-end-end'],
            unchanged: ['h1.group.file', 'h1.group.group-end', 'h1.svc'],
            refresh: ['h1.group.group-end'],
        });
        // Nothing else waits for the deleted $noop
        expect(p.barriers).toEqual([]);
    });
});

describe('plan files', () => {
    let dir: string;
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('round-trip, readable only by owner', async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-plan-'));
        const file = path.join(dir, 'foo.plan');
        const p = plan(
            [task('h1.a', { state: { data: new Uint8Array([1]) } })],
            {},
        );
        await writePlan(file, p);
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        expect(await readPlan(file)).toEqual(p);
    });

    test('reject other Bun versions', async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-plan-'));
        const file = path.join(dir, 'foo.plan');
        await Bun.write(
            file,
            `${JSON.stringify({ version: 1, bunVersion: '0.0.1', stack: 'prod' })}\n`,
        );
        expect(readPlan(file)).rejects.toThrow(/written by Bun 0.0.1/);
    });
});
