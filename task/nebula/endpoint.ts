import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { step } from '@bensku/tunkki/task';
import { nebula } from '@bensku/tunkki/task/util';
import { $ } from 'bun';

interface SignCertReq {
    endpoint: nebula.Endpoint;
    signingCA: nebula.CA;
    id: string;
    pubKey: string;
    networks: string[];
    unsafeNetworks: string[];
}

interface InstallReq {
    id: string;
    endpoint: nebula.Endpoint;
    certificate: string;
}

/**
 * Maximum time, in milliseconds, we'll wait for remote clock to catch up with
 * local before installing a certificate.
 */
const MAX_CLOCK_SKEW = 60_000;

export const apply = [
    step<nebula.Endpoint, SignCertReq>('remote', async (state) => {
        // Load network configuration
        const nebulanet = await Bun.file(
            `/etc/containers/nebula/network/${state.network}.yml`,
        ).json();
        const network: nebula.Network = nebulanet._net;

        // Assign random IP if we don't already have one
        const endpointDir = `/etc/nebula/endpoints/${state.id}`;
        await fs.mkdir(endpointDir, { recursive: true });
        let ip = state.ip;
        if (!ip) {
            const ipFile = Bun.file(`${endpointDir}/ip.txt`);
            if (await ipFile.exists()) {
                ip = await ipFile.text();
            } else {
                ip = nebula.getRandomIp(network.dynamicPrefix);
                await ipFile.write(ip);
            }
        }
        const prefixLen = nebula.getPrefixLen(network.prefix);

        // Make key pair, to be signed as certificate by local
        // Reuse existing one, so that old certificate keeps matching the key
        // until we've installed the new one
        const keyPath = `${endpointDir}/host.key`;
        const pubkeyPath = `${endpointDir}/host.pub`;
        if (
            !(await Bun.file(keyPath).exists()) ||
            !(await Bun.file(pubkeyPath).exists())
        ) {
            await $`/usr/bin/nebula-cert keygen -out-key ${keyPath} -out-pub ${pubkeyPath}`;
        }
        const pubKey = await Bun.file(pubkeyPath).text();
        return {
            id: state.id,
            pubKey,
            networks: [`${ip}/${prefixLen}`],
            // Filter unsafe routes that this endpoint serves as gateway for
            // Dedupe, there might be multiple instances of same route but with different via
            unsafeNetworks: [
                ...new Set(
                    Object.entries(nebulanet.named_routes)
                        .map(([_, route]) => route as nebula.NamedRoute)
                        .filter(
                            (route) =>
                                route.via.find(
                                    (target) => target.gateway === ip,
                                ) !== undefined,
                        )
                        .map((route) => route.route),
                ),
            ],
            endpoint: {
                ...state,
                ip,
            },
            signingCA: network.signingCA,
        };
    }),
    step<SignCertReq, InstallReq>('local', async (state) => {
        // Write pubkey to temp dir
        const tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'tunkki-nebula'),
        );
        const pubPath = path.join(tmpDir, 'host.pub');
        await Bun.file(pubPath).write(state.pubKey);

        // Mint a certificate from it
        const ca = state.signingCA;
        const crtPath = path.join(tmpDir, 'host.crt');
        if (state.unsafeNetworks) {
            await $`nebula-cert sign -in-pub ${pubPath} -ca-crt ${ca.cert} -ca-key ${ca.key} -duration 676000h -name ${state.endpoint.hostname} -groups ${state.endpoint.groups.join(',')} -networks ${state.networks.join(',')} -unsafe-networks ${state.unsafeNetworks.join(',')} -out-crt ${crtPath}`;
        } else {
            await $`nebula-cert sign -in-pub ${pubPath} -ca-crt ${ca.cert} -ca-key ${ca.key} -duration 676000h -name ${state.endpoint.hostname} -groups ${state.endpoint.groups.join(',')} -networks ${state.networks.join(',')} -out-crt ${crtPath}`;
        }
        const certificate = await Bun.file(crtPath).text();

        // Clean up
        await Bun.file(crtPath).delete();
        await Bun.file(pubPath).delete();
        await fs.rmdir(tmpDir);

        return {
            id: state.id,
            endpoint: state.endpoint,
            certificate,
        };
    }),
    step<InstallReq>('remote', async (state) => {
        // Save certificate BEFORE updating config file
        // Write and rename, so that a reload never sees half-written certificate
        const crtPath = `/etc/nebula/endpoints/${state.id}/host.crt`;
        await Bun.file(`${crtPath}.new`).write(state.certificate);

        // Certificate's validity starts at local clock, which may be ahead of ours
        // Nebula refuses to load not-yet-valid certificates, so wait as needed
        const [cert] =
            await $`/usr/bin/nebula-cert print -json -path ${crtPath}.new`.json();
        const wait = Date.parse(cert.details.notBefore) - Date.now();
        if (wait > MAX_CLOCK_SKEW) {
            throw new Error(
                `certificate is valid only after ${wait} ms, check clock sync between local and remote`,
            );
        } else if (wait > 0) {
            await Bun.sleep(wait);
        }
        await fs.rename(`${crtPath}.new`, crtPath);

        // Load network configuration again, better this than to pass it a few times over wire
        const nebulanet = await Bun.file(
            `/etc/containers/nebula/network/${state.endpoint.network}.yml`,
        ).json();
        const network: nebula.Network = nebulanet._net;

        // Generate and drop config to disk
        await Bun.file(`/etc/containers/nebula/${state.id}.yml`).write(
            JSON.stringify(
                await nebula.endpointToConfig(network, state.endpoint),
            ),
        );
    }),
];
