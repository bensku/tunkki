import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    spyOn,
    test,
} from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { $ } from 'bun';
import { connect, type Host, on, podman } from '../..';
import { log } from '../../common/log';
import * as builder from '../../local/builder';
import { taskType } from '../../task';
import { fakeHost, readState } from './fake-host';
import type { TestState } from './fixtures/log';

/**
 * Runs secretv2 against real Podman. The remote runs in this process, so
 * Podman gets a storage.conf that keeps secrets in a temporary directory
 * instead of the user's own store.
 */
const hasPodman = (await $`podman --version`.nothrow().quiet()).exitCode === 0;

const basic = taskType<TestState, unknown, { value: unknown }>(
    'test.basic',
    import.meta.resolve('./fixtures/basic'),
);

const ENV = 'TUNKKI_SECRETV2_TEST';
const DRIVER = 'secretv2Test';
const driverValues: Record<string, string> = {};

declare global {
    var applyTest: { calls: string[] };
}

let podmanDir: string;
let storageConf: string;
let oldStorageConf: string | undefined;
let dir: string;
let host: Host;

beforeAll(async () => {
    podmanDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-podman-'));
    storageConf = path.join(podmanDir, 'storage.conf');
    await Bun.write(
        storageConf,
        [
            '[storage]',
            'driver = "vfs"',
            `graphroot = "${podmanDir}/graph"`,
            `runroot = "${podmanDir}/run"`,
        ].join('\n'),
    );
    oldStorageConf = process.env.CONTAINERS_STORAGE_CONF;
    process.env.CONTAINERS_STORAGE_CONF = storageConf;

    podman.registerSecretDriver(DRIVER, (source) => {
        const value = driverValues[source];
        if (value === undefined) {
            throw new Error(`no test secret ${source}`);
        }
        return value;
    });
});

afterAll(async () => {
    if (oldStorageConf === undefined) {
        delete process.env.CONTAINERS_STORAGE_CONF;
    } else {
        process.env.CONTAINERS_STORAGE_CONF = oldStorageConf;
    }
    // vfs leaves read-only files behind; podman can remove them
    await $`podman unshare rm -rf ${podmanDir}`.nothrow().quiet();
    await fs.rm(podmanDir, { recursive: true, force: true });
});

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-secretv2-'));
    host = fakeHost('h1', dir);
    globalThis.applyTest = { calls: [] };
});

afterEach(async () => {
    builder.clearAll();
    delete process.env[ENV];
    await removeAllSecrets();
    await fs.rm(dir, { recursive: true });
});

async function deploy(define: () => void) {
    builder.clearAll();
    define();
    const pool = await connect([host]);
    try {
        const plan = await pool.plan('prod');
        globalThis.applyTest.calls = [];
        const [result] = await pool.execute(plan);
        return { plan, result, calls: globalThis.applyTest.calls };
    } finally {
        await pool.close();
    }
}

/**
 * Removes all secrets from the test store. Refuses to run against any other
 * store, so that a broken setup can't wipe the user's secrets.
 */
async function removeAllSecrets() {
    if (!storageConf || process.env.CONTAINERS_STORAGE_CONF !== storageConf) {
        throw new Error('refusing to remove secrets outside test store');
    }
    await $`podman secret rm --all`.quiet();
}

async function secretNames(): Promise<string[]> {
    const out = await $`podman secret ls --format {{.Name}}`.text();
    return out.split('\n').filter((name) => name !== '');
}

async function secretValue(name: string): Promise<string> {
    return $`podman secret inspect --showsecret --format {{.SecretData}} ${name}`
        .text()
        .then((text) => text.trimEnd());
}

/**
 * Podman name of secret in stored output.
 */
async function storedName(id = 'h1.s'): Promise<string> {
    const output = (await readState(dir, 'h1', 'prod'))[id]?.output as
        | podman.SecretV2Output
        | undefined;
    if (!output) {
        throw new Error(`${id} has no output`);
    }
    return output.ref.podmanId;
}

/**
 * Deploys a secret from env, and a task that uses its name.
 */
const fromEnv = (value: string) => () => {
    process.env[ENV] = value;
    on('h1', () => {
        const s = podman.secretv2('s', { driver: 'localEnv', source: ENV });
        basic('user', { name: 'user', value: s.ref.podmanId });
    });
};

describe.skipIf(!hasPodman)('podman.secretv2', () => {
    test('creates a secret from env', async () => {
        const { result } = await deploy(fromEnv('hunter2'));
        expect(result?.errored).toEqual([]);

        const name = await storedName();
        expect(name).toMatch(/^tunkkiv2-[0-9a-f-]{36}$/);
        expect(await secretNames()).toEqual([name]);
        expect(await secretValue(name)).toBe('hunter2');

        const state = await readState(dir, 'h1', 'prod');
        expect(state['h1.s']?.output).toEqual({
            ref: { driver: 'localEnv', podmanId: name },
        });
        expect(state['h1.user']?.state).toEqual({ name: 'user', value: name });
    });

    test('never stores the value', async () => {
        const { plan } = await deploy(fromEnv('hunter2'));
        const stored = await Bun.file(
            path.join(dir, 'h1', 'prod', 'current.json'),
        ).text();
        expect(stored).not.toContain('hunter2');
        expect(JSON.stringify(plan)).not.toContain('hunter2');
    });

    test('keeps its name while the value stays the same', async () => {
        await deploy(fromEnv('hunter2'));
        const name = await storedName();

        const again = await deploy(fromEnv('hunter2'));
        expect(again.plan.unchanged.sort()).toEqual(['h1.s', 'h1.user']);
        expect(again.calls).toEqual([]);
        expect(await storedName()).toBe(name);
        expect(await secretNames()).toEqual([name]);
    });

    test('changed value gets a new name, and old secret is removed', async () => {
        await deploy(fromEnv('hunter2'));
        const oldName = await storedName();

        const changed = await deploy(fromEnv('correct horse'));
        expect(changed.result?.errored).toEqual([]);
        expect(changed.plan.updated).toEqual(['h1.s']);

        const newName = await storedName();
        expect(newName).not.toBe(oldName);
        expect(await secretNames()).toEqual([newName]);
        expect(await secretValue(newName)).toBe('correct horse');

        // Users of the secret are applied again with the new name
        expect(changed.calls).toEqual(['basic:apply:user']);
        expect((await readState(dir, 'h1', 'prod'))['h1.user']?.state).toEqual({
            name: 'user',
            value: newName,
        });
    });

    test('changing the value back still works', async () => {
        await deploy(fromEnv('a'));
        await deploy(fromEnv('b'));
        await deploy(fromEnv('a'));
        const name = await storedName();
        expect(await secretNames()).toEqual([name]);
        expect(await secretValue(name)).toBe('a');
    });

    test('removing the task removes the secret', async () => {
        await deploy(fromEnv('hunter2'));
        expect(await secretNames()).toHaveLength(1);

        const { result } = await deploy(() => {});
        expect(result?.completed.sort()).toEqual(['h1.s', 'h1.user']);
        expect(await secretNames()).toEqual([]);
        expect(await readState(dir, 'h1', 'prod')).toEqual({});
    });

    test('secret removed outside tunkki is not an error', async () => {
        await deploy(fromEnv('a'));
        await removeAllSecrets();
        const { result } = await deploy(fromEnv('b'));
        expect(result?.errored).toEqual([]);
        expect(await secretNames()).toEqual([await storedName()]);
    });

    test('new secret is used even if old one cannot be removed', async () => {
        await deploy(fromEnv('a'));
        const oldName = await storedName();

        // podman that fails to remove secrets while the marker exists
        const bin = path.join(podmanDir, 'bin');
        const marker = path.join(podmanDir, 'fail-rm');
        const real = (await $`which podman`.text()).trim();
        await Bun.write(
            path.join(bin, 'podman'),
            [
                '#!/bin/sh',
                `if [ "$1 $2" = "secret rm" ] && [ -e ${marker} ]; then`,
                '    echo "simulated failure" >&2',
                '    exit 125',
                'fi',
                `exec ${real} "$@"`,
            ].join('\n'),
        );
        await fs.chmod(path.join(bin, 'podman'), 0o755);
        await Bun.write(marker, '');
        const oldPath = process.env.PATH;
        process.env.PATH = `${bin}:${oldPath}`;
        // Handler shares log with the agent, so this sees what it logs
        const logged = spyOn(log, 'error').mockImplementation(() => {});
        try {
            const { result } = await deploy(fromEnv('b'));
            expect(result?.errored).toEqual([]);
            expect(logged).toHaveBeenCalledWith(
                'failed to remove old secret',
                oldName,
                'error',
                'simulated failure',
            );
        } finally {
            logged.mockRestore();
            process.env.PATH = oldPath;
            await fs.rm(marker);
        }

        const newName = await storedName();
        expect(newName).not.toBe(oldName);
        expect(await secretValue(newName)).toBe('b');
        expect((await readState(dir, 'h1', 'prod'))['h1.user']?.state).toEqual({
            name: 'user',
            value: newName,
        });
        // Old one is left behind
        expect((await secretNames()).sort()).toEqual([oldName, newName].sort());
    });

    test('secrets are independent of each other', async () => {
        const define = (a: string, b: string) => () => {
            driverValues.a = a;
            driverValues.b = b;
            on('h1', () => {
                podman.secretv2('a', { driver: DRIVER, source: 'a' });
                podman.secretv2('b', { driver: DRIVER, source: 'b' });
            });
        };
        await deploy(define('1', '2'));
        const b = await storedName('h1.b');

        await deploy(define('3', '2'));
        const a = await storedName('h1.a');
        expect(await storedName('h1.b')).toBe(b);
        expect((await secretNames()).sort()).toEqual([a, b].sort());
        expect(await secretValue(a)).toBe('3');
        expect(await secretValue(b)).toBe('2');
    });

    test('registered drivers can be used', async () => {
        driverValues.custom = 'from driver';
        const { result } = await deploy(() =>
            on('h1', () => {
                podman.secretv2('s', { driver: DRIVER, source: 'custom' });
            }),
        );
        expect(result?.errored).toEqual([]);
        const name = await storedName();
        expect(await secretValue(name)).toBe('from driver');
        expect(
            (await readState(dir, 'h1', 'prod'))['h1.s']?.output,
        ).toMatchObject({ ref: { driver: DRIVER } });
    });
});

describe('podman.secretv2 definition', () => {
    /**
     * Defines tasks and loads them.
     * @returns Loaded tasks.
     */
    async function load(define: () => void) {
        builder.clearAll();
        on('h1', define);
        await builder.loadTasks([host]);
        return builder.tasks;
    }

    test('fails with unknown driver', async () => {
        await expect(
            load(() => {
                podman.secretv2('s', { driver: 'nope', source: 'x' });
            }),
        ).rejects.toThrow('invalid secret driver nope for secret s');
    });

    test('fails with missing env variable', async () => {
        await expect(
            load(() => {
                podman.secretv2('s', {
                    driver: 'localEnv',
                    source: 'TUNKKI_SECRETV2_MISSING',
                });
            }),
        ).rejects.toThrow('missing env variable: TUNKKI_SECRETV2_MISSING');
    });

    test('drivers cannot be registered twice', () => {
        expect(() => podman.registerSecretDriver(DRIVER, () => '')).toThrow(
            `secret driver ${DRIVER} already registered`,
        );
        expect(() => podman.registerSecretDriver('localEnv', () => '')).toThrow(
            'secret driver localEnv already registered',
        );
    });

    test('stores a hash of the value, not the value', async () => {
        process.env[ENV] = 'hunter2';
        const tasks = await load(() => {
            podman.secretv2('s', { driver: 'localEnv', source: ENV });
        });
        expect(tasks.find((t) => t.id === 'h1.s')?.state).toEqual({
            driver: 'localEnv',
            source: ENV,
            hash: Bun.CryptoHasher.hash('sha256', 'hunter2').toBase64(),
        });
    });
});
