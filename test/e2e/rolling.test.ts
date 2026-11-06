import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { on } from '../..';
import { probe } from './fixtures/types';
import {
    applyOnce,
    destroyStack,
    errorsOf,
    eventIndex,
    probeDir,
    probeLog,
    removeProbes,
    TEST_VMS,
    uniqueStack,
    vmHost,
    vmsReady,
} from './helpers';

setDefaultTimeout(120_000);
const t = test.skipIf(!(await vmsReady()));
const hosts = TEST_VMS.map(vmHost);

let stack: string;
let dir: string;
const newStack = (prefix: string) => {
    stack = uniqueStack(prefix);
    dir = probeDir(stack);
};
afterEach(async () => {
    await destroyStack(stack, hosts);
    await removeProbes(stack, TEST_VMS);
});

/**
 * Whether a host finished before the next one started.
 */
function finishedBefore(
    outcome: Awaited<ReturnType<typeof applyOnce>>,
    first: string,
    second: string,
): boolean {
    const lastCompleted = outcome.events.findLastIndex(
        (e) => e.host.id === first && e.type === 'completed',
    );
    return lastCompleted < eventIndex(outcome.events, second, 'started');
}

t('applies one host at a time, in order', async () => {
    newStack('e2e-rolling');
    const outcome = await applyOnce(stack, hosts, () =>
        on('*', () => {
            probe('a', { name: 'a', dir });
            probe('b', { name: 'b', dir });
        }),
    );
    expect(errorsOf(outcome)).toEqual([]);
    expect(finishedBefore(outcome, 'test1', 'test2')).toBe(true);
    expect(finishedBefore(outcome, 'test2', 'test3')).toBe(true);
});

t('skips hosts without tasks in the block', async () => {
    newStack('e2e-rolling-gap');
    const outcome = await applyOnce(stack, hosts, () =>
        on('*', (host) => {
            if (host.id !== 'test2') {
                probe('a', { name: 'a', dir });
            }
        }),
    );
    expect(errorsOf(outcome)).toEqual([]);
    expect(finishedBefore(outcome, 'test1', 'test3')).toBe(true);
});

t('a failure halts the rest of the block', async () => {
    newStack('e2e-rolling-fail');
    const outcome = await applyOnce(stack, hosts, () =>
        on('*', (host) => {
            probe('a', { name: 'a', dir, fail: host.id === 'test2' });
        }),
    );
    expect(errorsOf(outcome)).toEqual([expect.stringContaining('a failed')]);
    expect(
        outcome.results.map((r) => [r.host, r.completed, r.skipped]),
    ).toEqual([
        ['test1', ['test1.a'], []],
        ['test2', [], []],
        ['test3', [], ['test3.a']],
    ]);
    expect(await probeLog('test3', dir)).toEqual([]);
});

t('a change on one host does not run tasks on others', async () => {
    newStack('e2e-rolling-change');
    const define = (changed: string) => () =>
        on('*', (host) => {
            probe('a', { name: 'a', dir, value: host.id === changed });
        });
    await applyOnce(stack, hosts, define(''));
    const outcome = await applyOnce(stack, hosts, define('test1'));
    expect(errorsOf(outcome)).toEqual([]);
    expect(outcome.plan.updated).toEqual(['test1.a']);
    expect(await probeLog('test1', dir)).toEqual(['apply a', 'apply a']);
    expect(await probeLog('test2', dir)).toEqual(['apply a']);
    expect(await probeLog('test3', dir)).toEqual(['apply a']);
});
