import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { step } from '@bensku/tunkki/task';
import { nebula } from '@bensku/tunkki/task/util';
import { $ } from 'bun';

interface LocalData {
    endpoint: nebula.Endpoint;
}

interface ConfigureReq {
    id: string;
    config: string;
    dynamicPrefix: string;
    prefix: string;
    ip?: string;
}

interface SignCertReq {
    id: string;
    pubKey: string;
    networks: string[];
}

interface InstallReq {
    id: string;
    certificate: string;
}

export const apply = [
    step<nebula.Endpoint, ConfigureReq, LocalData>(
        'local',
        async (state, localData) => {
            localData.endpoint = state;
            const config = await nebula.toNebulaConfig(state);
            return {
                id: state.id,
                config: JSON.stringify(config),
                dynamicPrefix: state.network.dynamicPrefix,
                prefix: state.network.prefix,
                ip: state.ip,
            };
        },
    ),
    step<ConfigureReq, SignCertReq>('remote', async (state) => {
        // Drop config to disk
        await Bun.file(`/etc/containers/nebula/${state.id}.yml`).write(
            state.config,
        );

        // Assign random IP if we don't already have one
        const endpointDir = `/etc/nebula/endpoints/${state.id}`;
        await fs.mkdir(endpointDir, { recursive: true });
        let ip = state.ip;
        if (!ip) {
            const ipFile = Bun.file(`${endpointDir}/ip.txt`);
            if (await ipFile.exists()) {
                ip = await ipFile.text();
            } else {
                ip = nebula.getRandomIp(state.dynamicPrefix);
                await ipFile.write(ip);
            }
        }
        const prefixLen = nebula.getPrefixLen(state.prefix);

        // Make key pair, to be signed as certificate by local
        const pubkeyPath = `${endpointDir}/host.pub`;
        await $`/usr/local/bin/nebula-cert keygen -out-key ${endpointDir}/host.key -out-pub ${pubkeyPath}`;
        const pubKey = await Bun.file(pubkeyPath).text();
        return {
            id: state.id,
            pubKey,
            networks: [`${ip}/${prefixLen}`],
        };
    }),
    step<SignCertReq, InstallReq, LocalData>(
        'local',
        async (state, localData) => {
            // Write pubkey to temp dir
            const tmpDir = await fs.mkdtemp(
                path.join(os.tmpdir(), 'tunkki-nebula'),
            );
            const pubPath = path.join(tmpDir, 'host.pub');
            await Bun.file(pubPath).write(state.pubKey);

            // Mint a certificate from it
            const ca = localData.endpoint.network.signingCA;
            const crtPath = path.join(tmpDir, 'host.crt');
            await $`nebula-cert sign -in-pub ${pubPath} -ca-crt ${ca.cert} -ca-key ${ca.key} -duration 676000h -name ${localData.endpoint.hostname} -groups ${localData.endpoint.groups.join(',')} -networks ${state.networks.join(',')} -out-crt ${crtPath}`;
            const certificate = await Bun.file(crtPath).text();

            // Clean up
            await Bun.file(crtPath).delete();
            await Bun.file(pubPath).delete();
            await fs.rmdir(tmpDir);

            return {
                id: state.id,
                certificate,
            };
        },
    ),
    step<InstallReq>('remote', async (state) => {
        await Bun.file(`/etc/nebula/endpoints/${state.id}/host.crt`).write(
            state.certificate,
        );
        await $`systemctl reload nebula-netavarkd`;
    }),
];
