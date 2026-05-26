import { describe, expect, test } from 'bun:test';
import type { Host } from '../..';
import type { Event } from '../../local/runner';
import { newTaskScheduler, type ScheduledTask } from '../../local/scheduler';
import type { Task } from '../../local/task';

/** Build a minimal Task — only the fields the scheduler reads. */
function task(id: string, after: string[] = [], host = 'h1'): Task {
    return {
        id,
        host,
        state: undefined,
        type: '$noop',
        after,
        localData: {},
    };
}

/** Dummy Host placeholder; the scheduler doesn't read it. */
const HOST: Host = { id: 'h1', conn: {} as never };

function completed(
    taskId: string,
    status: 'done' | 'error' | 'skipped' = 'done',
): Event {
    return { host: HOST, type: 'completed', taskId, status };
}

/**
 * Drain the scheduler generator into an array, settling each yielded task by
 * invoking `settle(t)` which returns the status to feed back as a completion
 * event (or `null` to skip feeding — used to simulate tasks the scheduler
 * itself marked skipped, which the consumer would normally echo back).
 *
 * Returns the full ordered list of yielded ScheduledTask entries.
 */
async function drain(
    tasks: Task[],
    settle: (t: Task) => 'done' | 'error' | 'skipped' | null,
): Promise<ScheduledTask[]> {
    const [schedule, onCompleted] = newTaskScheduler(tasks);
    const yielded: ScheduledTask[] = [];
    for await (const sched of schedule()) {
        yielded.push(sched);
        const s = settle(sched.task);
        if (s !== null) {
            onCompleted(completed(sched.task.id, s));
        }
    }
    return yielded;
}

describe('newTaskScheduler', () => {
    test('empty task list returns immediately', async () => {
        const [schedule] = newTaskScheduler([]);
        const out: ScheduledTask[] = [];
        for await (const s of schedule()) out.push(s);
        expect(out).toEqual([]);
    });

    test('single task with no deps yields once as ready', async () => {
        const a = task('a');
        const out = await drain([a], () => 'done');
        expect(out).toHaveLength(1);
        expect(out[0]!.task.id).toBe('a');
        expect(out[0]!.status).toBe('ready');
    });

    test('linear chain A->B->C yields in dependency order', async () => {
        const out = await drain(
            [task('a'), task('b', ['a']), task('c', ['b'])],
            () => 'done',
        );
        expect(out.map((s) => s.task.id)).toEqual(['a', 'b', 'c']);
        for (const s of out) expect(s.status).toBe('ready');
    });

    test('diamond A->{B,C}->D waits for both branches before D', async () => {
        // Manually drive so we can observe ordering precisely: A done unlocks
        // B and C concurrently, but D must not appear until BOTH complete.
        const tasks = [
            task('a'),
            task('b', ['a']),
            task('c', ['a']),
            task('d', ['b', 'c']),
        ];
        const [schedule, onCompleted] = newTaskScheduler(tasks);
        const gen = schedule();

        // A is the only root.
        const first = await gen.next();
        expect(first.value!.task.id).toBe('a');
        onCompleted(completed('a'));

        // After A done, both B and C unlock — order between them isn't
        // guaranteed but D must NOT be in the next two yields.
        const next1 = await gen.next();
        const next2 = await gen.next();
        const ids = [next1.value!.task.id, next2.value!.task.id].sort();
        expect(ids).toEqual(['b', 'c']);
        expect(next1.value!.status).toBe('ready');

        // Complete only B; D must still not yield until C also completes.
        onCompleted(completed('b'));
        // Now complete C; D should yield.
        onCompleted(completed('c'));
        const fourth = await gen.next();
        expect(fourth.value!.task.id).toBe('d');

        onCompleted(completed('d'));
        const done = await gen.next();
        expect(done.done).toBe(true);
    });

    test('multiple independent roots all yield eagerly before any complete', async () => {
        const tasks = [task('a'), task('b'), task('c')];
        const [schedule, onCompleted] = newTaskScheduler(tasks);
        const gen = schedule();

        // All three should be in the queue immediately; we can pull them
        // without sending any completion events first.
        const a = await gen.next();
        const b = await gen.next();
        const c = await gen.next();
        expect(
            [a.value!.task.id, b.value!.task.id, c.value!.task.id].sort(),
        ).toEqual(['a', 'b', 'c']);

        for (const id of ['a', 'b', 'c']) onCompleted(completed(id));
        expect((await gen.next()).done).toBe(true);
    });

    test('error in A cascades skipped to a single dependent B', async () => {
        // Settle A as error; B should be yielded with status 'skipped'
        // (not 'ready') — the consumer is supposed to route it to a
        // "skipped" completion event instead of executing it on the remote.
        const out = await drain([task('a'), task('b', ['a'])], (t) => {
            if (t.id === 'a') return 'error';
            // Echo skipped back like the real consumer would. The scheduler
            // must remain idempotent: it already cascaded, so the echo is
            // a no-op state-wise.
            return 'skipped';
        });
        const a = out.find((s) => s.task.id === 'a')!;
        const b = out.find((s) => s.task.id === 'b')!;
        expect(a.status).toBe('ready');
        expect(b.status).toBe('skipped');
    });

    test('error in A cascades skipped transitively (A->B->C)', async () => {
        const out = await drain(
            [task('a'), task('b', ['a']), task('c', ['b'])],
            (t) => {
                if (t.id === 'a') return 'error';
                return 'skipped';
            },
        );
        const b = out.find((s) => s.task.id === 'b')!;
        const c = out.find((s) => s.task.id === 'c')!;
        expect(b.status).toBe('skipped');
        expect(c.status).toBe('skipped');
    });

    test('error in A cascades to both branches of a diamond', async () => {
        // A errored: B, C, and D should all be skipped (not just B and C).
        const out = await drain(
            [
                task('a'),
                task('b', ['a']),
                task('c', ['a']),
                task('d', ['b', 'c']),
            ],
            (t) => {
                if (t.id === 'a') return 'error';
                return 'skipped';
            },
        );
        const ids = out
            .filter((s) => s.status === 'skipped')
            .map((s) => s.task.id)
            .sort();
        expect(ids).toEqual(['b', 'c', 'd']);
    });

    test('a sibling whose dep succeeded still runs even after another sibling errors', async () => {
        // Tasks: root1, root2 — independent. root1->a; root2->b. If root1
        // errors, only `a` should be skipped; root2 + b should still run.
        const out = await drain(
            [
                task('root1'),
                task('root2'),
                task('a', ['root1']),
                task('b', ['root2']),
            ],
            (t) => {
                if (t.id === 'root1') return 'error';
                if (t.id === 'a') return 'skipped';
                return 'done';
            },
        );
        const byId = new Map(out.map((s) => [s.task.id, s]));
        expect(byId.get('root1')!.status).toBe('ready');
        expect(byId.get('root2')!.status).toBe('ready');
        expect(byId.get('a')!.status).toBe('skipped');
        expect(byId.get('b')!.status).toBe('ready');
    });

    test('rolling pattern: second-host tasks wait on the first host end-task', async () => {
        // Mimic what on(...) builds for rolling=true: each host has its own
        // tasks plus a $noop end-task that depends on them; the next host's
        // tasks have `after: [prevEnd.id]`.
        const tasks: Task[] = [
            task('h1.a', [], 'h1'),
            { ...task('h1.end', ['h1.a'], 'h1'), type: '$noop' },
            task('h2.a', ['h1.end'], 'h2'),
            { ...task('h2.end', ['h2.a'], 'h2'), type: '$noop' },
        ];
        const [schedule, onCompleted] = newTaskScheduler(tasks);
        const gen = schedule();

        // Only h1.a is a root.
        const first = await gen.next();
        expect(first.value!.task.id).toBe('h1.a');
        // h2.a must NOT be queued yet — its dep (h1.end) hasn't completed.
        onCompleted(completed('h1.a'));
        const second = await gen.next();
        expect(second.value!.task.id).toBe('h1.end');
        // Still h2.a should not appear; only after h1.end completes.
        onCompleted(completed('h1.end'));
        const third = await gen.next();
        expect(third.value!.task.id).toBe('h2.a');
        onCompleted(completed('h2.a'));
        const fourth = await gen.next();
        expect(fourth.value!.task.id).toBe('h2.end');
        onCompleted(completed('h2.end'));
        expect((await gen.next()).done).toBe(true);
    });
});
