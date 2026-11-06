import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
// Registers the probe task type, so that this process can destroy the stack
import './fixtures/types';
import {
    destroyStack,
    probeDir,
    probeLog,
    removeProbes,
    uniqueStack,
    vmHost,
    vmsReady,
} from './helpers';

setDefaultTimeout(120_000);
const t = test.skipIf(!(await vmsReady()));
const SCRIPT = path.join(import.meta.dir, 'fixtures', 'stack.ts');

let stack: string;
let tmp: string;
afterEach(async () => {
    await destroyStack(stack, [vmHost('test1'), vmHost('test2')]);
    await removeProbes(stack, ['test1', 'test2']);
    await fs.rm(tmp, { recursive: true, force: true });
});

async function newStack() {
    stack = uniqueStack('e2e-cli');
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-e2e-'));
}

/**
 * Runs the deploy script in a new process.
 */
async function cli(
    args: string[],
    opts: { value: string; hosts?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
        cmd: ['bun', SCRIPT, ...args, '--no-color'],
        env: {
            ...process.env,
            E2E_STACK: stack,
            E2E_DIR: probeDir(stack),
            E2E_VALUE: opts.value,
            E2E_HOSTS: opts.hosts ?? 'test1,test2',
        },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { exitCode: await proc.exited, stdout, stderr };
}

t('plan file is applied by another process', async () => {
    await newStack();
    const planFile = path.join(tmp, 'foo.plan');
    const planned = await cli(['plan', `--plan-file=${planFile}`], {
        value: 'one',
    });
    expect(planned.exitCode).toBe(0);
    expect(planned.stdout).toContain('+ test1.probe');
    expect(await probeLog('test1', probeDir(stack))).toEqual([]);

    const applied = await cli(['apply', `--plan-file=${planFile}`], {
        value: 'one',
    });
    expect(applied.stderr).toBe('');
    expect(applied.exitCode).toBe(0);
    expect(await probeLog('test1', probeDir(stack))).toEqual(['apply probe']);
    expect(await probeLog('test2', probeDir(stack))).toEqual(['apply probe']);
});

t('stale plan files are rejected', async () => {
    await newStack();
    const planFile = path.join(tmp, 'foo.plan');
    await cli(['plan', `--plan-file=${planFile}`], { value: 'one' });
    expect((await cli(['apply', '-y'], { value: 'two' })).exitCode).toBe(0);

    const stale = await cli(['apply', `--plan-file=${planFile}`], {
        value: 'one',
    });
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain('state has changed since the plan was made');
    expect(await probeLog('test1', probeDir(stack))).toEqual(['apply probe']);
});

t('plan files with unknown hosts are rejected', async () => {
    await newStack();
    const planFile = path.join(tmp, 'foo.plan');
    await cli(['plan', `--plan-file=${planFile}`], { value: 'one' });
    const missing = await cli(['apply', `--plan-file=${planFile}`], {
        value: 'one',
        hosts: 'test1',
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('plan has host test2');
});

t('plan files cannot be combined with --target', async () => {
    await newStack();
    const result = await cli(
        ['apply', '--plan-file=foo.plan', '--target', 'host=test1'],
        { value: 'one' },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('cannot be combined with --target');
});
