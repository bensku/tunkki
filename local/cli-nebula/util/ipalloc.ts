import ipaddr from 'ipaddr.js';
import { getRandomIp } from '../../../task/util/nebula';
import { CliExitError } from '../parse';

export function cidrContainsIp(ip: string, cidr: string): boolean {
    const addr = ipaddr.parse(ip);
    const parsed = ipaddr.parseCIDR(cidr);
    const network = parsed[0];
    if (addr.kind() !== network.kind()) return false;
    return addr.match(parsed);
}

export function cidrContainsCidr(inner: string, outer: string): boolean {
    const [innerAddr, innerLen] = ipaddr.parseCIDR(inner);
    const [outerAddr, outerLen] = ipaddr.parseCIDR(outer);
    if (innerAddr.kind() !== outerAddr.kind()) return false;
    if (innerLen < outerLen) return false;
    return innerAddr.match([outerAddr, outerLen]);
}

export function normalizeIp(ip: string): string {
    return ipaddr.parse(ip).toNormalizedString();
}

export interface AllocateOpts {
    prefix: string;
    excluded: string;
    used: Iterable<string>;
    maxAttempts?: number;
}

export function allocateStaticIp(opts: AllocateOpts): string {
    const usedSet = new Set<string>();
    for (const ip of opts.used) {
        try {
            usedSet.add(normalizeIp(ip));
        } catch {
            // Ignore unparsable existing IPs; user can clean them up.
        }
    }
    const max = opts.maxAttempts ?? 100;
    for (let i = 0; i < max; i++) {
        const candidate = getRandomIp(opts.prefix);
        if (cidrContainsIp(candidate, opts.excluded)) continue;
        const norm = normalizeIp(candidate);
        if (usedSet.has(norm)) continue;
        return candidate;
    }
    throw new CliExitError(
        1,
        `failed to allocate a static IP outside ${opts.excluded} after ${max} attempts`,
    );
}
