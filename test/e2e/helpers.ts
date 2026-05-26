import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, type Host, type Plan, protocols, type Result } from '../..';
import * as builder from '../../local/builder';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const AGENT_BINARY = join(REPO_ROOT, 'tunkki');

/**
 * VMs the E2E suite expects to find provisioned via Lima. Match the names in
 * test/test-vms.sh.
 */
export const TEST_VMS = ['test1', 'test2', 'test3'] as const;
export type TestVm = (typeof TEST_VMS)[number];

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Run a shell command on a Lima VM as root. Returns stdout/stderr/exitCode
 * rather than throwing on non-zero exit, so callers can assert on either
 * success or expected failures.
 */
export async function vmExec(vm: TestVm, cmd: string): Promise<ExecResult> {
    const proc = Bun.spawn({
        cmd: ['limactl', 'shell', vm, 'sudo', 'sh', '-c', cmd],
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { stdout, stderr, exitCode: proc.exitCode ?? -1 };
}

/** Write `content` to `path` on `vm` (creates parent directories, sudo). */
export async function vmWrite(
    vm: TestVm,
    path: string,
    content: string,
): Promise<void> {
    const proc = Bun.spawn({
        cmd: [
            'limactl',
            'shell',
            vm,
            'sudo',
            'sh',
            '-c',
            `mkdir -p "$(dirname "${path}")" && tee "${path}" >/dev/null`,
        ],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    proc.stdin.write(content);
    await proc.stdin.end();
    await proc.exited;
    if (proc.exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`vmWrite ${vm}:${path} failed: ${err.trim()}`);
    }
}

/** Read a file from a VM. Throws if the file does not exist. */
export async function vmRead(vm: TestVm, path: string): Promise<string> {
    const r = await vmExec(vm, `cat "${path}"`);
    if (r.exitCode !== 0) {
        throw new Error(`vmRead ${vm}:${path} failed: ${r.stderr.trim()}`);
    }
    return r.stdout;
}

export async function vmFileExists(vm: TestVm, path: string): Promise<boolean> {
    const r = await vmExec(vm, `test -e "${path}"`);
    return r.exitCode === 0;
}

/**
 * Wait for `systemctl is-active <name>` to report the given state, polling
 * with exponential-ish backoff up to ~5s. systemd state changes after
 * `systemctl restart` are not synchronous, so a single check is racy.
 */
export async function waitForServiceState(
    vm: TestVm,
    unit: string,
    expected: 'active' | 'inactive' | 'failed',
    timeoutMs = 5000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        const r = await vmExec(vm, `systemctl is-active ${unit} 2>&1 || true`);
        last = r.stdout.trim();
        if (last === expected) return;
        await Bun.sleep(150);
    }
    throw new Error(
        `${vm}: ${unit} did not become ${expected} within ${timeoutMs}ms (last: ${last})`,
    );
}

/**
 * Returns true if Lima is on PATH, all expected VMs are running, AND each one
 * has the agent binary installed at /opt/tunkki/tunkki. The agent is uploaded
 * automatically if missing — we still need a local binary, so build it if
 * needed.
 *
 * On the first call this can take a few seconds (binary build + uploads).
 * Subsequent calls are cheap (memoized).
 */
let readyPromise: Promise<boolean> | undefined;
export function vmsReady(): Promise<boolean> {
    if (!readyPromise) readyPromise = checkAndPrep();
    return readyPromise;
}

async function checkAndPrep(): Promise<boolean> {
    // 1. Lima available?
    const which = await Bun.spawn({
        cmd: ['sh', '-c', 'command -v limactl'],
        stdout: 'pipe',
        stderr: 'ignore',
    }).exited;
    if (which !== 0) return false;

    // 2. All expected VMs running?
    const lsProc = Bun.spawn({
        cmd: ['limactl', 'ls', '-q'],
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const ls = (await new Response(lsProc.stdout).text()).split('\n');
    for (const vm of TEST_VMS) {
        if (!ls.includes(vm)) return false;
    }

    // 3. Build the local binary if absent.
    if (!(await Bun.file(AGENT_BINARY).exists())) {
        const build = Bun.spawn({
            cmd: ['bun', 'run', join(REPO_ROOT, 'build.ts')],
            cwd: REPO_ROOT,
            stdout: 'inherit',
            stderr: 'inherit',
        });
        await build.exited;
        if (build.exitCode !== 0)
            throw new Error('failed to build agent binary');
    }

    // 4. Upload the agent to each VM that doesn't yet have it.
    for (const vm of TEST_VMS) {
        if (await vmFileExists(vm, '/opt/tunkki/tunkki')) continue;
        const ok = await vmConn(vm).upload(AGENT_BINARY, '/opt/tunkki/tunkki');
        if (!ok) throw new Error(`agent upload to ${vm} failed`);
    }

    return true;
}

/** A `Connector` that runs the agent on a Lima VM via `limactl shell sudo`. */
export function vmConn(vm: TestVm) {
    return protocols.proxyCmd(
        ['limactl', 'shell', vm, 'sudo', '/opt/tunkki/tunkki'],
        [
            'sh',
            '-c',
            `limactl shell ${vm} sudo sh -c 'mkdir -p "$(dirname "$0")" && tee "$0" >/dev/null && chmod +x "$0"' "$REMOTE_PATH" < "$LOCAL_PATH"`,
        ],
    );
}

/** A `Host` referencing a VM. */
export function vmHost(vm: TestVm): Host {
    return { id: vm, conn: vmConn(vm) };
}

/**
 * Reset all builder state (sources + loaded tasks). Bun's test runner shares
 * module state across tests in the same file; without this, sources or tasks
 * defined in test A would leak into test B.
 */
export function clearTasks(): void {
    builder.clearAll();
}

export interface ApplyOutcome {
    plans: Plan[];
    results: Result[];
}

/**
 * Run one full plan→execute→close cycle. The caller's `define` callback
 * registers tasks via the global builder (`podman.container(...)`,
 * `systemd.service(...)`, etc.). The task list is cleared before and after so
 * tests can't interfere with each other. Pass mode='destroy' to exercise the
 * destroy path while the same tasks are still defined.
 */
export async function applyOnce(
    stack: string,
    hosts: Host[],
    define: () => void,
    mode: 'apply' | 'destroy' | 'reapply' = 'apply',
): Promise<ApplyOutcome> {
    clearTasks();
    try {
        define();
        const pool = await connect(hosts);
        try {
            const plans = await pool.plan(stack, mode);
            const results = await pool.execute(plans);
            return { plans, results };
        } finally {
            await pool.close();
        }
    } finally {
        clearTasks();
    }
}

/**
 * Tear down a stack on the given hosts: connects, plans with no tasks (so the
 * remote diffs everything as deleted), executes the cleanup steps, closes.
 *
 * Best-effort: meant for `finally` blocks. Errors are swallowed so a failed
 * teardown doesn't mask the original test failure — but is logged via the
 * returned Result list, which the caller can inspect.
 */
export async function destroyStack(
    stack: string,
    hosts: Host[],
): Promise<Result[]> {
    clearTasks();
    const pool = await connect(hosts);
    try {
        const plans = await pool.plan(stack, 'destroy');
        return await pool.execute(plans);
    } finally {
        await pool.close();
        clearTasks();
    }
}

/** Convenience: a unique stack name per test run. */
export function uniqueStack(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
}
