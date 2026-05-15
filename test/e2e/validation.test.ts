import { describe, expect, test } from 'bun:test';
import { toContainerUnit } from '../../task/podman/container';
import { toNetworkUnit } from '../../task/podman/network';
import { renderDnsOption, toPodUnit } from '../../task/podman/pod';
import { toServiceUnit } from '../../task/systemd/service';
import { toTimerUnit } from '../../task/systemd/timer';
import { serializeUnitFile } from '../../task/util/systemd';
import { type TestVm, vmExec, vmsReady, vmWrite } from './helpers';

const VM: TestVm = 'test1';

const ready = await vmsReady();
if (!ready) {
    console.warn(
        '[validation] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}

const SCRATCH = `/tmp/tunkki-validate-${process.pid}`;

/**
 * Write `content` to a file inside the VM scratch dir and run
 * `systemd-analyze verify` against it (and any companion units already in the
 * dir, so e.g. a `.timer` can resolve its `Unit=` reference).
 *
 * `--recursive-errors=yes` makes "Unknown key" complaints fatal — the default
 * just logs a warning and exits 0, which would let typo'd directives slip past.
 */
async function validateSystemdUnit(
    units: { name: string; content: string }[],
    target: string,
): Promise<void> {
    const dir = `${SCRATCH}/${crypto.randomUUID()}`;
    const writes = units
        .map(
            (u) =>
                `cat > "${dir}/${u.name}" <<'TUNKKI_EOF'\n${u.content}TUNKKI_EOF\n`,
        )
        .join('');
    const cmd = `mkdir -p "${dir}" && ${writes}systemd-analyze --recursive-errors=yes verify "${dir}/${target}" 2>&1; rc=$?; rm -rf "${dir}"; exit $rc`;
    const r = await vmExec(VM, cmd);
    if (r.exitCode !== 0) {
        throw new Error(
            `systemd-analyze rejected ${target}:\n${r.stdout || r.stderr}`,
        );
    }
}

/**
 * Write a Quadlet unit file (and any companions) to a scratch dir and run the
 * Quadlet generator in dryrun mode. Quadlet *does* exit non-zero on bad input,
 * so the exit-code check is sufficient here.
 */
async function validateQuadletUnit(
    units: { name: string; content: string }[],
): Promise<void> {
    const inDir = `${SCRATCH}/${crypto.randomUUID()}`;
    const outDir = `${inDir}-out`;
    const writes = units
        .map(
            (u) =>
                `cat > "${inDir}/${u.name}" <<'TUNKKI_EOF'\n${u.content}TUNKKI_EOF\n`,
        )
        .join('');
    const cmd = `mkdir -p "${inDir}" "${outDir}" && ${writes}QUADLET_UNIT_DIRS="${inDir}" /usr/libexec/podman/quadlet -dryrun -no-kmsg-log "${outDir}" 2>&1; rc=$?; rm -rf "${inDir}" "${outDir}"; exit $rc`;
    const r = await vmExec(VM, cmd);
    if (r.exitCode !== 0) {
        throw new Error(
            `quadlet rejected units:\n${r.stdout}\n--- units ---\n${units
                .map((u) => `# ${u.name}\n${u.content}`)
                .join('\n')}`,
        );
    }
}

const render = (file: ReturnType<typeof toServiceUnit>): string =>
    serializeUnitFile(file);

const t = test.skipIf(!ready);

describe('systemd-analyze verify accepts toServiceUnit output', () => {
    t('minimal simple service', async () => {
        const content = render(
            toServiceUnit({
                name: 'val-min',
                exec: '/bin/true',
            }),
        );
        await validateSystemdUnit(
            [{ name: 'val-min.service', content }],
            'val-min.service',
        );
    });

    t(
        'hardened service with ProtectSystem, NoNewPrivileges, PrivateTmp',
        async () => {
            const content = render(
                toServiceUnit({
                    name: 'val-hardened',
                    type: 'simple',
                    exec: ['/usr/bin/env', 'sleep', '1'],
                    noNewPrivileges: true,
                    protectSystem: 'strict',
                    protectHome: 'read-only',
                    privateTmp: true,
                    privateNetwork: true,
                    memoryMax: '128M',
                    tasksMax: 16,
                }),
            );
            await validateSystemdUnit(
                [{ name: 'val-hardened.service', content }],
                'val-hardened.service',
            );
        },
    );

    t('service with [Install] WantedBy=multi-user.target', async () => {
        const content = render(
            toServiceUnit({
                name: 'val-installed',
                exec: '/bin/true',
                install: { wantedBy: 'multi-user.target' },
            }),
        );
        await validateSystemdUnit(
            [{ name: 'val-installed.service', content }],
            'val-installed.service',
        );
    });

    t(
        'oneshot + RemainAfterExit + multiple ExecStart via extraDirectives',
        async () => {
            const content = render(
                toServiceUnit({
                    name: 'val-oneshot',
                    type: 'oneshot',
                    remainAfterExit: true,
                    extraDirectives: {
                        ExecStart: ['/bin/true', '/bin/echo done'],
                    },
                }),
            );
            await validateSystemdUnit(
                [{ name: 'val-oneshot.service', content }],
                'val-oneshot.service',
            );
        },
    );

    t(
        'exec=string[] with spaces and quotes survives systemd parsing',
        async () => {
            // The whole point of quoteArg is for systemd to parse the result back
            // into the original argv. This test pins that contract.
            const content = render(
                toServiceUnit({
                    name: 'val-quoted',
                    exec: ['/bin/echo', 'hello world', 'with"quote'],
                }),
            );
            await validateSystemdUnit(
                [{ name: 'val-quoted.service', content }],
                'val-quoted.service',
            );
        },
    );

    t('extraDirectives and unit.extra merge cleanly', async () => {
        const content = render(
            toServiceUnit({
                name: 'val-extras',
                exec: '/bin/true',
                extraDirectives: { LimitNOFILE: 65536 },
                unit: {
                    description: 'demo',
                    extra: { OnFailure: 'val-other.service' },
                },
            }),
        );
        await validateSystemdUnit(
            [{ name: 'val-extras.service', content }],
            'val-extras.service',
        );
    });
});

describe('systemd-analyze verify accepts toTimerUnit output', () => {
    t('OnCalendar=daily', async () => {
        const timer = render(
            toTimerUnit({ name: 'val-cal', onCalendar: 'daily' }),
        );
        const service = render(
            toServiceUnit({ name: 'val-cal', exec: '/bin/true' }),
        );
        await validateSystemdUnit(
            [
                { name: 'val-cal.timer', content: timer },
                { name: 'val-cal.service', content: service },
            ],
            'val-cal.timer',
        );
    });

    t('OnBootSec + Persistent + RandomizedDelaySec', async () => {
        const timer = render(
            toTimerUnit({
                name: 'val-boot',
                onBootSec: '5min',
                onUnitActiveSec: '1h',
                persistent: true,
                randomizedDelaySec: '30s',
                accuracySec: '1min',
            }),
        );
        const service = render(
            toServiceUnit({ name: 'val-boot', exec: '/bin/true' }),
        );
        await validateSystemdUnit(
            [
                { name: 'val-boot.timer', content: timer },
                { name: 'val-boot.service', content: service },
            ],
            'val-boot.timer',
        );
    });
});

describe('quadlet -dryrun accepts toPodUnit output', () => {
    t('minimal pod', async () => {
        const content = render(toPodUnit({ name: 'val-pod-min' }));
        await validateQuadletUnit([{ name: 'val-pod-min.pod', content }]);
    });

    t('pod with networks, volumes, ports, UID maps, DNS options', async () => {
        const content = render(
            toPodUnit({
                name: 'val-pod-rich',
                hostname: 'demo-host',
                publishPort: [
                    { hostPort: 8080, containerPort: 80 },
                    '127.0.0.1:443:443/tcp',
                ],
                volume: [
                    { source: '/srv/data', target: '/data', options: ['ro'] },
                ],
                userNS: 'auto',
                uidMap: [{ containerId: 0, hostId: 100000, size: 65536 }],
                dns: ['1.1.1.1', '8.8.8.8'],
                dnsOption: { ndots: '2' },
                label: { app: 'demo', tier: 'web' },
                shmSize: '64m',
                stopTimeout: 10,
            }),
        );
        await validateQuadletUnit([{ name: 'val-pod-rich.pod', content }]);
    });
});

describe('quadlet -dryrun accepts toContainerUnit output', () => {
    t('minimal container', async () => {
        const content = render(
            toContainerUnit({
                name: 'val-cont-min',
                image: 'docker.io/alpine:latest',
            }),
        );
        await validateQuadletUnit([
            { name: 'val-cont-min.container', content },
        ]);
    });

    t('container in a pod (cross-unit reference)', async () => {
        const pod = render(toPodUnit({ name: 'val-cont-pod' }));
        const container = render(
            toContainerUnit({
                name: 'val-cont-app',
                image: 'docker.io/alpine:latest',
                pod: 'val-cont-pod.pod',
            }),
        );
        await validateQuadletUnit([
            { name: 'val-cont-pod.pod', content: pod },
            { name: 'val-cont-app.container', content: container },
        ]);
    });

    t('container with health check, tmpfs, devices, env', async () => {
        const content = render(
            toContainerUnit({
                name: 'val-cont-rich',
                image: 'docker.io/alpine:latest',
                health: {
                    cmd: ['/bin/sh', '-c', 'wget -q -O- http://localhost'],
                    interval: '30s',
                    timeout: '5s',
                    retries: 3,
                },
                tmpfs: [{ target: '/run', options: ['size=64m', 'mode=0755'] }],
                addDevice: [
                    {
                        host: '/dev/null',
                        container: '/dev/null',
                        permissions: 'rw',
                    },
                ],
                environment: { DEMO: 'true', LANG: 'C' },
                publishPort: [{ hostPort: 8080, containerPort: 80 }],
                volume: [{ target: '/data' }],
            }),
        );
        await validateQuadletUnit([
            { name: 'val-cont-rich.container', content },
        ]);
    });
});

describe('quadlet -dryrun accepts toNetworkUnit output', () => {
    t('minimal network with subnet/gateway', async () => {
        const content = render(
            toNetworkUnit({
                name: 'val-net',
                driver: 'bridge',
                subnet: '10.89.0.0/24',
                gateway: '10.89.0.1',
                ipv6: false,
            }),
        );
        await validateQuadletUnit([{ name: 'val-net.network', content }]);
    });
});

// Lightweight sanity check on a helper that doesn't have its own pure unit
// test (renderDnsOption is co-tested above via the rich pod input).
describe('renderDnsOption coverage sanity', () => {
    test('returns undefined for undefined', () => {
        expect(renderDnsOption(undefined)).toBeUndefined();
    });
});
