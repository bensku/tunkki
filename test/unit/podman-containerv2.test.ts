// biome-ignore-all lint/suspicious/noTemplateCurlyInString: envsubst syntax
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { $ } from 'bun';
import { on, podman } from '../..';
import * as builder from '../../local/builder';
import {
    applyTemplate,
    hostFilePath,
    type Input,
    toUnitFile,
    validate,
} from '../../task/podman/containerv2';
import { serializeUnitFile } from '../../task/util/systemd';
import { fakeHost } from './fake-host';

const SECRET = { driver: 'localEnv', podmanId: 'tunkkiv2-abc' };

function render(input: Partial<Input>): string {
    return serializeUnitFile(
        toUnitFile({ name: 'web', image: 'docker.io/nginx:1', ...input }),
    );
}

function lines(input: Partial<Input>, key: string): string[] {
    return render(input)
        .split('\n')
        .filter((line) => line.startsWith(`${key}=`))
        .map((line) => line.slice(key.length + 1));
}

describe('applyTemplate', () => {
    test('replaces both forms', () => {
        expect(applyTemplate('a=$A b=${B}', { A: '1', B: '2' })).toBe(
            'a=1 b=2',
        );
    });

    test('leaves unknown variables and longer names alone', () => {
        expect(applyTemplate('$A $AB ${C} $', { A: '1' })).toBe('1 $AB ${C} $');
    });

    test('does not interpret replacement patterns', () => {
        expect(applyTemplate('$A', { A: "$& $' $$" })).toBe("$& $' $$");
    });

    test('does nothing without variables', () => {
        expect(applyTemplate('$A ${B}', {})).toBe('$A ${B}');
    });
});

describe('validate', () => {
    const base: Input = { name: 'web', image: 'nginx' };

    test.each([
        [{ name: 'bad name' }, 'invalid container name'],
        [{ name: '-web' }, 'invalid container name'],
        [{ group: 100 }, 'group requires user'],
        [{ env: { PASS: 'x' }, secrets: { PASS: SECRET } }, 'PASS is set both'],
        [{ env: { 'A=B': 'x' } }, 'invalid environment variable name'],
        [{ volumes: { data: { type: 'writeFile', data: '' } } }, 'absolute'],
        [{ volumes: { '/a:b': { type: 'writeFile', data: '' } } }, "':'"],
        [
            { volumes: { '/data': { type: 'hostPath', path: 'relative' } } },
            'absolute',
        ],
        [{ ports: [{ hostPort: 0, containerPort: 80 }] }, 'port number'],
        [{ ports: [{ hostPort: 80, containerPort: 1.5 }] }, 'port number'],
        [{ healthCheck: { type: 'http', port: 70000 } }, 'port number'],
        [
            { healthCheck: { type: 'http', port: 80, path: 'health' } },
            "start with '/'",
        ],
    ] as [Partial<Input>, string][])('rejects %o', (input, error) => {
        expect(() => validate({ ...base, ...input })).toThrow(error);
    });

    test('skips values from outputs of other tasks', () => {
        expect(() =>
            validate({
                ...base,
                name: '$tunkki{h1.a/name}',
                volumes: {
                    '/data': { type: 'hostPath', path: '$tunkki{h1.a/path}' },
                },
            }),
        ).not.toThrow();
    });
});

describe('toUnitFile', () => {
    test('minimal container', () => {
        expect(render({})).toBe(
            [
                '[Container]',
                'ContainerName=web',
                'Image=docker.io/nginx:1',
                '',
                '[Install]',
                'WantedBy=multi-user.target',
                '',
                '[Service]',
                'Restart=always',
                'RestartMaxDelaySec=2min',
                'RestartSec=1',
                'RestartSteps=7',
                '',
                '[Unit]',
                'StartLimitIntervalSec=0',
                '',
            ].join('\n'),
        );
    });

    test('environment is quoted and escaped', () => {
        expect(
            lines(
                {
                    env: {
                        A: 'a b',
                        B: 'x$y',
                        C: '"\\',
                        D: '50%',
                        E: 'l1\nl2',
                    },
                },
                'Environment',
            ),
        ).toEqual([
            '"A=a b"',
            '"B=x$$y"',
            '"C=\\"\\\\"',
            '"D=50%%"',
            '"E=l1\\nl2"',
        ]);
    });

    test('cmd and entrypoint', () => {
        const input = {
            cmd: ['sh', '-c', 'echo $HOME'],
            entrypoint: ['/bin/sh', '-c'],
        };
        expect(lines(input, 'Exec')).toEqual(['sh -c "echo $$HOME"']);
        expect(lines(input, 'Entrypoint')).toEqual(['["/bin/sh","-c"]']);
    });

    test('secrets as environment and as files', () => {
        expect(
            lines(
                {
                    secrets: { PASS: SECRET },
                    volumes: { '/run/key': { type: 'secret', ref: SECRET } },
                },
                'Secret',
            ),
        ).toEqual([
            'tunkkiv2-abc,type=env,target=PASS',
            'tunkkiv2-abc,type=mount,target=/run/key',
        ]);
    });

    test('volumes', () => {
        const file = hostFilePath('web', '/etc/app.conf');
        expect(file).toMatch(
            /^\/var\/lib\/tunkki\/containers\/web\/files\/[0-9a-f]{16}-app\.conf$/,
        );
        expect(
            lines(
                {
                    volumes: {
                        '/data': {
                            type: 'hostPath',
                            path: '/srv/data',
                            selinuxRelabel: true,
                        },
                        '/ro': {
                            type: 'hostPath',
                            path: '/srv/ro',
                            readonly: true,
                            selinuxRelabel: false,
                        },
                        '/etc/app.conf': {
                            type: 'writeFile',
                            data: '',
                            readonly: true,
                            selinuxRelabel: true,
                        },
                    },
                },
                'Volume',
            ),
        ).toEqual([
            '/srv/data:/data:z',
            '/srv/ro:/ro:ro',
            `${file}:/etc/app.conf:ro,Z`,
        ]);
    });

    test('host files of different targets do not collide', () => {
        expect(hostFilePath('web', '/a/b_c')).not.toBe(
            hostFilePath('web', '/a_b/c'),
        );
        expect(hostFilePath('web', '/a/%')).not.toContain('%');
    });

    test('ports', () => {
        expect(
            lines(
                {
                    ports: [
                        { hostPort: 8080, containerPort: 80 },
                        { host: '127.0.0.1', hostPort: 53, containerPort: 53 },
                        {
                            host: '::1',
                            hostPort: 53,
                            containerPort: 53,
                            protocol: 'udp',
                        },
                    ],
                },
                'PublishPort',
            ),
        ).toEqual(['8080:80', '127.0.0.1:53:53', '[::1]:53:53/udp']);
    });

    test('runtime goes to podman args', () => {
        expect(
            lines(
                { runtime: 'krun', podmanArgs: ['--label=a b'] },
                'PodmanArgs',
            ),
        ).toEqual(['--runtime=krun "--label=a b"']);
    });

    test('nebula network orders after nebula-netavarkd', () => {
        expect(lines({ networks: ['nebula'] }, 'After')).toEqual([
            'nebula-netavarkd.service',
        ]);
        expect(lines({ networks: ['nebula'] }, 'Wants')).toEqual([
            'nebula-netavarkd.service',
        ]);
        expect(lines({ networks: ['other'] }, 'After')).toEqual([]);
    });

    test('HTTP health check mounts the probe', () => {
        const input: Partial<Input> = {
            healthCheck: { type: 'http', port: 8080, path: '/healthz' },
        };
        const probe = '["/run/tunkki-healthprobe","8080","/healthz"]';
        expect(lines(input, 'HealthCmd')).toEqual([probe]);
        expect(lines(input, 'HealthStartupCmd')).toEqual([probe]);
        expect(lines(input, 'Volume')).toEqual([
            '/opt/tunkki/healthprobe:/run/tunkki-healthprobe:ro,z',
        ]);
        expect(lines(input, 'Notify')).toEqual(['healthy']);
        expect(lines(input, 'HealthOnFailure')).toEqual(['kill']);
        expect(lines(input, 'HealthInterval')).toEqual(['30s']);
        expect(lines(input, 'HealthStartupInterval')).toEqual(['1s']);
        expect(lines(input, 'TimeoutStartSec')).toEqual(['120']);
    });

    test('command health check with custom timings', () => {
        const input: Partial<Input> = {
            healthCheck: {
                type: 'cmd',
                cmd: ['curl', '-f', 'http://localhost/$x'],
                interval: 10,
                startPeriod: 300,
                retries: 5,
                timeout: undefined,
            },
        };
        expect(lines(input, 'HealthCmd')).toEqual([
            '["curl","-f","http://localhost/$$x"]',
        ]);
        expect(lines(input, 'Volume')).toEqual([]);
        expect(lines(input, 'HealthInterval')).toEqual(['10s']);
        expect(lines(input, 'HealthRetries')).toEqual(['5']);
        expect(lines(input, 'HealthTimeout')).toEqual(['5s']);
        expect(lines(input, 'TimeoutStartSec')).toEqual(['300']);
    });
});

const QUADLET = '/usr/libexec/podman/quadlet';
const hasQuadlet = await Bun.file(QUADLET).exists();

describe.skipIf(!hasQuadlet)('Quadlet', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-quadlet-'));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true });
    });

    async function execStart(input: Partial<Input>): Promise<string> {
        await Bun.write(path.join(dir, 'web.container'), render(input));
        const out = await $`${QUADLET} -dryrun`
            .env({ ...process.env, QUADLET_UNIT_DIRS: dir })
            .quiet()
            .text();
        const line = out.split('\n').find((l) => l.startsWith('ExecStart='));
        if (!line) {
            throw new Error(`no ExecStart in ${out}`);
        }
        return line;
    }

    test('accepts everything we render', async () => {
        const line = await execStart({
            cmd: ['echo', 'a b'],
            entrypoint: ['/bin/sh', '-c'],
            env: { A: 'a b', B: '$x%' },
            secrets: { PASS: SECRET },
            volumes: {
                '/data': {
                    type: 'hostPath',
                    path: '/srv/data',
                    selinuxRelabel: true,
                },
                '/etc/app.conf': {
                    type: 'writeFile',
                    data: '',
                    selinuxRelabel: true,
                },
                '/run/key': { type: 'secret', ref: SECRET },
            },
            user: 1000,
            group: 1000,
            hostname: 'web1',
            networks: ['nebula'],
            ports: [{ host: '::1', hostPort: 80, containerPort: 80 }],
            runtime: 'krun',
            podmanArgs: ['--cap-add=NET_ADMIN'],
            healthCheck: { type: 'http', port: 80 },
        });
        for (const arg of [
            '--user 1000:1000',
            '--hostname web1',
            '--network nebula',
            '--sdnotify=healthy',
            '--publish [::1]:80:80',
            '-v /srv/data:/data:z',
            '--env "A=a\\x20b"',
            '--env B=$$x%%',
            '--secret tunkkiv2-abc,type=env,target=PASS',
            '--secret tunkkiv2-abc,type=mount,target=/run/key',
            '--health-on-failure kill',
            '--runtime=krun',
        ]) {
            expect(line).toContain(arg);
        }
        expect(line).toEndWith('docker.io/nginx:1 echo "a\\x20b"');
    });

    test('rejects group without user', async () => {
        // validate() catches this before Quadlet would
        await Bun.write(
            path.join(dir, 'web.container'),
            render({ group: 1000 }),
        );
        const result = await $`${QUADLET} -dryrun`
            .env({ ...process.env, QUADLET_UNIT_DIRS: dir })
            .nothrow()
            .quiet();
        expect(result.exitCode).not.toBe(0);
    });
});

describe('podman.containerv2 definition', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-containerv2-'));
    });

    afterEach(async () => {
        builder.clearAll();
        await fs.rm(dir, { recursive: true });
    });

    async function load(define: () => void) {
        builder.clearAll();
        on('h1', define);
        await builder.loadTasks([fakeHost('h1', dir)]);
        return builder.tasks;
    }

    test('hashes uploaded files', async () => {
        const local = path.join(dir, 'app.conf');
        await Bun.write(local, 'hello');
        const tasks = await load(() => {
            podman.containerv2('c', {
                name: 'web',
                image: 'nginx',
                volumes: {
                    '/etc/app.conf': { type: 'uploadFile', localPath: local },
                },
            });
        });
        expect(tasks.find((t) => t.id === 'h1.c')?.state).toEqual({
            name: 'web',
            image: 'nginx',
            volumes: {
                '/etc/app.conf': {
                    type: 'uploadFile',
                    localPath: local,
                    hash: Bun.CryptoHasher.hash('sha256', 'hello').toBase64(),
                },
            },
        });
    });

    test('rejects invalid input', async () => {
        await expect(
            load(() => {
                podman.containerv2('c', { name: 'a b', image: 'nginx' });
            }),
        ).rejects.toThrow('invalid container c: invalid container name a b');
    });

    test('connectNebula joins the network and depends on endpoint', async () => {
        const tasks = await load(() => {
            const c = podman.containerv2('c', {
                name: 'web',
                image: 'nginx',
                networks: ['other'],
            });
            c.connectNebula({
                network: 'net',
                hostname: 'web',
                groups: [],
                firewall: [],
            });
        });
        const task = tasks.find((t) => t.id === 'h1.c');
        expect(task?.state).toMatchObject({ networks: ['other', 'nebula'] });
        const endpoint = tasks.find((t) => t.type === 'nebula.endpoint');
        expect(endpoint?.state).toMatchObject({ id: 'web', hostname: 'web' });
        expect(task?.deps).toContain(endpoint?.id as string);
    });
});

const PROBE = path.join(
    import.meta.dir,
    '../../task/podman/healthprobe/healthprobe',
);
// The probe is built for x86-64 Linux only
const hasProbe =
    process.platform === 'linux' &&
    process.arch === 'x64' &&
    (await Bun.file(PROBE).exists());

describe.skipIf(!hasProbe)('health probe', () => {
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (req) => {
            const url = new URL(req.url);
            if (url.pathname === '/ok') {
                return new Response('ok');
            } else if (url.pathname === '/redirect') {
                return Response.redirect('/ok', 302);
            }
            return new Response('nope', { status: 503 });
        },
    });

    async function probe(...args: string[]) {
        const result = await $`${PROBE} ${args}`.nothrow().quiet();
        return {
            exitCode: result.exitCode,
            output: (
                result.stdout.toString() + result.stderr.toString()
            ).trim(),
        };
    }

    test('2xx and 3xx are healthy', async () => {
        expect(await probe(String(server.port), '/ok')).toEqual({
            exitCode: 0,
            output: 'GET /ok: 200 OK',
        });
        expect((await probe(String(server.port), '/redirect')).exitCode).toBe(
            0,
        );
    });

    test('other statuses are not', async () => {
        expect(await probe(String(server.port), '/bad')).toEqual({
            exitCode: 1,
            output: 'healthprobe: GET /bad: 503 Service Unavailable',
        });
    });

    test('path defaults to /', async () => {
        expect((await probe(String(server.port))).output).toContain('GET /:');
    });

    test('refused connection is not healthy', async () => {
        // Port of a server that has been stopped
        const stopped = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = String(stopped.port);
        stopped.stop(true);
        expect((await probe(port)).exitCode).toBe(1);
    });

    test('rejects bad arguments', async () => {
        expect((await probe()).exitCode).toBe(1);
        expect((await probe('http')).output).toContain('invalid port');
        expect((await probe('80', 'x')).output).toContain('invalid path');
    });
});
