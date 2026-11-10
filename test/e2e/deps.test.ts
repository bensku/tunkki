import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { on } from '../..';
import { combine } from '../../task';
import type { ProbeState } from './fixtures/probe';
import { probe } from './fixtures/types';
import {
    applyOnce,
    destroyStack,
    errorsOf,
    probeDir,
    probeLog,
    removeProbes,
    uniqueStack,
    vmExec,
    vmHost,
    vmRead,
    vmsReady,
} from './helpers';

setDefaultTimeout(120_000);
const t = test.skipIf(!(await vmsReady()));
const hosts = [vmHost('test1'), vmHost('test2')];

let stack: string;
let dir: string;
const newStack = (prefix: string) => {
    stack = uniqueStack(prefix);
    dir = probeDir(stack);
};
afterEach(async () => {
    await destroyStack(stack, hosts);
    await removeProbes(stack, ['test1', 'test2']);
});

t('reapplyOnDepChange reapplies when a dep was applied', async () => {
    newStack('e2e-reapply');
    const define = (value: number) => () =>
        on('test1', () => {
            const a = probe('a', { name: 'a', dir, value });
            probe(
                'flagged',
                { name: 'flagged', dir },
                {
                    dependencies: [a.id],
                    requireReapply: true,
                },
            );
            probe('plain', { name: 'plain', dir }, { dependencies: [a.id] });
        });
    await applyOnce(stack, hosts, define(1));
    const outcome = await applyOnce(stack, hosts, define(2));
    expect(errorsOf(outcome)).toEqual([]);
    expect((await probeLog('test1', dir)).slice(3)).toEqual([
        'apply a',
        'apply flagged',
    ]);
});

t('reapplyOnDepChange passes through combine', async () => {
    newStack('e2e-reapply-combine');
    const pair = combine<ProbeState, unknown>((state, opts) => {
        const first = probe('first', state, opts);
        probe(
            'second',
            { name: 'second', dir: state.dir },
            { dependencies: [first.id] },
        );
    });
    const define = (value: number) => () =>
        on('test1', () => {
            const p = pair('pair', { name: 'first', dir, value });
            probe(
                'svc',
                { name: 'svc', dir },
                {
                    dependencies: [p.id],
                    requireReapply: true,
                },
            );
        });
    await applyOnce(stack, hosts, define(1));
    const outcome = await applyOnce(stack, hosts, define(2));
    expect(errorsOf(outcome)).toEqual([]);
    expect((await probeLog('test1', dir)).slice(3)).toEqual([
        'apply first',
        'apply svc',
    ]);
});

t(
    'outputs are used on the same host, across hosts and in strings',
    async () => {
        newStack('e2e-outputs');
        const outcome = await applyOnce(stack, hosts, () => {
            let a: ReturnType<typeof probe> | undefined;
            on('test1', () => {
                a = probe('a', { name: 'a', dir, value: 80 });
                probe('same', { name: 'same', dir, value: a.value });
            });
            on('test2', () => {
                probe('other', {
                    name: 'other',
                    dir,
                    value: `${a?.host}:${a?.value}`,
                });
            });
        });
        expect(errorsOf(outcome)).toEqual([]);
        const hostname = (await vmExec('test1', 'hostname')).stdout.trim();
        expect(await vmRead('test1', `${dir}/same`)).toBe('80');
        expect(await vmRead('test2', `${dir}/other`)).toBe(`"${hostname}:80"`);
    },
);

t('unresolved outputs fail the task', async () => {
    newStack('e2e-unresolved');
    const outcome = await applyOnce(stack, hosts, () =>
        on('test1', () => {
            const a = probe('a', { name: 'a', dir });
            const outputs = a as unknown as Record<string, unknown>;
            probe('b', { name: 'b', dir, value: outputs.missing });
        }),
    );
    expect(errorsOf(outcome)).toEqual([
        expect.stringContaining('unresolved outputs: $tunkki{test1.a/missing}'),
    ]);
});
