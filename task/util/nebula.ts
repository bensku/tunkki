import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ipaddr from 'ipaddr.js';

export interface Network {
    /**
     * Network prefix.
     */
    prefix: string;

    /**
     * Area within network that is used to assign random, dynamic IPs for
     * endpoints that do not specify their own.
     */
    dynamicPrefix: string;

    /**
     * CA for signing the endpoint's certificates. This must be present in
     * trustedCAs for all endpoints within same network.
     */
    signingCA: CA;

    /**
     * CAs that this endpoint will trust.
     */
    trustedCAs: CA[];

    /**
     * Lighthouses that endpoints can use to discover each other.
     */
    lighthouses: {
        /**
         * Overlay IP address of the lighthouse.
         */
        vpnIp: string;

        /**
         * Real, reachable underlay address of the lighthouse. Must include
         * IP/DNS name in form of host:port, e.g. 1.2.3.4:4242
         */
        underlayAddr: string;
    }[];

    unsafeRoutes?: UnsafeRoute[];
}

export interface CA {
    /**
     * Path to CA private key.
     */
    key: string;

    /**
     * Path to CA certificate.
     */
    cert: string;
}

export interface UnsafeRoute {
    /**
     * Prefix this route covers.
     */
    route: string;

    /**
     * VPN IPs of gateway endpoints the traffic should exit from.
     * Note that host running gateway must have IP forward enabled.
     * NAT is not required, but if you want to use it, that needs to be
     * configured manually on gateway hosts.
     */
    via: string[];
}

interface FirewallRuleBase {
    port: number | 'any';
    proto?: 'tcp' | 'udp' | 'icmp' | 'any';
    localCidr?: string;
}

interface FirewallGroupsRule extends FirewallRuleBase {
    group: string;
    host?: never;
}

interface FirewallHostRule extends FirewallRuleBase {
    host: string | 'any';
    group?: never;
}

type FirewallRule = FirewallGroupsRule | FirewallHostRule;

/**
 * Firewall declarations is close-to-Nebula format.
 */
interface NebulaFirewall {
    outbound: FirewallRule[];
    inbound: FirewallRule[];
}

/**
 * Firewall declarations in a simpler format that merges outbound and inbound.
 */
type SimpleFirewall = [
    'in' | 'out', // Direction
    number | 'any', // Port or any to allow all ports
    string | 'any', // Group to allow or any for all groups
][];

export type Firewall = NebulaFirewall | SimpleFirewall;

export interface Endpoint {
    /**
     * Configuration that all endpoints within a network should usually share.
     */
    network: Network;

    /**
     * Endpoint id. This is NOT same as hostname, and only needs to be unique
     * within machine. Containers join networks by their ids.
     */
    id: string;

    /**
     * Hostname for endpoint. Usually, this must be unique within network.
     */
    hostname: string;

    /**
     * Overlay IP address for the endpoint. If absent, we'll auto-assign one
     * from host's pool.
     */
    ip?: string;

    /**
     * Underlay networking configuration. Optional. If absent, Nebula will
     * listen on all interfaces on kernel-selected port.
     */
    underlay?: {
        host?: string;
        port?: number;
    };

    /**
     * Firewall groups of this endpoint. Firewall rules in other endpoints may
     * refer to these to allow traffic.
     */
    groups: string[];

    firewall: Firewall;

    logLevel?: string;
}

export async function toNebulaConfig(endpoint: Endpoint) {
    const cas = await Promise.all(
        endpoint.network.trustedCAs.map((ca) => Bun.file(ca.cert).text()),
    );
    const staticHosts: Record<string, string[]> = {};
    for (const lh of endpoint.network.lighthouses) {
        staticHosts[lh.vpnIp] = [lh.underlayAddr];
    }

    let lighthouse: unknown;
    if (endpoint.network.lighthouses.find((lh) => lh.vpnIp === endpoint.ip)) {
        // I am lighthouse
        lighthouse = {
            am_lighthouse: true,
            serve_dns: true,
            dns: {
                host: endpoint.ip,
                port: 53,
            },
        };
    } else {
        // Not a lighthouse
        lighthouse = {
            hosts: endpoint.network.lighthouses.map((lh) => lh.vpnIp),
        };
    }

    // Convert simple firewalls to format closer to what Nebula understands
    let firewall: NebulaFirewall;
    if (Array.isArray(endpoint.firewall)) {
        firewall = {
            outbound: [],
            inbound: [],
        };
        for (const [dir, port, group] of endpoint.firewall) {
            let rule: FirewallRule;
            if (group === 'any') {
                rule = {
                    port,
                    host: 'any',
                };
            } else {
                rule = {
                    port,
                    group,
                };
            }
            if (dir === 'in') {
                firewall.inbound.push(rule);
            } else {
                firewall.outbound.push(rule);
            }
        }
    } else {
        firewall = endpoint.firewall;
    }

    const formatFirewallRule = (rule: FirewallRule) => {
        return {
            port: rule.port,
            proto: rule.proto ?? 'any',
            group: rule.group,
            host: rule.host,
            local_cidr: rule.localCidr,
        };
    };

    return {
        pki: {
            // CAs inline, not very secret
            ca: cas.join('\n'),
            // Actual host/endpoint key material is secret!
            cert: `/etc/nebula/endpoints/${endpoint.id}/host.crt`,
            key: `/etc/nebula/endpoints/${endpoint.id}/host.key`,
            // TODO blocklist
            initiating_version: 2, // Use exclusively V2 certificates
        },
        static_host_map: staticHosts,
        lighthouse,
        // TODO remote_allow_list, remote_allow_ranges
        local_allow_list: {
            // TODO configurable
            interfaces: {
                // Don't advertise Nebula or container IPs to lighthouses
                'tun.*': false,
                'veth.*': false,
                'podman.*': false,
            },
        },
        listen: {
            host: endpoint.underlay?.host ?? '::',
            port: endpoint.underlay?.port ?? 0,
            // TODO rest of configs
        },
        // TODO routines
        punchy: {
            // TODO configurable, if you were to somehow need this with IPv6
            punch: false,
        },
        cipher: 'aes',
        // TODO preferred_ranges, sshd, relay, tun
        logging: {
            level: endpoint.logLevel ?? 'info',
            format: 'json',
        },
        tun: {
            unsafe_routes: endpoint.network.unsafeRoutes?.map((route) => ({
                route: route.route,
                via: route.via.map(via => ({ gateway: via })),
            })),
        },
        // TODO stats, handshakes
        tunnels: {
            drop_inactive: true, // TODO configurable
            inactivity_timeout: '3m',
        },
        firewall: {
            // TODO inbound_action, outbound_action, conntract, etc.
            // TODO unsafe hosts directly allowing hosts, allowing entire CAs, etc.
            outbound: firewall.outbound.map(formatFirewallRule),
            inbound: firewall.inbound.map(formatFirewallRule),
        },
    };
}

/**
 * Load a Network from a JSON file, resolving CA cert/key paths to absolute
 * paths relative to the JSON file's directory. Use this instead of a bare
 * `import network from './network.json' with { type: 'json' }` so that the
 * resulting Network is usable regardless of the deploy script's cwd.
 *
 * Pass `import.meta.resolve('./network.json')` (a file:// URL), or any
 * absolute filesystem path. Relative paths are rejected — there is no
 * sensible base to resolve them against.
 */
export async function loadNetwork(jsonLocation: string): Promise<Network> {
    const jsonPath = locationToAbsPath(jsonLocation);
    const baseDir = path.dirname(jsonPath);
    const text = await Bun.file(jsonPath).text();
    const raw = JSON.parse(text) as Network;
    return {
        ...raw,
        signingCA: resolveCA(baseDir, raw.signingCA),
        trustedCAs: raw.trustedCAs.map((ca) => resolveCA(baseDir, ca)),
    };
}

function locationToAbsPath(location: string): string {
    if (location.startsWith('file://')) return fileURLToPath(location);
    if (path.isAbsolute(location)) return location;
    throw new Error(
        `loadNetwork: expected an absolute path or file:// URL, got: ${location} (try \`import.meta.resolve('./network.json')\`)`,
    );
}

function resolveCA(baseDir: string, ca: CA): CA {
    return {
        cert: path.isAbsolute(ca.cert) ? ca.cert : path.join(baseDir, ca.cert),
        key: path.isAbsolute(ca.key) ? ca.key : path.join(baseDir, ca.key),
    };
}

export function getRandomIp(cidr: string): string {
    const [prefix, prefixLen] = ipaddr.parseCIDR(cidr);
    const prefixBytes = prefix.toByteArray();
    const totalBytes = prefixBytes.length; // 4 for IPv4, 16 for IPv6
    const random = crypto.getRandomValues(new Uint8Array(totalBytes));

    const out = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i++) {
        const bitStart = i * 8;
        const pByte = prefixBytes[i]!;
        const rByte = random[i]!;
        if (bitStart + 8 <= prefixLen) {
            out[i] = pByte;
        } else if (bitStart >= prefixLen) {
            out[i] = rByte;
        } else {
            const keep = prefixLen - bitStart;
            const mask = (0xff << (8 - keep)) & 0xff;
            out[i] = (pByte & mask) | (rByte & ~mask);
        }
    }
    return ipaddr.fromByteArray(Array.from(out)).toString();
}

export function getPrefixLen(cidr: string): number {
    const [, prefixLen] = ipaddr.IPv6.parseCIDR(cidr);
    return prefixLen;
}
