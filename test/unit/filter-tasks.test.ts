import { describe, expect, test } from 'bun:test';
import { filterTasks, type Task } from '../../local/task';

function task(id: string, applyOn: Record<string, string>): Task {
    return { id, applyOn, state: {}, type: 'fake' };
}

describe('filterTasks', () => {
    test('returns tasks whose applyOn tag matches the host tag exactly', () => {
        const tasks = [
            task('a', { host: 'web-1' }),
            task('b', { host: 'web-2' }),
        ];
        expect(filterTasks(tasks, { host: 'web-1' })).toEqual([
            task('a', { host: 'web-1' }),
        ]);
    });

    test('honours glob patterns in applyOn values', () => {
        const tasks = [
            task('frontend', { host: 'web-*' }),
            task('database', { host: 'db-*' }),
        ];
        expect(filterTasks(tasks, { host: 'web-3' })).toEqual([
            task('frontend', { host: 'web-*' }),
        ]);
        expect(filterTasks(tasks, { host: 'db-1' })).toEqual([
            task('database', { host: 'db-*' }),
        ]);
    });

    test('uses OR semantics across applyOn keys (any matching tag is enough)', () => {
        const t = task('shared', { host: 'web-*', env: 'staging' });
        // Matches via host, even though env tag isn't on the host.
        expect(filterTasks([t], { host: 'web-1' })).toEqual([t]);
        // Matches via env, even though host doesn't match the host glob.
        expect(filterTasks([t], { host: 'db-1', env: 'staging' })).toEqual([t]);
        // Neither key matches -> excluded.
        expect(filterTasks([t], { host: 'db-1', env: 'prod' })).toEqual([]);
    });

    test('excludes tasks whose applyOn tag is absent from host tags', () => {
        const t = task('only', { region: 'eu-west' });
        expect(filterTasks([t], { host: 'web-1' })).toEqual([]);
    });

    test('a task with applyOn={} matches no host (no keys to match)', () => {
        // The default applyOn for top-level tasks is `{ host: '*' }`, which is
        // set by the builder; an empty applyOn here would only happen if the
        // caller constructs a Task by hand. Document the behaviour anyway.
        const t = task('orphan', {});
        expect(filterTasks([t], { host: 'web-1' })).toEqual([]);
    });

    test('the wildcard host=* applyOn matches any host', () => {
        const t = task('global', { host: '*' });
        expect(filterTasks([t], { host: 'web-1' })).toEqual([t]);
        expect(filterTasks([t], { host: 'db-99' })).toEqual([t]);
    });

    test('preserves the order of input tasks', () => {
        const tasks = [
            task('a', { host: '*' }),
            task('b', { host: '*' }),
            task('c', { host: '*' }),
        ];
        const out = filterTasks(tasks, { host: 'h' });
        expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });

    test('returns an empty array when no task matches', () => {
        const tasks = [
            task('a', { host: 'web-*' }),
            task('b', { host: 'db-*' }),
        ];
        expect(filterTasks(tasks, { host: 'cache-1' })).toEqual([]);
    });
});
