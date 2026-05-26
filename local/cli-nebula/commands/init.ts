import * as path from 'node:path';
import ipaddr from 'ipaddr.js';
import type { Network } from '../../../task/util/nebula';
import { CliExitError, type Command, type ParsedCli } from '../parse';
import { DEFAULT_CA_DURATION, defaultCaName, generateCA } from '../util/ca';
import { cidrContainsCidr } from '../util/ipalloc';
import { writeNetwork } from '../util/network-file';

export async function runInit(
    cmd: Extract<Command, { kind: 'init' }>,
    flags: ParsedCli['flags'],
): Promise<number> {
    if (await Bun.file(cmd.file).exists()) {
        throw new CliExitError(
            1,
            `${cmd.file} already exists; refusing to overwrite`,
        );
    }

    const prefix = cmd.prefix ?? generateUlaPrefix();
    validateCidr(prefix, 'prefix');

    const dynamicIpArea = cmd.dynamicArea ?? topHalf(prefix);
    validateCidr(dynamicIpArea, 'dynamic-area');
    if (!cidrContainsCidr(dynamicIpArea, prefix)) {
        throw new CliExitError(
            2,
            `--dynamic-area (${dynamicIpArea}) must be inside --prefix (${prefix})`,
        );
    }

    const networkDir = path.dirname(path.resolve(cmd.file));
    const caName = cmd.caName ?? (await defaultCaName(networkDir));
    const ca = await generateCA({
        networkDir,
        name: caName,
        duration: cmd.caDuration ?? DEFAULT_CA_DURATION,
    });

    const network: Network = {
        prefix,
        dynamicIpArea,
        signingCA: ca,
        trustedCAs: [ca],
        lighthouses: [],
    };

    await writeNetwork(cmd.file, network);

    if (flags.json) {
        process.stdout.write(
            `${JSON.stringify({ file: cmd.file, prefix, dynamicIpArea, ca })}\n`,
        );
    } else {
        process.stdout.write(
            `created ${cmd.file}\n  prefix:        ${prefix}\n  dynamicIpArea: ${dynamicIpArea}\n  signingCA:     ${ca.cert}\n`,
        );
    }
    return 0;
}

function generateUlaPrefix(): string {
    const bytes = new Uint8Array(16);
    bytes[0] = 0xfd;
    crypto.getRandomValues(bytes.subarray(1, 6));
    return `${ipaddr.fromByteArray(Array.from(bytes)).toString()}/48`;
}

function topHalf(cidr: string): string {
    const [addr, len] = ipaddr.parseCIDR(cidr);
    if (len >= 128) {
        throw new CliExitError(2, `prefix /${len} is too narrow to split`);
    }
    const bytes = addr.toByteArray().slice();
    const byteIdx = Math.floor(len / 8);
    const bitIdx = 7 - (len % 8);
    const current = bytes[byteIdx] ?? 0;
    bytes[byteIdx] = current | (1 << bitIdx);
    return `${ipaddr.fromByteArray(bytes).toString()}/${len + 1}`;
}

function validateCidr(value: string, field: string): void {
    try {
        ipaddr.parseCIDR(value);
    } catch {
        throw new CliExitError(2, `--${field} is not a valid CIDR: ${value}`);
    }
}
