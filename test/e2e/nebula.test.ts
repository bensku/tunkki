/**
 * Nebula endpoints have a remote, a local and a remote step: the remote makes
 * a key, local signs it and the remote installs the certificate.
 *
 * WARNING: nebula.setup installs /usr/bin/nebula and /usr/bin/nebula-cert on
 * test1, and destroying the stack removes them again.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import * as path from 'node:path';
import { nebula, on } from '../..';
import network from '../network.json' with { type: 'json' };
import {
    applyOnce,
    destroyStack,
    errorsOf,
    NEBULA_BIN_DIR,
    nebulaReady,
    uniqueStack,
    vmExec,
    vmFileExists,
    vmHost,
} from './helpers';

setDefaultTimeout(180_000);
const t = test.skipIf(!(await nebulaReady()));
const hosts = [vmHost('test1')];
const ENDPOINT = 'e2e-endpoint';

const ca = (ca: nebula.CA) => ({
    cert: path.join(import.meta.dir, '..', ca.cert),
    key: path.join(import.meta.dir, '..', ca.key),
});

let stack: string;
afterEach(async () => {
    await destroyStack(stack, hosts);
    await vmExec(
        'test1',
        `rm -rf /etc/nebula/endpoints/${ENDPOINT} /etc/containers/nebula/${ENDPOINT}.yml /etc/containers/nebula/network/e2e.yml`,
    );
});

t('endpoints get a certificate signed locally', async () => {
    stack = uniqueStack('e2e-nebula');
    const outcome = await applyOnce(stack, hosts, () =>
        on('test1', () => {
            const setup = nebula.setup('setup', { localPath: NEBULA_BIN_DIR });
            const net = nebula.network(
                'network',
                {
                    ...network,
                    id: 'e2e',
                    signingCA: ca(network.signingCA),
                    trustedCAs: network.trustedCAs.map(ca),
                    routes: {},
                    virtualIps: {},
                },
                { dependencies: [setup.id] },
            );
            nebula.endpoint(
                'endpoint',
                {
                    network: 'e2e',
                    id: ENDPOINT,
                    hostname: 'e2e.nebula.test',
                    groups: ['e2e'],
                    firewall: [],
                },
                { dependencies: [net.id] },
            );
        }),
    );
    expect(errorsOf(outcome)).toEqual([]);

    const cert = await vmExec(
        'test1',
        `/usr/bin/nebula-cert print -json -path /etc/nebula/endpoints/${ENDPOINT}/host.crt`,
    );
    expect(cert.exitCode).toBe(0);
    expect(JSON.parse(cert.stdout)[0].details.name).toBe('e2e.nebula.test');
    expect(
        await vmFileExists('test1', `/etc/containers/nebula/${ENDPOINT}.yml`),
    ).toBe(true);
});
