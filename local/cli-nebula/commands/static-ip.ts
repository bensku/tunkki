import { CliExitError, type Command, type ParsedCli } from '../parse';
import {
    allocateStaticIp,
    cidrContainsCidr,
    normalizeIp,
} from '../util/ipalloc';
import { readNetwork } from '../util/network-file';

export async function runStaticIp(
    cmd: Extract<Command, { kind: 'static-ip' }>,
    flags: ParsedCli['flags'],
): Promise<number> {
    const network = await readNetwork(cmd.file);

    if (!cidrContainsCidr(network.dynamicPrefix, network.prefix)) {
        throw new CliExitError(
            1,
            `dynamicIpArea ${network.dynamicPrefix} is not inside prefix ${network.prefix}; cannot allocate`,
        );
    }

    // Avoid handing out IPs that already belong to a lighthouse. We don't
    // touch the network file: this just mints addresses for the user to put
    // wherever they need a fixed IP outside the dynamic area.
    const used = new Set(
        network.lighthouses.map((lh) => normalizeIp(lh.vpnIp)),
    );

    const count = cmd.count ?? 1;
    const ips: string[] = [];
    for (let i = 0; i < count; i++) {
        const ip = allocateStaticIp({
            prefix: network.prefix,
            excluded: network.dynamicPrefix,
            used,
        });
        used.add(normalizeIp(ip));
        ips.push(ip);
    }

    if (flags.json) {
        process.stdout.write(`${JSON.stringify({ ips })}\n`);
    } else {
        for (const ip of ips) {
            process.stdout.write(`${ip}\n`);
        }
    }
    return 0;
}
