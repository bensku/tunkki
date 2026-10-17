import * as path from 'node:path';
import ipaddr from 'ipaddr.js';
import {
    type Firewall,
    type FirewallRule,
    formatFirewallRule,
    type NebulaFirewall,
} from './firewall';
import type { CA, Network, VirtualIP } from './network';

export interface Endpoint {
    /**
     * Id of the network this endpoint belongs to.
     */
    network: string;

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

    /**
     * Nebula firewall configuration.
     */
    firewall: Firewall;

    logLevel?: string;

    /**
     * Names of non-default routes to enable for this endpoint.
     */
    enableRoutes?: string[];
}

export async function endpointToConfig(network: Network, endpoint: Endpoint) {
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

    return {
        // Import network's shared config!
        import: `network/${endpoint.network}.yml`,
        pki: {
            // Actual host/endpoint key material is secret!
            cert: `/etc/nebula/endpoints/${endpoint.id}/host.crt`,
            key: `/etc/nebula/endpoints/${endpoint.id}/host.key`,
            _updated_at: Date.now(), // Make sure nebula-netavark reloads, because it won't wartch host.crt or key!
        },
        lighthouse: network.lighthouses.find((lh) => lh.vpnIp === endpoint.ip)
            ? {
                  hosts: [], // Override lighthouse hosts, active lighthouse must not have any
                  am_lighthouse: true,
                  serve_dns: true,
                  dns: {
                      host: endpoint.ip,
                      port: 53,
                  },
              }
            : undefined,
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
            host: endpoint.underlay?.host,
            port: endpoint.underlay?.port ?? 0,
            // TODO rest of configs
        },
        // TODO routines
        punchy: {
            // TODO configurable, if you were to somehow need this with IPv6
            punch: false,
        },
        // TODO preferred_ranges, sshd, relay, tun
        logging: {
            level: endpoint.logLevel ?? 'info',
            format: 'json',
        },
        enable_routes: endpoint.enableRoutes,
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
        ...renderUnsafeAddresses(network, endpoint),
    };
}

function renderUnsafeAddresses(network: Network, endpoint: Endpoint) {
    const endpointIp = endpoint.ip;
    if (!endpointIp) {
        return {};
    }
    return {
        // Find VIPs that mention this endpoint as targets
        // Add their VIPs as unsafe_addresses (nebula-netavark specialty) here
        unsafe_addresses: Object.entries(network.virtualIps)
            .map(([_, vip]) => vip)
            .filter((vip) => vip.targets.includes(endpointIp))
            .map((vip) => vip.vip),
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
