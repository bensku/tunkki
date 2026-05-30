import { CliExitError, type Command, type ParsedCli } from '../parse';
import {
    allocateStaticIp,
    cidrContainsCidr,
    cidrContainsIp,
    normalizeIp,
} from '../util/ipalloc';
import { readNetwork, writeNetwork } from '../util/network-file';

export async function runLighthouseAdd(
    cmd: Extract<Command, { kind: 'lighthouse-add' }>,
    flags: ParsedCli['flags'],
): Promise<number> {
    const network = await readNetwork(cmd.file);

    const usedIps = new Set(
        network.lighthouses.map((lh) => normalizeIp(lh.vpnIp)),
    );

    let vpnIp: string;
    if (cmd.ip !== undefined) {
        if (!cidrContainsIp(cmd.ip, network.prefix)) {
            throw new CliExitError(
                2,
                `--ip ${cmd.ip} is not inside prefix ${network.prefix}`,
            );
        }
        if (cidrContainsIp(cmd.ip, network.dynamicPrefix)) {
            throw new CliExitError(
                2,
                `--ip ${cmd.ip} falls inside dynamicIpArea ${network.dynamicPrefix} (reserved for auto-assigned endpoints)`,
            );
        }
        if (usedIps.has(normalizeIp(cmd.ip))) {
            throw new CliExitError(
                1,
                `--ip ${cmd.ip} is already used by another lighthouse`,
            );
        }
        vpnIp = cmd.ip;
    } else {
        if (!cidrContainsCidr(network.dynamicPrefix, network.prefix)) {
            throw new CliExitError(
                1,
                `dynamicIpArea ${network.dynamicPrefix} is not inside prefix ${network.prefix}; cannot auto-allocate`,
            );
        }
        vpnIp = allocateStaticIp({
            prefix: network.prefix,
            excluded: network.dynamicPrefix,
            used: usedIps,
        });
    }

    network.lighthouses.push({ vpnIp, underlayAddr: cmd.underlayAddr });
    await writeNetwork(cmd.file, network);

    if (flags.json) {
        process.stdout.write(
            `${JSON.stringify({ file: cmd.file, added: { vpnIp, underlayAddr: cmd.underlayAddr } })}\n`,
        );
    } else {
        process.stdout.write(
            `added lighthouse ${cmd.underlayAddr} at ${vpnIp}\n`,
        );
    }
    return 0;
}

export async function runLighthouseRemove(
    cmd: Extract<Command, { kind: 'lighthouse-remove' }>,
    flags: ParsedCli['flags'],
): Promise<number> {
    const network = await readNetwork(cmd.file);

    const normalizedSelector = (() => {
        if (cmd.selectorKind === 'underlay') return cmd.selector;
        try {
            return normalizeIp(cmd.selector);
        } catch {
            return cmd.selector;
        }
    })();

    const matches = network.lighthouses.filter((lh) => {
        if (cmd.selectorKind === 'ip') {
            return normalizeIp(lh.vpnIp) === normalizedSelector;
        }
        if (cmd.selectorKind === 'underlay') {
            return lh.underlayAddr === cmd.selector;
        }
        // Either: match against vpnIp (normalized) or underlayAddr (exact).
        const ipMatch = (() => {
            try {
                return normalizeIp(lh.vpnIp) === normalizedSelector;
            } catch {
                return false;
            }
        })();
        return ipMatch || lh.underlayAddr === cmd.selector;
    });

    if (matches.length === 0) {
        throw new CliExitError(
            1,
            `no lighthouse matches selector: ${cmd.selector}`,
        );
    }
    if (matches.length > 1 && !cmd.all) {
        const summary = matches
            .map((lh) => `${lh.vpnIp} (${lh.underlayAddr})`)
            .join(', ');
        throw new CliExitError(
            1,
            `selector matches ${matches.length} lighthouses (${summary}); pass --all to remove all of them`,
        );
    }

    network.lighthouses = network.lighthouses.filter(
        (lh) => !matches.includes(lh),
    );
    await writeNetwork(cmd.file, network);

    if (flags.json) {
        process.stdout.write(
            `${JSON.stringify({ file: cmd.file, removed: matches })}\n`,
        );
    } else {
        for (const lh of matches) {
            process.stdout.write(
                `removed lighthouse ${lh.underlayAddr} at ${lh.vpnIp}\n`,
            );
        }
    }
    return 0;
}
