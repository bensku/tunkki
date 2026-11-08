import { beforeEach, describe, expect, test } from 'bun:test';
import { group, type Host, on } from '../..';
import * as builder from '../../local/builder';
import { combine, taskType } from '../../task';

// A handler stub registered just to give `taskType()` something to point at.
// The handler is never loaded during these tests — we never reach the runner.
const dummy = taskType<{ value: number; list?: string[] }, unknown>(
    'test.dummy',
    'test/unit/builder.test.ts', // path is irrelevant outside runner
);

const withOutputs = taskType<
    { value?: number },
    unknown,
    { port: number; address: { host: string } }
>('test.outputs', 'test/unit/builder.test.ts');

/** Build a fake Host without a real connector — on() only reads id/tags. */
function fakeHost(id: string, tags: Record<string, string> = {}): Host {
    return { id, tags, conn: {} as never };
}

beforeEach(() => {
    builder.clearAll();
});

describe('builder primitives', () => {
    test('addTask outside a host throws', () => {
        expect(() => builder.addTask('x', 'test.dummy', {}, {})).toThrow(
            /outside on\(\.\.\.\) block/,
        );
    });

    test('enterHost called twice without exitHost throws', () => {
        builder.enterHost('h1');
        expect(() => builder.enterHost('h2')).toThrow(
            /enterHost.* before exitHost/,
        );
        builder.exitHost();
    });

    test('exitHost without enterHost throws', () => {
        expect(() => builder.exitHost()).toThrow(/exitHost.* twice/);
    });

    test('qualifyId prefixes host id and group stack', () => {
        builder.enterHost('h1');
        try {
            expect(builder.qualifyId('foo')).toBe('h1.foo');

            builder.pushId('grp');
            expect(builder.qualifyId('foo')).toBe('h1.grp.foo');
            builder.pushId('inner');
            expect(builder.qualifyId('foo')).toBe('h1.grp.inner.foo');
            builder.popId();
            builder.popId();

            expect(builder.qualifyId('foo')).toBe('h1.foo');
        } finally {
            builder.exitHost();
        }
    });
});

describe('on() task source registration', () => {
    test('on("*") fires for every host and tags tasks with host id', async () => {
        on('*', () => {
            dummy('t', { value: 1 });
        });
        await builder.loadTasks([fakeHost('h1'), fakeHost('h2')]);

        expect(builder.tasks.map((t) => [t.id, t.host])).toEqual([
            ['h1.t', 'h1'],
            ['h2.t', 'h2'],
        ]);
    });

    test('on({tag: glob}) only fires for hosts whose tag matches', async () => {
        on({ role: 'web-*' }, () => {
            dummy('t', { value: 1 });
        });
        await builder.loadTasks([
            fakeHost('h1', { role: 'web-1' }),
            fakeHost('h2', { role: 'db-1' }),
            fakeHost('h3', { role: 'web-2' }),
        ]);
        expect(builder.tasks.map((t) => t.host)).toEqual(['h1', 'h3']);
    });

    test('rolling on() records task ids per host as a block', async () => {
        on('*', () => {
            dummy('a', { value: 1 });
            dummy('b', { value: 2 });
        });
        await builder.loadTasks([fakeHost('h1'), fakeHost('h2')]);

        expect(builder.rollingBlocks).toEqual([
            [
                ['h1.a', 'h1.b'],
                ['h2.a', 'h2.b'],
            ],
        ]);
        // Rolling is not in the dependency graph
        expect(builder.tasks.every((t) => t.deps.length === 0)).toBe(true);
    });

    test('rolling blocks skip hosts without tasks', async () => {
        on({ role: 'web' }, () => {
            dummy('a', { value: 1 });
        });
        await builder.loadTasks([
            fakeHost('h1', { role: 'web' }),
            fakeHost('h2', { role: 'db' }),
            fakeHost('h3', { role: 'web' }),
        ]);
        expect(builder.rollingBlocks).toEqual([[['h1.a'], ['h3.a']]]);
    });

    test('a rolling block on one host is no block at all', async () => {
        on('h1', () => {
            dummy('a', { value: 1 });
        });
        await builder.loadTasks([fakeHost('h1'), fakeHost('h2')]);
        expect(builder.rollingBlocks).toEqual([]);
    });

    test('rolling=false records no block', async () => {
        on(
            '*',
            () => {
                dummy('a', { value: 1 });
            },
            false,
        );
        await builder.loadTasks([fakeHost('h1'), fakeHost('h2')]);
        expect(builder.rollingBlocks).toEqual([]);
    });

    test('two on() blocks get a block each', async () => {
        on('*', () => {
            dummy('block1', { value: 1 });
        });
        on('*', () => {
            dummy('block2', { value: 2 });
        });
        await builder.loadTasks([fakeHost('h1'), fakeHost('h2')]);
        expect(builder.rollingBlocks).toEqual([
            [['h1.block1'], ['h2.block1']],
            [['h1.block2'], ['h2.block2']],
        ]);
    });

    test('loading again starts from scratch', async () => {
        on('*', () => {
            dummy('a', { value: 1 });
        });
        await builder.loadTasks([fakeHost('h1'), fakeHost('h2')]);
        await builder.loadTasks([fakeHost('h1'), fakeHost('h2')]);
        expect(builder.tasks.map((t) => t.id)).toEqual(['h1.a', 'h2.a']);
        expect(builder.rollingBlocks).toHaveLength(1);
    });

    test('group() prefixes ids inside on()', async () => {
        on('*', async () => {
            await group('g', () => {
                dummy('inner', { value: 1 });
            });
        });
        await builder.loadTasks([fakeHost('h1')]);
        expect(builder.tasks.map((t) => t.id)).toEqual(['h1.g.inner']);
    });
});

describe('deps', () => {
    test('options set deps and the reapply flag', async () => {
        on('*', () => {
            const a = dummy('a', { value: 1 });
            dummy(
                'b',
                { value: 2 },
                { dependencies: [a.id], requireReapply: true },
            );
        });
        await builder.loadTasks([fakeHost('h1')]);
        expect(builder.tasks[1]).toMatchObject({
            id: 'h1.b',
            deps: ['h1.a'],
            requireReapply: true,
        });
        expect(builder.tasks[0]?.requireReapply).toBe(false);
    });

    test('combine adds an -end task that depends on everything inside', async () => {
        const pair = combine<{ value: number }, unknown>((state, opts) => {
            const first = dummy('first', state, opts);
            dummy('second', state, { ...opts, dependencies: [first.id] });
        });
        on('*', () => {
            const p = pair('pair', { value: 1 });
            dummy('after', { value: 2 }, { dependencies: [p.id] });
        });
        await builder.loadTasks([fakeHost('h1')]);
        expect(
            builder.tasks.map((t) => [t.id, t.type, t.deps, t.requireReapply]),
        ).toEqual([
            ['h1.pair.first', 'test.dummy', [], false],
            ['h1.pair.second', 'test.dummy', ['h1.pair.first'], false],
            [
                'h1.pair.pair-end',
                '$noop',
                ['h1.pair.first', 'h1.pair.second'],
                true,
            ],
            ['h1.after', 'test.dummy', ['h1.pair.pair-end'], false],
        ]);
    });

    test('nonexistent deps are rejected', async () => {
        on('*', () => {
            dummy('a', { value: 1 }, { dependencies: ['h1.missing'] });
        });
        expect(builder.loadTasks([fakeHost('h1')])).rejects.toThrow(
            /depends on nonexistent task h1.missing/,
        );
    });

    test('duplicate ids are rejected', async () => {
        on('*', () => {
            dummy('a', { value: 1 });
            dummy('a', { value: 2 });
        });
        expect(builder.loadTasks([fakeHost('h1')])).rejects.toThrow(
            /h1.a is used more than once/,
        );
    });
});

describe('outputs', () => {
    test('a whole-value reference becomes a token and a dep', async () => {
        on('*', () => {
            const a = withOutputs('a', {});
            dummy('b', { value: a.outputs.port });
        });
        await builder.loadTasks([fakeHost('h1')]);
        expect(builder.tasks[1]).toMatchObject({
            state: { value: '$tunkki{h1.a/port}' },
            deps: ['h1.a'],
        });
    });

    test('references work inside template strings and arrays', async () => {
        on('*', () => {
            const a = withOutputs('a', {});
            dummy('b', {
                value: 1,
                list: [`http://${a.outputs.address.host}:${a.outputs.port}/`],
            });
        });
        await builder.loadTasks([fakeHost('h1')]);
        expect(builder.tasks[1]?.state).toEqual({
            value: 1,
            list: ['http://$tunkki{h1.a/address/host}:$tunkki{h1.a/port}/'],
        });
        expect(builder.tasks[1]?.deps).toEqual(['h1.a']);
    });

    test('ids and paths are URI-encoded', async () => {
        on('*', () => {
            const a = withOutputs('we/ird}', {});
            dummy('b', {
                value:
                    (a.outputs as unknown as Record<string, number>)['a/b'] ??
                    0,
            });
        });
        await builder.loadTasks([fakeHost('h1')]);
        expect(builder.tasks[1]?.state).toEqual({
            value: '$tunkki{h1.we%2Fird%7D/a%2Fb}',
        });
        expect(builder.tasks[1]?.deps).toEqual(['h1.we/ird}']);
    });

    test('references added to state after the task are found', async () => {
        on('*', () => {
            // Like connectNebula, which mutates state after adding the task
            const state: { value: number; extra?: number } = { value: 1 };
            dummy('b', state);
            const a = withOutputs('a', {});
            state.extra = a.outputs.port;
        });
        await builder.loadTasks([fakeHost('h1')]);
        expect(builder.tasks[0]).toMatchObject({
            id: 'h1.b',
            state: { value: 1, extra: '$tunkki{h1.a/port}' },
            deps: ['h1.a'],
        });
    });

    test('referencing own outputs is rejected', async () => {
        on('*', () => {
            const state: { value?: number } = {};
            const a = withOutputs('a', state);
            state.value = a.outputs.port;
        });
        expect(builder.loadTasks([fakeHost('h1')])).rejects.toThrow(
            /h1.a depends on itself/,
        );
    });
});
