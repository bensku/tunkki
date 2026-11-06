import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { files, on } from '../..';
import { probe, twostep } from './fixtures/types';
import {
    applyOnce,
    destroyStack,
    errorsOf,
    planOnce,
    probeDir,
    probeLog,
    removeProbes,
    uniqueStack,
    vmExec,
    vmFileExists,
    vmHost,
    vmRead,
    vmsReady,
    vmWrite,
} from './helpers';

setDefaultTimeout(120_000);
const t = test.skipIf(!(await vmsReady()));
const hosts = [vmHost('test1')];

let stack: string;
let dir: string;
const newStack = (prefix: string) => {
    stack = uniqueStack(prefix);
    dir = probeDir(stack);
};
afterEach(async () => {
    await destroyStack(stack, hosts);
    await removeProbes(stack, ['test1']);
});

t('create, no-op, update, delete, destroy', async () => {
    newStack('e2e-life');
    const define = (contents: Record<string, string>) => () =>
        on('*', () => {
            for (const [name, content] of Object.entries(contents)) {
                files.put(name, { content, remotePath: `${dir}/${name}` });
            }
        });

    const created = await applyOnce(
        stack,
        hosts,
        define({ a: 'one', b: 'two' }),
    );
    expect(errorsOf(created)).toEqual([]);
    expect(created.plan.created.sort()).toEqual(['test1.a', 'test1.b']);
    expect(await vmRead('test1', `${dir}/a`)).toBe('one');

    const same = await applyOnce(stack, hosts, define({ a: 'one', b: 'two' }));
    expect(same.plan.unchanged.sort()).toEqual(['test1.a', 'test1.b']);
    expect(same.events).toEqual([]);

    const updated = await applyOnce(
        stack,
        hosts,
        define({ a: 'uno', b: 'two' }),
    );
    expect(errorsOf(updated)).toEqual([]);
    expect(updated.plan.updated).toEqual(['test1.a']);
    expect(await vmRead('test1', `${dir}/a`)).toBe('uno');

    const deleted = await applyOnce(stack, hosts, define({ a: 'uno' }));
    expect(errorsOf(deleted)).toEqual([]);
    expect(deleted.plan.deleted).toEqual(['test1.b']);
    expect(await vmFileExists('test1', `${dir}/b`)).toBe(false);

    const destroyed = await applyOnce(stack, hosts, () => {}, 'destroy');
    expect(errorsOf(destroyed)).toEqual([]);
    expect(destroyed.plan.deleted).toEqual(['test1.a']);
    expect(await vmFileExists('test1', `${dir}/a`)).toBe(false);
    expect(
        await vmRead('test1', `/opt/tunkki/${stack}/state/current.json`),
    ).toBe('{}');
});

t('a renamed task keeps a file at the same path', async () => {
    newStack('e2e-rename');
    const define = (id: string) => () =>
        on('*', () => {
            files.put(id, { content: 'kept', remotePath: `${dir}/file` });
        });
    await applyOnce(stack, hosts, define('old'));
    const renamed = await applyOnce(stack, hosts, define('new'));
    expect(errorsOf(renamed)).toEqual([]);
    expect(renamed.plan).toMatchObject({
        created: ['test1.new'],
        deleted: ['test1.old'],
    });
    // The old one is cleaned up first, so the file survives
    expect(await vmRead('test1', `${dir}/file`)).toBe('kept');
});

t('a type change cleans up with the old type first', async () => {
    newStack('e2e-retype');
    await applyOnce(stack, hosts, () =>
        on('*', () => {
            probe('x', { name: 'x', dir });
        }),
    );
    const retyped = await applyOnce(stack, hosts, () =>
        on('*', () => {
            twostep('x', { name: 'x', dir });
        }),
    );
    expect(errorsOf(retyped)).toEqual([]);
    expect(retyped.plan.replaced).toEqual(['test1.x']);
    expect(await probeLog('test1', dir)).toEqual([
        'apply x',
        'cleanup x',
        'first x',
        'last x after test1',
    ]);
});

t('deletes run after tasks that used them', async () => {
    newStack('e2e-delete-order');
    await applyOnce(stack, hosts, () =>
        on('*', () => {
            const base = probe('base', { name: 'base', dir });
            probe('user', { name: 'user', dir }, { dependencies: [base.id] });
        }),
    );
    const outcome = await applyOnce(stack, hosts, () =>
        on('*', () => {
            probe('user', { name: 'user', dir, value: 'standalone' });
        }),
    );
    expect(errorsOf(outcome)).toEqual([]);
    expect((await probeLog('test1', dir)).slice(2)).toEqual([
        'apply user',
        'cleanup base',
    ]);
});

t('a failed multi-step task retries on the next run', async () => {
    newStack('e2e-retry');
    const define = () =>
        on('*', () => {
            twostep('m', { name: 'm', dir });
        });
    await vmWrite('test1', `${dir}/m.fail`, '');
    const failed = await applyOnce(stack, hosts, define);
    expect(errorsOf(failed)).toEqual([expect.stringContaining('m failed')]);

    await vmExec('test1', `rm "${dir}/m.fail"`);
    expect((await planOnce(stack, hosts, define)).created).toEqual(['test1.m']);
    const retried = await applyOnce(stack, hosts, define);
    expect(errorsOf(retried)).toEqual([]);
    expect(await probeLog('test1', dir)).toEqual([
        'first m',
        'first m',
        'last m after test1',
    ]);
});
