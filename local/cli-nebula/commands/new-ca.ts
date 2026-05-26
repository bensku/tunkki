import * as path from 'node:path';
import type { Command, ParsedCli } from '../parse';
import {
    DEFAULT_CA_DURATION,
    defaultCaName,
    generateCA,
    sameCA,
} from '../util/ca';
import { readNetwork, writeNetwork } from '../util/network-file';

export async function runNewCa(
    cmd: Extract<Command, { kind: 'new-ca' }>,
    flags: ParsedCli['flags'],
): Promise<number> {
    const network = await readNetwork(cmd.file);
    const networkDir = path.dirname(path.resolve(cmd.file));

    const caName = cmd.caName ?? (await defaultCaName(networkDir));
    const newCa = await generateCA({
        networkDir,
        name: caName,
        duration: cmd.caDuration ?? DEFAULT_CA_DURATION,
    });

    const oldCa = network.signingCA;
    const trusted = [...network.trustedCAs];
    if (!trusted.some((ca) => sameCA(ca, oldCa))) trusted.push(oldCa);
    if (!trusted.some((ca) => sameCA(ca, newCa))) trusted.push(newCa);

    network.signingCA = newCa;
    network.trustedCAs = trusted;

    await writeNetwork(cmd.file, network);

    if (flags.json) {
        process.stdout.write(
            `${JSON.stringify({ file: cmd.file, signingCA: newCa, previousSigningCA: oldCa })}\n`,
        );
    } else {
        process.stdout.write(
            `rotated signing CA in ${cmd.file}\n  new signingCA: ${newCa.cert}\n  previous CA still trusted: ${oldCa.cert}\n  → re-apply your endpoints to re-sign with the new CA, then run \`distrust-ca\` to drop trust in the old one.\n`,
        );
    }
    return 0;
}
