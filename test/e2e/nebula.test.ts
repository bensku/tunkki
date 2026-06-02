/**
 * E2E tests for Nebula overlay networking, including bridges.
 *
 * The topology is deployed as TWO stacks. A shared *base* stack (the `nebula`
 * binaries + `nebula-netavarkd` + a host lighthouse endpoint on each VM) is
 * applied first; the *workload* stack (an nginx backend per host on the
 * overlay, plus a busybox probe and a `bridged` load-balancer on test1) is
 * applied second. Sequencing the stacks guarantees netavark is running before
 * any workload endpoint applies (every endpoint's apply ends with
 * `systemctl reload nebula-netavarkd`), so workload endpoints need no explicit
 * dependency on netavark.
 *
 * WARNING: this suite (re)creates and then tears down the shared, host-global
 * Nebula base — the `nebula` podman network, `nebula-netavarkd`, and the
 * canonical `host` endpoint bound to underlay port 4242 — on the test VMs. Do
 * not run it against VMs hosting a manual Nebula deployment you care about.
 *
 * Requires Lima VMs (test/test-vms.sh) plus the sibling `../nebula`,
 * `../nebula-netavark`, `../bridged` binaries and a local `nebula-cert`;
 * nebulaReady() skips the suite cleanly when any are absent.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { nebula, on, podman } from '../..';
import { TEST_HOSTS } from '../host';
import {
    applyOnce,
    BRIDGED_BIN_DIR,
    destroyStack,
    httpGetFromContainer,
    httpGetOverNebula,
    NEBULA_BIN_DIR,
    NETAVARK_BIN_DIR,
    nebulaReady,
    relaxNicOffloads,
    TEST_VMS,
    type TestVm,
    uniqueStack,
    vmExec,
    vmFileExists,
    vmRead,
    waitForServiceState,
} from './helpers';

const network = await nebula.network(import.meta.resolve('../network.json'));

const ready = await nebulaReady();
if (!ready) {
    console.warn(
        '[nebula] preconditions not met — skipping. Run test/test-vms.sh and ' +
            'ensure ../nebula, ../nebula-netavark, ../bridged binaries plus a ' +
            'local nebula-cert.',
    );
}
const t = test.skipIf(!ready);

const BASE_STACK = uniqueStack('e2e-nebula-base');
const STACK = uniqueStack('e2e-nebula');
const hosts = TEST_HOSTS;

// Fixed overlay IPs inside the network prefix (fdce:1743:c829::/48), outside the
// dynamic pool (…:8000::/49) and distinct from both the lighthouse IPs and the
// manual scripts' IPs, so the suite can coexist with leftover manual state.
const BACKEND_IP: Record<TestVm, string> = {
    test1: 'fdce:1743:c829:e2e1::1',
    test2: 'fdce:1743:c829:e2e1::2',
    test3: 'fdce:1743:c829:e2e1::3',
};
const BRIDGE_INGRESS_IP = 'fdce:1743:c829:e2eb::1';

// ---- Stack 1: shared Nebula base (netavark + host lighthouse endpoints) ----
const defineBase = () => {
    on('*', (host) => {
        const setup = nebula.setup('nebula-setup', {
            localPath: NEBULA_BIN_DIR,
        });
        const netavark = nebula.netavarkSetup(
            'netavark-setup',
            { localPath: NETAVARK_BIN_DIR },
            { after: [setup.id] },
        );
        // Reuse the canonical id `host` so a stale manual nebula-host unit is
        // overwritten (one daemon binds port 4242) rather than duplicated. The
        // endpoint must run after netavark — its apply reloads nebula-netavarkd.
        const hostEndpoint = nebula.endpoint(
            'host-endpoint',
            {
                network,
                id: 'host',
                hostname: `${host.id}.nebula.test`,
                ip: host.tags?.hostVpnIp, // test1/test2 == lighthouse IPs
                underlay: { port: 4242 },
                groups: ['host'],
                firewall: {
                    outbound: [{ port: 'any', host: 'any' }],
                    inbound: [{ port: 'any', host: 'any' }],
                },
            },
            { after: [setup.id, netavark.id] },
        );
        hostEndpoint.service();
    });
};

// ---- Stack 2: workloads (backends everywhere; probe + bridge on test1) ----
const defineWorkload = () => {
    on('*', (host) => {
        const cfg = `server {
    listen 80;
    listen [::]:80;
    location / { return 200 'healthy host ${host.id}'; }
}`;
        const backend = podman.container('e2e-backend', {
            name: 'e2e-backend',
            image: 'docker.io/library/nginx:latest',
            configFiles: [['/etc/nginx/conf.d/default.conf', cfg]],
        });
        backend.connectNebula({
            network,
            ip: BACKEND_IP[host.id as TestVm],
            hostname: `${host.id}.e2e-backend.nebula.test`,
            groups: ['e2e-backend'],
            firewall: [['in', 80, 'any']],
        });
    });

    on('test1', () => {
        // busybox keeps a shell alive so we can `podman exec` wget/nslookup; the
        // nginx image has neither. allow-all-outbound covers DNS (:53) + HTTP.
        const probe = podman.container('e2e-probe', {
            name: 'e2e-probe',
            image: 'docker.io/library/busybox:latest',
            exec: ['sh', '-c', 'while true; do sleep 3600; done'],
            // The nebula-netavark plugin doesn't hand containers a Nebula
            // resolver, so point this probe's DNS straight at the lighthouse
            // overlay IPs (the lighthouses run serve_dns on :53). That's what
            // makes *.nebula.test resolve from inside the container.
            dns: network.lighthouses.map((lh) => lh.vpnIp),
        });
        probe.connectNebula({
            network,
            hostname: 'test1.e2e-probe.nebula.test',
            groups: ['e2e-probe'],
            firewall: [['out', 'any', 'any']],
        });

        const bridgeSetup = nebula.bridgedSetup('bridge-setup', {
            localPath: BRIDGED_BIN_DIR,
        });
        nebula.bridge(
            'e2e-bridge',
            {
                id: 'e2e-test',
                ingress: {
                    network,
                    hostname: 'e2e-bridge.nebula.test',
                    ip: BRIDGE_INGRESS_IP,
                    groups: ['e2e-bridge-in'],
                    firewall: [['in', 80, 'any']],
                },
                egress: {
                    network,
                    hostname: 'test1.e2e-bridge-out.nebula.test',
                    groups: ['e2e-bridge-out'],
                    firewall: [['out', 80, 'any']],
                },
                routes: [
                    {
                        listen: ':80',
                        targets: [
                            `[${BACKEND_IP.test1}]:80`,
                            `[${BACKEND_IP.test2}]:80`,
                            `[${BACKEND_IP.test3}]:80`,
                        ],
                        type: 'first_healthy',
                        // Fast health so failover is deterministic within the
                        // test timeout (manual script uses 10s/3s).
                        health: {
                            interval: '2s',
                            timeout: '1s',
                            window: 2,
                            ok_threshold: 1,
                            fail_threshold: 1,
                        },
                    },
                ],
            },
            { after: [bridgeSetup.id] },
        );
    });
};

beforeAll(async () => {
    if (!ready) return;

    // Work around a QEMU socket-netdev abort on lima:user-v2 under inter-VM
    // traffic (see relaxNicOffloads). Best-effort; applied before any traffic.
    for (const vm of TEST_VMS) await relaxNicOffloads(vm);

    const base = await applyOnce(BASE_STACK, hosts, defineBase);
    for (const r of base.results) expect(r.errored).toEqual([]);
    for (const vm of TEST_VMS) {
        await waitForServiceState(
            vm,
            'nebula-netavarkd.service',
            'active',
            30_000,
        );
        await waitForServiceState(vm, 'nebula-host.service', 'active', 30_000);
    }

    const wl = await applyOnce(STACK, hosts, defineWorkload);
    for (const r of wl.results) expect(r.errored).toEqual([]);
    for (const vm of TEST_VMS) {
        await waitForServiceState(vm, 'e2e-backend.service', 'active', 60_000);
    }
    await waitForServiceState('test1', 'e2e-probe.service', 'active', 60_000);
    await waitForServiceState(
        'test1',
        'bridged-e2e-test.service',
        'active',
        30_000,
    );
}, 240_000);

afterAll(async () => {
    if (!ready) return;
    // Reverse order: workloads first (containers gone), then the base — so the
    // `nebula` network has no attached containers when it is deleted. The
    // synthetic delete tasks run unordered, so destroying the workload stack
    // first is what actually sequences containers before the network.
    // Best-effort: a teardown race must not mask a test failure.
    try {
        await destroyStack(STACK, hosts);
    } catch {
        // ignore
    }
    try {
        await destroyStack(BASE_STACK, hosts);
    } catch {
        // ignore
    }
}, 180_000);

t(
    'base: nebula configs, certs, netavark plugin, and podman network exist',
    async () => {
        for (const vm of TEST_VMS) {
            expect(
                await vmFileExists(vm, '/etc/containers/nebula/host.yml'),
            ).toBe(true);
            expect(
                await vmFileExists(vm, '/etc/nebula/endpoints/host/host.crt'),
            ).toBe(true);
            expect(
                await vmFileExists(vm, '/etc/nebula/endpoints/host/host.key'),
            ).toBe(true);
            expect(await vmFileExists(vm, '/usr/local/bin/nebula')).toBe(true);
            expect(
                await vmFileExists(vm, '/usr/local/lib/netavark/nebula'),
            ).toBe(true);
            const nets = await vmExec(
                vm,
                'podman network ls --format "{{.Name}}"',
            );
            expect(nets.stdout).toContain('nebula');
        }
        // Lighthouse auto-detection: test1/test2 (their IP == a lighthouse
        // vpnIp) serve DNS; test3 does not.
        expect(
            await vmRead('test1', '/etc/containers/nebula/host.yml'),
        ).toContain('"am_lighthouse":true');
        expect(
            await vmRead('test2', '/etc/containers/nebula/host.yml'),
        ).toContain('"am_lighthouse":true');
        expect(
            await vmRead('test3', '/etc/containers/nebula/host.yml'),
        ).not.toContain('"am_lighthouse":true');
    },
    30_000,
);

t(
    'backend: endpoint config/cert exist and the container is on the nebula network',
    async () => {
        for (const vm of TEST_VMS) {
            expect(
                await vmFileExists(
                    vm,
                    '/etc/containers/nebula/e2e-backend.yml',
                ),
            ).toBe(true);
            expect(
                await vmFileExists(
                    vm,
                    '/etc/nebula/endpoints/e2e-backend/host.crt',
                ),
            ).toBe(true);
            const insp = await vmExec(
                vm,
                "podman inspect e2e-backend --format '{{json .NetworkSettings.Networks}}'",
            );
            expect(insp.stdout).toContain('nebula');
        }
    },
    30_000,
);

t(
    'overlay: each backend is reachable by IP over Nebula from another host',
    async () => {
        const probes: [TestVm, TestVm][] = [
            ['test2', 'test1'],
            ['test3', 'test2'],
            ['test1', 'test3'],
        ];
        for (const [from, target] of probes) {
            const body = await httpGetOverNebula(from, BACKEND_IP[target], {
                expectBody: `healthy host ${target}`,
                timeoutMs: 90_000,
            });
            expect(body).toContain(`healthy host ${target}`);
        }
    },
    120_000,
);

t(
    "dns: a container reaches another host's backend by Nebula hostname",
    async () => {
        const body = await httpGetFromContainer(
            'test1',
            'e2e-probe',
            'http://test2.e2e-backend.nebula.test/',
            { expectBody: 'healthy host test2', timeoutMs: 90_000 },
        );
        expect(body).toContain('healthy host test2');
    },
    120_000,
);

t(
    'dns: container resolv.conf uses a Nebula resolver and names resolve',
    async () => {
        const probeResolv = (
            await vmExec('test1', 'podman exec e2e-probe cat /etc/resolv.conf')
        ).stdout;
        // We configured the probe's DNS to the lighthouse overlay IPs, so its
        // resolv.conf must list a lighthouse (the host has no Nebula resolver).
        expect(probeResolv).toContain(network.lighthouses[0]!.vpnIp);

        // nslookup of a *.nebula.test name should return an overlay address.
        // Retry briefly: the lighthouse DNS path warms up with the handshake.
        const deadline = Date.now() + 30_000;
        let out = '';
        while (Date.now() < deadline) {
            const r = await vmExec(
                'test1',
                'podman exec e2e-probe nslookup test2.e2e-backend.nebula.test',
            );
            out = r.stdout;
            if (out.includes('fdce:1743:c829')) break;
            await Bun.sleep(500);
        }
        expect(out).toContain('fdce:1743:c829');
    },
    60_000,
);

t(
    'bridge: ingress proxies to a healthy backend over Nebula',
    async () => {
        const body = await httpGetOverNebula('test3', BRIDGE_INGRESS_IP, {
            expectBody: 'healthy host',
            timeoutMs: 90_000,
        });
        expect(body).toMatch(/healthy host test[123]/);
    },
    120_000,
);

t(
    'bridge: fails over when the active backend goes down',
    async () => {
        const before = await httpGetOverNebula('test3', BRIDGE_INGRESS_IP, {
            expectBody: 'healthy host',
            timeoutMs: 90_000,
        });
        const m = before.match(/healthy host (test[123])/);
        expect(m).not.toBeNull();
        const active = m![1] as TestVm;

        try {
            const stop = await vmExec(
                active,
                'systemctl stop e2e-backend.service',
            );
            expect(stop.exitCode).toBe(0);

            // interval 2s / fail_threshold 1 → bridged should reroute within a
            // few seconds. Poll until a 200 comes from a different backend.
            const deadline = Date.now() + 60_000;
            let got = '';
            while (Date.now() < deadline) {
                try {
                    got = await httpGetOverNebula('test3', BRIDGE_INGRESS_IP, {
                        expectBody: 'healthy host',
                        timeoutMs: 5_000,
                    });
                    if (!got.includes(`healthy host ${active}`)) break;
                } catch {
                    // transient window where all targets look unhealthy
                }
                await Bun.sleep(500);
            }
            expect(got).toMatch(/healthy host test[123]/);
            expect(got).not.toContain(`healthy host ${active}`);
        } finally {
            await vmExec(active, 'systemctl start e2e-backend.service');
            await waitForServiceState(
                active,
                'e2e-backend.service',
                'active',
                30_000,
            );
        }
    },
    120_000,
);
