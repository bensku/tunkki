import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, type Host, type Plan, protocols, type Result } from '../..';
import * as builder from '../../local/builder';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const AGENT_BINARY = join(REPO_ROOT, 'tunkki');

/**
 * Nebula-related binaries live as SIBLINGS of the tunkki repo (one level above
 * REPO_ROOT). The setup tasks (`nebula.setup`, `nebula.netavarkSetup`,
 * `nebula.bridgedSetup`) read them through their `localPath`. Resolved from
 * REPO_ROOT so they don't depend on the test runner's cwd.
 */
export const NEBULA_BIN_DIR = join(REPO_ROOT, '..', 'nebula'); // nebula, nebula-cert
export const NETAVARK_BIN_DIR = join(REPO_ROOT, '..', 'nebula-netavark'); // nebula-netavarkd, nebula-netavark-plugin
export const BRIDGED_BIN_DIR = join(REPO_ROOT, '..', 'bridged'); // bridged

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

/**
 * Nebula E2E preconditions, layered on top of {@link vmsReady}:
 *  - vmsReady() is satisfied (Lima up, agent uploaded),
 *  - the five Nebula binaries exist locally — the setup tasks upload them to
 *    the VMs,
 *  - `nebula-cert` is on the LOCAL PATH — endpoint cert signing runs in a
 *    `local` step as a bare `nebula-cert sign` (task/nebula/endpoint.ts).
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
    const required = [
        join(NEBULA_BIN_DIR, 'nebula'),
        join(NEBULA_BIN_DIR, 'nebula-cert'),
        join(NETAVARK_BIN_DIR, 'nebula-netavarkd'),
        join(NETAVARK_BIN_DIR, 'nebula-netavark-plugin'),
        join(BRIDGED_BIN_DIR, 'bridged'),
    ];
    for (const f of required) {
        if (!(await Bun.file(f).exists())) {
            console.warn(`[nebula] missing local binary: ${f}`);
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

/**
 * Probe an HTTP endpoint over the Nebula overlay FROM a host (hosts have curl;
 * the nginx image does not). Retries every 500ms until the response is 200 and
 * — if `expectBody` is given — its body contains that substring, or the
 * deadline passes. Returns the matching body.
 *
 * Overlay reachability needs lighthouse registration + a Nebula handshake after
 * the daemons start, which is not synchronous with `systemctl is-active`, so a
 * single shot is racy. `-g` lets curl accept a bracketed literal IPv6 host. We
 * fetch the status code and the body in one shell line so an empty-body 200 is
 * not mistaken for a connection failure.
 */
export async function httpGetOverNebula(
    fromVm: TestVm,
    ipv6: string,
    opts: {
        port?: number;
        path?: string;
        expectBody?: string;
        timeoutMs?: number;
    } = {},
): Promise<string> {
    const { port = 80, path = '/', expectBody, timeoutMs = 60_000 } = opts;
    const url = `http://[${ipv6}]:${port}${path}`;
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        const r = await vmExec(
            fromVm,
            `curl -g -s -o /dev/null -w '%{http_code}' --max-time 3 '${url}'; echo; curl -g -s --max-time 3 '${url}' || true`,
        );
        const nl = r.stdout.indexOf('\n');
        const code = (nl >= 0 ? r.stdout.slice(0, nl) : r.stdout).trim();
        const body = nl >= 0 ? r.stdout.slice(nl + 1) : '';
        last = `code=${code} body=${body.trim().slice(0, 80)}`;
        if (
            code === '200' &&
            (expectBody === undefined || body.includes(expectBody))
        ) {
            return body;
        }
        await Bun.sleep(500);
    }
    throw new Error(
        `httpGetOverNebula(${fromVm} -> ${url}) never succeeded within ${timeoutMs}ms (last: ${last})`,
    );
}

/**
 * Probe an HTTP URL from INSIDE a container via `podman exec <container> wget`.
 * When `url` uses a `*.nebula.test` hostname this exercises Nebula DNS
 * resolution end-to-end (you can't fetch by name without resolving it first).
 * Retries until the body matches `expectBody` (if given) or the deadline passes.
 */
export async function httpGetFromContainer(
    vm: TestVm,
    container: string,
    url: string,
    opts: { expectBody?: string; timeoutMs?: number } = {},
): Promise<string> {
    const { expectBody, timeoutMs = 60_000 } = opts;
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        const r = await vmExec(
            vm,
            `podman exec ${container} wget -q -T 3 -O - '${url}'`,
        );
        const body = r.stdout;
        last = `exit=${r.exitCode} body=${body.trim().slice(0, 80)}`;
        if (
            r.exitCode === 0 &&
            (expectBody === undefined || body.includes(expectBody))
        ) {
            return body;
        }
        await Bun.sleep(500);
    }
    throw new Error(
        `httpGetFromContainer(${vm}/${container} -> ${url}) never succeeded within ${timeoutMs}ms (last: ${last})`,
    );
}

/**
 * Best-effort workaround for a QEMU `socket`-netdev abort seen on
 * `lima:user-v2` under inter-VM traffic:
 *
 *   qemu-system-x86_64: net/net.c: net_fill_rstate: Assertion `size == 0' failed.
 *
 * QEMU's socket netdev frames each packet with a 4-byte length prefix; a frame
 * larger than its receive buffer (~64KiB) desyncs the framing and aborts the
 * VM. Disabling receive coalescing (GRO) and capping GSO sizing on the guest
 * virtio-net NIC keeps frames small.
 *
 * NOTE: on virtio_net most TX segmentation offloads are already `off [fixed]`,
 * so the guest usually can't emit oversized frames itself — if the crash
 * persists, the oversized frames originate in the host-side user-v2 stack and
 * the real fix is a different VM network backend (e.g. socket_vmnet), not this.
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
