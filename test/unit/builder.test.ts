import { beforeEach, describe, expect, test } from 'bun:test';
import { group, type Host, on } from '../..';
import * as builder from '../../local/builder';
import { taskType } from '../../task';

// A handler stub registered just to give `taskType()` something to point at.
// The handler is never loaded during these tests — we never reach the runner.
const dummy = taskType<{ value: number }, { id: string }>(
    'test.dummy',
    'test/unit/builder.test.ts', // path is irrelevant outside runner
);

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

        const ids = builder.tasks.map((t) => t.id).sort();
        const hosts = builder.tasks
            .filter((t) => t.type !== '$noop')
            .map((t) => t.host)
            .sort();
        // Each host produces one real task ('h1.t' / 'h2.t') plus a $noop
        // end-task synthesized by on() (named after the last real task).
        expect(ids).toEqual(['h1.t', 'h1.t-end', 'h2.t', 'h2.t-end']);
        expect(hosts).toEqual(['h1', 'h2']);
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
        const realTaskHosts = builder.tasks
            .filter((t) => t.type !== '$noop')
            .map((t) => t.host)
            .sort();
        expect(realTaskHosts).toEqual(['h1', 'h3']);
        // No task should have been emitted for h2.
        expect(builder.tasks.some((t) => t.host === 'h2')).toBe(false);
    });

    test('rolling=true chains each host onto the previous host end-task', async () => {
        on(
            '*',
            () => {
                dummy('a', { value: 1 });
                dummy('b', { value: 2 });
            },
            true,
        );
        await builder.loadTasks([fakeHost('h1'), fakeHost('h2')]);

        // h2's real tasks should each list h1's end-task in their `after`.
        const h1End = builder.tasks.find(
            (t) => t.host === 'h1' && t.type === '$noop',
        )!;
        const h2A = builder.tasks.find((t) => t.id === 'h2.a')!;
        const h2B = builder.tasks.find((t) => t.id === 'h2.b')!;
        expect(h2A.after).toContain(h1End.id);
        expect(h2B.after).toContain(h1End.id);

        // h1's tasks must NOT depend on anything (they're the first host).
        const h1A = builder.tasks.find((t) => t.id === 'h1.a')!;
        expect(h1A.after).toEqual([]);

        // The end-task itself depends on every real task in the block and
        // tracks them in onChanged.
        expect(h1End.after.sort()).toEqual(['h1.a', 'h1.b']);
        expect(h1End.onChanged!.sort()).toEqual(['h1.a', 'h1.b']);
    });

    test('rolling=false does NOT chain hosts (parallel execution)', async () => {
        on(
            '*',
            () => {
                dummy('a', { value: 1 });
            },
            false,
        );
        await builder.loadTasks([fakeHost('h1'), fakeHost('h2')]);

        const h2A = builder.tasks.find((t) => t.id === 'h2.a')!;
        // Without rolling, h2.a has no cross-host dep on h1's end-task.
        expect(h2A.after).toEqual([]);
    });

    test('two on() blocks coexist and each gets its own chain', async () => {
        on('*', () => {
            dummy('block1', { value: 1 });
        });
        on('*', () => {
            dummy('block2', { value: 2 });
        });
        await builder.loadTasks([fakeHost('h1')]);

        const real = builder.tasks.filter((t) => t.type !== '$noop');
        expect(real.map((t) => t.id).sort()).toEqual([
            'h1.block1',
            'h1.block2',
        ]);

        // Each block produced its own end-task.
        const ends = builder.tasks.filter((t) => t.type === '$noop');
        expect(ends).toHaveLength(2);
    });

    test('group() prefixes ids inside on()', async () => {
        on('*', async () => {
            await group('g', () => {
                dummy('inner', { value: 1 });
            });
        });
        await builder.loadTasks([fakeHost('h1')]);

        const innerIds = builder.tasks
            .filter((t) => t.type !== '$noop')
            .map((t) => t.id);
        expect(innerIds).toEqual(['h1.g.inner']);
    });
});
