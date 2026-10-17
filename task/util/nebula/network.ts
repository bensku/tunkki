export interface Network {
    /**
     * Network id. Must be unique within hosts.
     */
    id: string;

    /**
     * Network prefix in CIDR format.
     */
    prefix: string;

    /**
     * Area within network that is used to assign random, dynamic IPs for
     * endpoints that do not specify their own. Must be entirely within prefix.
     */
    dynamicPrefix: string;

    /**
     * CA for signing the endpoint's certificates. This must be present in
     * trustedCAs for all endpoints within same network.
     */
    signingCA: CA;

    /**
     * CAs that this endpoint will trust. This should include at least the
     * current signingCA.
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

    /**
     * Routes outside this network.
     */
    routes: Record<string, NamedRoute>;

    /**
     * Failover IPs in this network. Built on top of routes.
     */
    virtualIps: Record<string, VirtualIP>;

    /**
     * List of DNS servers that containers joining this network should receive.
     * Does NOT affect host-side DNS servers! Changes take effect only after
     * containers are restarted.
     */
    dnsServers?: string[];

    /**
     * Underlay configuration. If specified, affects all endpoints on machines
     * it is configured on, except those that override this on their own.
     */
    underlay?: {
        host?: string;
    };
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

export interface NamedRoute {
    /**
     * Prefix in CIDR notation that this route covers. Must NOT overlap with
     * the network's prefix!
     */
    route: string;

    /**
     * VPN IPs of gateway endpoints the traffic should exit from.
     * Note that host running gateway must have IP forward enabled.
     *
     * Note that NAT is not automatically configured. You'll need to set it up
     * yourself if you need it.
     */
    via: {
        /**
         * VPN IP.
         */
        gateway: string;

        /**
         * Route weight. A route gets weights[route] / sum(weights) * 100% of
         * traffic. For example, if one route has weight of 99 and another 1,
         * the former gets 99% of traffic.
         *
         * Weight must be a positive number. If you want the first route to get "all"
         * traffic as long as it is up, use an absurdly high weight (e.g. 1 million).
         */
        weight: number;
    }[];

    /**
     * If true, all endpoints on network enable this route by default.
     * Otherwise, endpoints must specify name of this route in their
     * enabledRoutes.
     */
    default: boolean;
}

export interface VirtualIP {
    /**
     * The IP address. Must be outside the network's prefix!
     */
    vip: string;

    /**
     * IPs of endpoints that the traffic to this VIP should be sent to.
     */
    targets: string[];

    /**
     * Type of this VIP.
     *
     * 'failover' means that most traffic is sent to the first available
     * endpoint on list.
     */
    type: 'failover';
}

export async function networkToConfig(network: Network) {
    const cas = await Promise.all(
        network.trustedCAs.map((ca) => Bun.file(ca.cert).text()),
    );
    const staticHosts: Record<string, string[]> = {};
    for (const lh of network.lighthouses) {
        staticHosts[lh.vpnIp] = [lh.underlayAddr];
    }

    // Generate routes from VIPs
    const routes = { ...network.routes };
    for (const [id, vip] of Object.entries(network.virtualIps)) {
        routes[id] = {
            route: `${vip.vip}/128`,
            via: vip.targets.map((ip, i) => ({
                gateway: ip,
                weight: i === 0 ? 1000000 : 1,
            })),
            default: true, // VIPs are routable everywhere (but of course not necessarily reachable due to firewall)
        };
    }

    return {
        _net: network,
        pki: {
            // CAs inline, not very secret
            ca: cas.join('\n'),
            // TODO blocklist
            initiating_version: 2, // Use exclusively V2 certificates
        },
        static_host_map: staticHosts,
        listen: {
            host: network.underlay?.host ?? '::',
            // TODO rest of configs
        },
        lighthouse: {
            // Actual lighthouses will override this with empty array + lighthouse-specific config
            hosts: network.lighthouses.map((lh) => lh.vpnIp),
        },
        cipher: 'aes',
        named_routes: routes, // "conveniently" the syntax is same (this is also nebula-netavark patch)
        dns_servers: network.dnsServers, // nebula-netavark gives these to containers
        tunkki: {
            prefix: network.prefix,
            dynamic_prefix: network.dynamicPrefix,
        },
    };
}
