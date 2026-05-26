import * as path from 'node:path';
import type { CA } from '../../../task/util/nebula';
import { CliExitError, type Command, type ParsedCli } from '../parse';
import { caStem, certInfo, sameCA } from '../util/ca';
import { readNetwork, writeNetwork } from '../util/network-file';

export async function runDistrustCa(
    cmd: Extract<Command, { kind: 'distrust-ca' }>,
    flags: ParsedCli['flags'],
): Promise<number> {
    const network = await readNetwork(cmd.file);
    const networkDir = path.dirname(path.resolve(cmd.file));

    const toRemove = cmd.expired
        ? await pickExpired(network.trustedCAs, networkDir, network.signingCA)
        : pickBySelector(network.trustedCAs, cmd);

    if (toRemove.length === 0) {
        if (cmd.expired) {
            process.stdout.write(
                flags.json
                    ? `${JSON.stringify({ removed: [] })}\n`
                    : 'no expired CAs in trustedCAs\n',
            );
            return 0;
        }
        throw new CliExitError(
            1,
            `no trusted CA matches selector: ${cmd.selector}`,
        );
    }
    if (toRemove.length > 1 && !cmd.all) {
        const stems = toRemove.map(caStem).join(', ');
        throw new CliExitError(
            1,
            `selector matches ${toRemove.length} CAs (${stems}); pass --all to remove all of them`,
        );
    }
    for (const ca of toRemove) {
        if (sameCA(ca, network.signingCA)) {
            throw new CliExitError(
                1,
                `cannot distrust the current signingCA (${caStem(ca)}); run \`new-ca\` first`,
            );
        }
    }

    network.trustedCAs = network.trustedCAs.filter(
        (ca) => !toRemove.some((rm) => sameCA(rm, ca)),
    );

    await writeNetwork(cmd.file, network);

    if (flags.json) {
        process.stdout.write(
            `${JSON.stringify({ file: cmd.file, removed: toRemove })}\n`,
        );
    } else {
        for (const ca of toRemove) {
            process.stdout.write(
                `distrusted ${caStem(ca)} (${ca.cert}); files left on disk\n`,
            );
        }
    }
    return 0;
}

function pickBySelector(
    trusted: CA[],
    cmd: Extract<Command, { kind: 'distrust-ca' }>,
): CA[] {
    const selector = cmd.selector;
    if (selector === undefined) return [];
    return trusted.filter((ca) => {
        if (cmd.selectorKind === 'name') return caStem(ca) === selector;
        if (cmd.selectorKind === 'cert') return ca.cert === selector;
        return caStem(ca) === selector || ca.cert === selector;
    });
}

async function pickExpired(
    trusted: CA[],
    networkDir: string,
    signing: CA,
): Promise<CA[]> {
    const now = Date.now();
    const out: CA[] = [];
    for (const ca of trusted) {
        if (sameCA(ca, signing)) continue;
        const info = await certInfo(networkDir, ca.cert);
        if (info.notAfter.getTime() <= now) out.push(ca);
    }
    return out;
}
