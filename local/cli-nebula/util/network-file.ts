import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ipaddr from 'ipaddr.js';
import type { CA, Network } from '../../../task/util/nebula';
import { CliExitError } from '../parse';

export async function readNetwork(file: string): Promise<Network> {
    let text: string;
    try {
        text = await Bun.file(file).text();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new CliExitError(1, `cannot read ${file}: ${msg}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new CliExitError(1, `invalid JSON in ${file}: ${msg}`);
    }
    return validateNetwork(parsed, file);
}

export async function writeNetwork(
    file: string,
    network: Network,
): Promise<void> {
    const dir = path.dirname(path.resolve(file));
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    const serialized = `${JSON.stringify(network, null, 2)}\n`;
    await Bun.file(tmp).write(serialized);
    await fs.rename(tmp, file);
}

function validateNetwork(value: unknown, file: string): Network {
    if (!value || typeof value !== 'object') {
        throw new CliExitError(1, `${file}: not a JSON object`);
    }
    const obj = value as Record<string, unknown>;
    requireCidr(obj.prefix, 'prefix', file);
    requireCidr(obj.dynamicIpArea, 'dynamicIpArea', file);
    const signingCA = requireCA(obj.signingCA, 'signingCA', file);
    const trustedCAs = requireCAList(obj.trustedCAs, 'trustedCAs', file);
    const lighthouses = requireLighthouses(obj.lighthouses, file);

    return {
        prefix: obj.prefix as string,
        dynamicPrefix: obj.dynamicIpArea as string,
        signingCA,
        trustedCAs,
        lighthouses,
    };
}

function requireCidr(v: unknown, field: string, file: string): void {
    if (typeof v !== 'string') {
        throw new CliExitError(1, `${file}: ${field} must be a string`);
    }
    try {
        ipaddr.parseCIDR(v);
    } catch {
        throw new CliExitError(
            1,
            `${file}: ${field} is not a valid CIDR: ${v}`,
        );
    }
}

function requireCA(v: unknown, field: string, file: string): CA {
    if (!v || typeof v !== 'object') {
        throw new CliExitError(1, `${file}: ${field} must be an object`);
    }
    const o = v as Record<string, unknown>;
    if (typeof o.key !== 'string' || typeof o.cert !== 'string') {
        throw new CliExitError(
            1,
            `${file}: ${field} must have string key and cert paths`,
        );
    }
    return { key: o.key, cert: o.cert };
}

function requireCAList(v: unknown, field: string, file: string): CA[] {
    if (!Array.isArray(v)) {
        throw new CliExitError(1, `${file}: ${field} must be an array`);
    }
    return v.map((entry, i) => requireCA(entry, `${field}[${i}]`, file));
}

function requireLighthouses(
    v: unknown,
    file: string,
): { vpnIp: string; underlayAddr: string }[] {
    if (!Array.isArray(v)) {
        throw new CliExitError(1, `${file}: lighthouses must be an array`);
    }
    return v.map((entry, i) => {
        if (!entry || typeof entry !== 'object') {
            throw new CliExitError(
                1,
                `${file}: lighthouses[${i}] must be an object`,
            );
        }
        const o = entry as Record<string, unknown>;
        if (typeof o.vpnIp !== 'string' || typeof o.underlayAddr !== 'string') {
            throw new CliExitError(
                1,
                `${file}: lighthouses[${i}] needs string vpnIp and underlayAddr`,
            );
        }
        return { vpnIp: o.vpnIp, underlayAddr: o.underlayAddr };
    });
}
