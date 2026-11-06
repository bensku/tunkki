import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    connect,
    type Event,
    type Host,
    type Plan,
    type PlanMode,
    protocols,
    type Result,
} from '../..';
import * as builder from '../../local/builder';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const AGENT_BINARY = join(REPO_ROOT, 'tunkki');

/**
 * Nebula binaries live as a SIBLING of the tunkki repo (one level above
 * REPO_ROOT). nebula.setup reads them through its `localPath`. Resolved from
 * REPO_ROOT so they don't depend on the test runner's cwd.
 */
export const NEBULA_BIN_DIR = join(REPO_ROOT, '..', 'nebula'); // nebula, nebula-cert

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
 * Returns true if Lima is on PATH and all expected VMs are running. The agent
 * is built from this checkout and uploaded to each VM, so that the VMs never
 * run an outdated one.
 *
 * Memoized, since building and uploading takes a while.
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

    // 3. Build the agent
    const build = Bun.spawn({
        cmd: ['bun', 'run', join(REPO_ROOT, 'build.ts')],
        cwd: REPO_ROOT,
        stdout: 'inherit',
        stderr: 'inherit',
    });
    await build.exited;
    if (build.exitCode !== 0) throw new Error('failed to build agent binary');

    // 4. Upload it where it differs. Uploads are large, and large transfers
    // can crash QEMU (see relaxNicOffloads)
    const hash = Bun.CryptoHasher.hash(
        'sha256',
        await Bun.file(AGENT_BINARY).bytes(),
        'hex',
    );
    await Promise.all(
        TEST_VMS.map(async (vm) => {
            const remote = await vmExec(
                vm,
                'sha256sum /opt/tunkki/tunkki 2>/dev/null || true',
            );
            if (remote.stdout.startsWith(hash)) return;
            await relaxNicOffloads(vm);
            const ok = await vmConn(vm).upload(
                AGENT_BINARY,
                '/opt/tunkki/tunkki',
            );
            if (!ok) throw new Error(`agent upload to ${vm} failed`);
        }),
    );
    return true;
}

/**
 * Nebula E2E preconditions, layered on top of {@link vmsReady}:
 *  - vmsReady() is satisfied (Lima up, agent uploaded),
 *  - the Nebula binaries exist locally — nebula.setup uploads them to the VMs,
 *  - `nebula-cert` is on the LOCAL PATH — endpoint cert signing runs in a
 *    `local` step as a bare `nebula-cert sign` (task/nebula/endpoint.ts),
 *  - /usr/bin is writable on test1, since nebula.setup installs there. It is
 *    not on MicroOS, which test/test-vms.sh sets up.
 *
 * Memoized like {@link vmsReady}; warns and returns false (→ tests skip) when a
 * precondition is unmet.
 */
let nebulaReadyPromise: Promise<boolean> | undefined;
export function nebulaReady(): Promise<boolean> {
    if (!nebulaReadyPromise) nebulaReadyPromise = checkNebula();
    return nebulaReadyPromise;
}

async function checkNebula(): Promise<boolean> {
    if (!(await vmsReady())) return false;
    for (const binary of ['nebula', 'nebula-cert']) {
        const path = join(NEBULA_BIN_DIR, binary);
        if (!(await Bun.file(path).exists())) {
            console.warn(`[nebula] missing local binary: ${path}`);
            return false;
        }
    }
    const haveCert = await Bun.spawn({
        cmd: ['sh', '-c', 'command -v nebula-cert'],
        stdout: 'ignore',
        stderr: 'ignore',
    }).exited;
    if (haveCert !== 0) {
        console.warn(
            '[nebula] nebula-cert not on local PATH (needed for cert signing)',
        );
        return false;
    }
    const writable = await vmExec(
        'test1',
        'touch /usr/bin/.tunkki-e2e && rm /usr/bin/.tunkki-e2e',
    );
    if (writable.exitCode !== 0) {
        console.warn('[nebula] /usr/bin on test1 is read-only');
        return false;
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
    plan: Plan;
    results: Result[];
    events: Event[];
}

/**
 * Run one full plan→execute→close cycle. The caller's `define` callback
 * registers tasks via the global builder (`on(...)`, `files.put(...)`, etc.).
 * The task list is cleared before and after so tests can't interfere with
 * each other.
 */
export async function applyOnce(
    stack: string,
    hosts: Host[],
    define: () => void,
    mode: PlanMode = 'apply',
): Promise<ApplyOutcome> {
    clearTasks();
    try {
        define();
        const pool = await connect(hosts);
        try {
            const plan = await pool.plan(stack, mode);
            const events: Event[] = [];
            const results = await pool.execute(plan, (event) =>
                events.push(event),
            );
            return { plan, results, events };
        } finally {
            await pool.close();
        }
    } finally {
        clearTasks();
    }
}

/**
 * Plans without applying.
 */
export async function planOnce(
    stack: string,
    hosts: Host[],
    define: () => void,
): Promise<Plan> {
    clearTasks();
    try {
        define();
        const pool = await connect(hosts);
        try {
            return await pool.plan(stack);
        } finally {
            await pool.close();
        }
    } finally {
        clearTasks();
    }
}

/**
 * Tear down a stack on the given hosts. Meant for `finally` blocks, so errors
 * are logged rather than thrown, to not mask the original test failure.
 */
export async function destroyStack(stack: string, hosts: Host[]) {
    try {
        const { results } = await applyOnce(stack, hosts, () => {}, 'destroy');
        const failed = results.filter((r) => r.errored.length > 0 || r.error);
        if (failed.length > 0) {
            console.warn(`destroying ${stack} failed:`, failed);
        }
    } catch (e) {
        console.warn(`destroying ${stack} failed:`, e);
    }
}

/** Convenience: a unique stack name per test run. */
export function uniqueStack(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
}

/** Directory on the VMs for probe tasks of a stack. */
export function probeDir(stack: string): string {
    return `/var/tmp/tunkki-e2e/${stack}`;
}

/** Lines that probe tasks have logged on a VM, or [] if none. */
export async function probeLog(vm: TestVm, dir: string): Promise<string[]> {
    const r = await vmExec(vm, `cat "${dir}/log" 2>/dev/null || true`);
    return r.stdout.split('\n').filter((line) => line.length > 0);
}

/** Removes probe directories of a stack from VMs. */
export async function removeProbes(stack: string, vms: readonly TestVm[]) {
    await Promise.all(
        vms.map((vm) => vmExec(vm, `rm -rf "${probeDir(stack)}"`)),
    );
}

/** Errors of an apply, both task and host errors. */
export function errorsOf(outcome: ApplyOutcome): string[] {
    return outcome.results.flatMap((r) => [
        ...r.errored.map((e) => `${e.taskId}: ${e.error}`),
        ...(r.error ? [`${r.host}: ${r.error}`] : []),
    ]);
}

/** Index of the first event matching the given filter. */
export function eventIndex(
    events: Event[],
    host: string,
    type: Event['type'],
    taskId?: string,
): number {
    return events.findIndex(
        (e) =>
            e.host.id === host &&
            e.type === type &&
            (taskId === undefined || e.taskId === taskId),
    );
}

/**
 * Best-effort workaround for a QEMU `socket`-netdev abort seen on
 * `lima:user-v2` under heavy traffic:
 *
 *   qemu-system-x86_64: net/net.c: net_fill_rstate: Assertion `size == 0' failed.
 *
 * QEMU's socket netdev frames each packet with a 4-byte length prefix; a frame
 * larger than its receive buffer (~64KiB) desyncs the framing and aborts the
 * VM. Disabling receive coalescing (GRO) and capping GSO sizing on the guest
 * virtio-net NIC keeps frames small. If the crash persists, the oversized
 * frames come from the host side, and the real fix is a different VM network
 * backend (e.g. socket_vmnet).
 */
export async function relaxNicOffloads(vm: TestVm): Promise<void> {
    await vmExec(
        vm,
        `for n in /sys/class/net/*; do
            ifc=$(basename "$n")
            [ "$(basename "$(readlink "$n/device/driver" 2>/dev/null)" 2>/dev/null)" = virtio_net ] || continue
            ethtool -K "$ifc" gro off gso off tso off lro off sg off 2>/dev/null
            ip link set dev "$ifc" gso_max_size 1500 gso_max_segs 1 2>/dev/null
        done; true`,
    );
}
