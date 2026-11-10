import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { on, podman } from '../..';
import type { HealthCheck } from '../../task/podman/containerv2';
import {
    applyOnce,
    destroyStack,
    errorsOf,
    uniqueStack,
    vmExec,
    vmFileExists,
    vmHost,
    vmsReady,
} from './helpers';

// Pulling the image may take a while
setDefaultTimeout(300_000);
const t = test.skipIf(!(await vmsReady()));
const hosts = [vmHost('test1')];

const IMAGE = 'docker.io/library/busybox:1.37';
const PORT = 18_081;
const SECRET_ENV = 'TUNKKI_E2E_CONTAINERV2_SECRET';

let stack: string;
let name: string;
let localDir: string | undefined;
afterEach(async () => {
    await destroyStack(stack, hosts);
    if (localDir) {
        await fs.rm(localDir, { recursive: true, force: true });
        localDir = undefined;
    }
    delete process.env[SECRET_ENV];
});

const newStack = (prefix: string) => {
    stack = uniqueStack(prefix);
    // Containers are per host, not per stack
    name = stack;
};

/**
 * Runs a shell command on test1, failing the test if it fails.
 */
async function sh(cmd: string): Promise<string> {
    const r = await vmExec('test1', cmd);
    if (r.exitCode !== 0) {
        throw new Error(`${cmd} failed: ${r.stderr.trim()}`);
    }
    return r.stdout;
}

const health = (name: string) =>
    sh(`podman inspect -f '{{.State.Health.Status}}' ${name}`).then((s) =>
        s.trim(),
    );

/**
 * Busybox httpd that serves /www on port 8080.
 */
function httpd(healthCheck: HealthCheck, page = 'hello') {
    return () =>
        on('*', () => {
            podman.containerv2('web', {
                name,
                image: IMAGE,
                cmd: ['httpd', '-f', '-p', '8080', '-h', '/www'],
                user: 1000,
                volumes: {
                    '/www/index.html': {
                        type: 'writeFile',
                        data: page,
                        readonly: true,
                        selinuxRelabel: true,
                    },
                },
                ports: [
                    { host: '127.0.0.1', hostPort: PORT, containerPort: 8080 },
                ],
                healthCheck,
            });
        });
}

t('runs a container, waits until healthy, updates and removes', async () => {
    newStack('e2e-ctr');
    localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-e2e-ctr-'));
    const template = path.join(localDir, 'greeting.txt');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: envsubst syntax
    await Bun.write(template, 'hello ${NAME}, costs 5$');
    process.env[SECRET_ENV] = 'hunter2';

    const define = (page: string) => () =>
        on('*', () => {
            const secret = podman.secretv2('pass', {
                driver: 'localEnv',
                source: SECRET_ENV,
            });
            podman.containerv2('web', {
                name,
                image: IMAGE,
                cmd: ['httpd', '-f', '-p', '8080', '-h', '/www'],
                user: 1000,
                env: { GREETING: 'hi there, $USER 100%' },
                secrets: { PASS: secret.ref },
                volumes: {
                    '/www/index.html': {
                        type: 'writeFile',
                        data: page,
                        readonly: true,
                        selinuxRelabel: true,
                    },
                    '/www/greeting.txt': {
                        type: 'uploadFile',
                        localPath: template,
                        template: { NAME: 'tunkki' },
                        selinuxRelabel: true,
                    },
                    '/run/pass': { type: 'secret', ref: secret.ref },
                    '/data': {
                        type: 'hostPath',
                        path: `/var/tmp/tunkki-e2e/${name}`,
                        createDir: true,
                        selinuxRelabel: true,
                    },
                },
                ports: [
                    { host: '127.0.0.1', hostPort: PORT, containerPort: 8080 },
                ],
                healthCheck: { type: 'http', port: 8080, path: '/index.html' },
            });
        });

    const created = await applyOnce(stack, hosts, define('one'));
    expect(errorsOf(created)).toEqual([]);
    // Deploy waited until it is healthy
    expect(await health(name)).toBe('healthy');
    expect(await sh(`systemctl is-active ${name}.service`)).toBe('active\n');

    // Published port, files and their SELinux labels
    expect(await sh(`curl -sf http://127.0.0.1:${PORT}/`)).toBe('one');
    expect(await sh(`curl -sf http://127.0.0.1:${PORT}/greeting.txt`)).toBe(
        'hello tunkki, costs 5$',
    );
    // Environment survives systemd's expansion as is
    expect(await sh(`podman exec ${name} printenv GREETING`)).toBe(
        'hi there, $USER 100%\n',
    );
    expect(await sh(`podman exec ${name} printenv PASS`)).toBe('hunter2\n');
    expect(await sh(`podman exec ${name} cat /run/pass`)).toBe('hunter2');
    expect(await sh(`podman exec ${name} id -u`)).toBe('1000\n');
    // Host path was created and is accessible
    await sh(`podman exec -u 0 ${name} touch /data/written`);
    expect(
        await vmFileExists('test1', `/var/tmp/tunkki-e2e/${name}/written`),
    ).toBe(true);

    const same = await applyOnce(stack, hosts, define('one'));
    expect(errorsOf(same)).toEqual([]);
    expect(same.plan.unchanged).toContain('test1.web');

    const updated = await applyOnce(stack, hosts, define('two'));
    expect(errorsOf(updated)).toEqual([]);
    expect(updated.plan.updated).toContain('test1.web');
    expect(await sh(`curl -sf http://127.0.0.1:${PORT}/`)).toBe('two');

    const removed = await applyOnce(stack, hosts, () => {});
    expect(errorsOf(removed)).toEqual([]);
    expect(
        await vmFileExists(
            'test1',
            `/etc/containers/systemd/${name}.container`,
        ),
    ).toBe(false);
    expect(
        await vmFileExists('test1', `/var/lib/tunkki/containers/${name}`),
    ).toBe(false);
    expect(
        (await vmExec('test1', `podman container exists ${name}`)).exitCode,
    ).not.toBe(0);
    await sh(`rm -rf /var/tmp/tunkki-e2e/${name}`);
});

t('deploy fails if container does not become healthy', async () => {
    newStack('e2e-unhealthy');
    try {
        const failed = await applyOnce(
            stack,
            hosts,
            httpd({
                type: 'http',
                port: 8080,
                path: '/missing',
                startPeriod: 5,
            }),
        );
        expect(errorsOf(failed)).toEqual([
            expect.stringContaining('test1.web'),
        ]);
    } finally {
        // Failed creates are not recorded in state, so destroying the stack
        // does not remove the container. It is left to keep retrying.
        await vmExec(
            'test1',
            `systemctl stop ${name}.service; rm -f /etc/containers/systemd/${name}.container; systemctl daemon-reload; rm -rf /var/lib/tunkki/containers/${name}`,
        );
    }
});

t('command health checks work too', async () => {
    newStack('e2e-cmdhealth');
    const created = await applyOnce(
        stack,
        hosts,
        httpd({
            type: 'cmd',
            cmd: ['wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/'],
        }),
    );
    expect(errorsOf(created)).toEqual([]);
    expect(await health(name)).toBe('healthy');
});

t('renaming replaces the old container', async () => {
    newStack('e2e-rename');
    const http: HealthCheck = { type: 'http', port: 8080 };
    expect(errorsOf(await applyOnce(stack, hosts, httpd(http)))).toEqual([]);
    const oldName = name;

    name = `${oldName}-new`;
    const renamed = await applyOnce(stack, hosts, httpd(http, 'renamed'));
    expect(errorsOf(renamed)).toEqual([]);
    // Same port, so the old one must be gone before the new one starts
    expect(await sh(`curl -sf http://127.0.0.1:${PORT}/`)).toBe('renamed');
    expect(
        (await vmExec('test1', `podman container exists ${oldName}`)).exitCode,
    ).not.toBe(0);
    expect(
        await vmFileExists(
            'test1',
            `/etc/containers/systemd/${oldName}.container`,
        ),
    ).toBe(false);
});
