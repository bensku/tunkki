import { describe, expect, test } from 'bun:test';
import type { Barrier, Plan } from '../../local/plan';
import { Scheduler } from '../../local/scheduler';

/**
 * Builds a plan with given task deps. Deps are also scheduler edges.
 */
function planOf(
    deps: Record<string, string[]>,
    opts: { unchanged?: string[]; barriers?: Barrier[] } = {},
): Plan {
    const nodes: Plan['nodes'] = {};
    for (const [id, taskDeps] of Object.entries(deps)) {
        nodes[id] = {
            task: {
                id,
                host: 'h1',
                type: 'test.a',
                state: {},
                deps: taskDeps,
                requireReapply: false,
            },
            after: taskDeps,
            dependents: [],
        };
    }
    for (const [id, taskDeps] of Object.entries(deps)) {
        for (const dep of taskDeps) {
            nodes[dep]?.dependents.push(id);
        }
    }
    return {
        version: 1,
        stack: 'prod',
        mode: 'apply',
        hosts: { h1: { stateHash: '' } },
        created: [],
        updated: [],
        uncertain: [],
        replaced: [],
        deleted: [],
        unchanged: opts.unchanged ?? [],
        refresh: [],
        old: {},
        nodes,
        barriers: opts.barriers ?? [],
    };
}

function schedule(plan: Plan) {
    const started: [string, boolean][] = [];
    const skipped: string[] = [];
    const scheduler = new Scheduler(plan, {
        run: (id, depApplied) => started.push([id, depApplied]),
        skipped: (id) => skipped.push(id),
    });
    let finished = false;
    const done = scheduler.start().then(() => {
        finished = true;
    });
    return {
        scheduler,
        started,
        skipped,
        done,
        get finished() {
            return finished;
        },
    };
}

describe('scheduler', () => {
    test('starts tasks after their deps', () => {
        const s = schedule(planOf({ a: [], b: ['a'], c: ['a', 'b'] }));
        expect(s.started).toEqual([['a', false]]);
        s.scheduler.finish('a', 'done');
        expect(s.started.map(([id]) => id)).toEqual(['a', 'b']);
        s.scheduler.finish('b', 'unchanged');
        expect(s.started).toEqual([
            ['a', false],
            ['b', true],
            ['c', true],
        ]);
    });

    test('unchanged tasks release dependents without running', async () => {
        const s = schedule(planOf({ a: [], b: ['a'] }, { unchanged: ['a'] }));
        expect(s.started).toEqual([['b', false]]);
        s.scheduler.finish('b', 'done');
        await s.done;
    });

    test('reports whether a direct dep was applied', () => {
        const s = schedule(planOf({ a: [], b: [], c: ['a', 'b'] }));
        s.scheduler.finish('a', 'unchanged');
        s.scheduler.finish('b', 'unchanged');
        expect(s.started.at(-1)).toEqual(['c', false]);
    });

    test('failures skip dependents transitively', async () => {
        const s = schedule(
            planOf({ a: [], b: ['a'], c: ['b'], d: [] }, { unchanged: ['d'] }),
        );
        s.scheduler.finish('a', 'error');
        expect(s.skipped).toEqual(['b', 'c']);
        await s.done;
    });

    test('barriers wait for every task in wait', () => {
        const s = schedule(
            planOf(
                { a: [], b: [], c: [] },
                { barriers: [{ wait: ['a', 'b'], blocked: ['c'] }] },
            ),
        );
        expect(s.started.map(([id]) => id)).toEqual(['a', 'b']);
        s.scheduler.finish('a', 'done');
        expect(s.started).toHaveLength(2);
        s.scheduler.finish('b', 'done');
        // Barriers are not deps
        expect(s.started.at(-1)).toEqual(['c', false]);
    });

    test('barrier failure skips blocked tasks and their dependents', async () => {
        const s = schedule(
            planOf(
                { a: [], b: [], c: ['b'], d: [] },
                {
                    barriers: [
                        { wait: ['a'], blocked: ['b'] },
                        { wait: ['b'], blocked: ['d'] },
                    ],
                },
            ),
        );
        s.scheduler.finish('a', 'error');
        expect(s.skipped.sort()).toEqual(['b', 'c', 'd']);
        await s.done;
    });

    test('finishes when every task has a result', async () => {
        const s = schedule(planOf({ a: [], b: ['a'] }));
        s.scheduler.finish('a', 'done');
        expect(s.finished).toBe(false);
        s.scheduler.finish('b', 'done');
        await s.done;
    });

    test('finishes at once without tasks to run', async () => {
        await schedule(planOf({ a: [] }, { unchanged: ['a'] })).done;
    });
});
