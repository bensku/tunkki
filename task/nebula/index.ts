import * as path from 'node:path';
import { files, podman, systemd } from '@bensku/tunkki';
import { combine, type Output, taskType } from '@bensku/tunkki/task';
import { nebula } from '@bensku/tunkki/task/util';

export type Network = nebula.Network;
export type CA = nebula.CA;
export const network = nebula.loadNetwork;

export interface SetupState {
    localPath: string;
}

/**
 * Installs Nebula on host. Note that for container networking, you also
 * need nebula-netavark, which is installed with nebula.netavarkSetup!
 */
export const setup = combine<SetupState, Output>((state, opts) => {
    const daemonFile = files.put(
        'nebula',
        {
            localPath: path.join(state.localPath, 'nebula'),
            remotePath: '/usr/local/bin/nebula',
            mode: 0o755,
        },
        opts,
    );
    files.put(
        'nebula-cert',
        {
            localPath: path.join(state.localPath, 'nebula-cert'),
            remotePath: '/usr/local/bin/nebula-cert',
            mode: 0o755,
        },
        { ...opts, after: [daemonFile.id] },
    );
});

/**
 * Installs nebula-netavark, i.e. container networking support for Nebula.
 * Base Nebula installation is required; nebula.setup can do that for you.
 */
export const netavarkSetup = combine<SetupState, Output>((state, opts) => {
    // Copy binaries to target
    const daemonFile = files.put(
        'nebula-netavarkd',
        {
            localPath: path.join(state.localPath, 'nebula-netavarkd'),
            remotePath: '/usr/local/bin/nebula-netavarkd',
            mode: 0o755,
        },
        opts,
    );
    const pluginFile = files.put(
        'plugin',
        {
            localPath: path.join(state.localPath, 'nebula-netavark-plugin'),
            remotePath: '/usr/local/lib/netavark/nebula',
            mode: 0o755,
        },
        opts,
    );

    // Enable nebula-netavarkd service
    const svc = systemd.service(
        'service',
        {
            name: 'nebula-netavarkd',
            type: 'notify',
            exec: ['/usr/local/bin/nebula-netavarkd'],
            execReload: '/bin/kill -HUP $MAINPID',
            restart: 'on-failure',
            install: {
                wantedBy: 'multi-user.target',
            },
        },
        { ...opts, dependsOn: [daemonFile.id, pluginFile.id] },
    );

    // Create podman network unless it already existed
    podman.network(
        'nebulanet',
        {
            name: 'nebula',
            driver: 'nebula',
            networkDeleteOnStop: true,
        },
        { ...opts, after: [svc.id] },
    );
});

/**
 * Setups bridged daemon for creating highly-available bridges
 * (between or within networks). EXPERIMENTAL!
 */
export const bridgedSetup = combine<SetupState, Output>((state, opts) => {
    files.put(
        'nebula-netavarkd',
        {
            localPath: path.join(state.localPath, 'bridged'),
            remotePath: '/usr/local/bin/bridged',
            mode: 0o755,
        },
        opts,
    );
});

interface EndpointOutput {
    /**
     * Install a Nebula service on host for this endpoint.
     */
    service: () => Output;
}

export type Endpoint = nebula.Endpoint;

/**
 * Creates a Nebula endpoint, but does not by itself connect it to anything.
 */
export const endpoint = taskType<nebula.Endpoint, EndpointOutput>(
    'nebula.endpoint',
    import.meta.resolve('./endpoint'),
    (id, state) => ({
        service: () =>
            systemd.service(
                `${id}.service`,
                {
                    name: `nebula-${state.id}`,
                    type: 'notify',
                    exec: [
                        '/usr/local/bin/nebula',
                        '-config',
                        `/etc/containers/nebula/${state.id}.yml`,
                    ],
                    execReload: '/bin/kill -HUP $MAINPID',
                    restart: 'on-failure',
                    install: {
                        wantedBy: 'multi-user.target',
                    },
                },
                { dependsOn: [id] },
            ),
    }),
);

interface BridgeRoute {
    listen: string;
    http_host?: string;
    sni_host?: string;

    targets: string[];
    type: 'first_healthy';
    timeout: string;

    health: {
        interval: string;
        window: number;
        ok_threshold: number;
        fail_threshold: number;

        tcp?: {
            enabled: boolean;
            port?: string;
        };
        http?: {
            enabled: boolean;
            port?: string;
            path: string;
            method?: string;
        };
        dns?: {
            enabled: boolean;
            query_name?: string;
            query_type?: string;
        };
    };
}

export interface BridgeState {
    id: string;
    ingress: Omit<nebula.Endpoint, 'id'>;
    egress: Omit<nebula.Endpoint, 'id'>;
    routes: BridgeRoute[];
}

/**
 * Creates a bridge. EXPERIMENTAL
 */
export const bridge = combine<BridgeState, Output>((state, opts) => {
    const ingress = endpoint(
        'ingress',
        { ...state.ingress, id: `${state.id}-ingress` },
        opts,
    );
    const egress = endpoint(
        'egress',
        { ...state.egress, id: `${state.id}-egress` },
        opts,
    );

    const routesCfg = files.put(
        'routes',
        {
            content: state.routes,
            remotePath: `/etc/nebula/bridges/${state.id}.yml`,
        },
        opts,
    );

    systemd.service(
        'service',
        {
            name: `bridged-${state.id}`,
            type: 'simple',
            exec: [
                '/usr/local/bin/bridged',
                '-ingress-cfg',
                `/etc/containers/nebula/${state.id}-ingress.yml`,
                '-egress-cfg',
                `/etc/containers/nebula/${state.id}-egress.yml`,
                '-routes-cfg',
                `/etc/nebula/bridges/${state.id}.yml`,
            ],
            restart: 'on-failure',
            install: {
                wantedBy: 'multi-user.target',
            },
        },
        { ...opts, dependsOn: [ingress.id, egress.id, routesCfg.id] },
    );
});

interface DnsState {
    network: Network;
    ip: string;
    name: string;

    /**
     * Domain that should be served by Nebula lighthouse DNS.
     */
    nebulaDomain: string;

    /**
     * Additional static hosts, name to IP.
     */
    staticHosts: [string, string][];

    /**
     * Public resolvers that should be queried when we have no static host
     * and domain is not nebulaDomain.
     */
    publicResolvers: string[];

    groups?: string[];
    firewall?: nebula.Firewall;

    dnsmasqImage?: string;
}

interface DnsOutput {
    ip: string;
}

export const dns = combine<DnsState, DnsOutput>((state, opts) => {
    const lines: string[] = [
        '# Generated by tunkki nebula.dns - do not edit',
        // Only answer on the Nebula overlay address
        // bind-dynamic to tolerate TUN disappearing and reappearing on nebula-netavark crash
        `listen-address=${state.ip}`,
        'bind-dynamic',
        // We define upstreams explicitly below
        'no-resolv',
        'no-hosts',
        // Query every candidate upstream for a domain at once
        // Otherwise, we'll slow down to crawl if some lighthouses are down - not very HA!
        'all-servers',
        // Don't forward bare names or reverse lookups of private ranges upstream!
        'domain-needed',
        'bogus-priv',
    ];

    // Static hosts are answered authoritatively (forward A/AAAA + reverse PTR),
    // taking precedence over any forwarding below.
    for (const [name, ip] of state.staticHosts) {
        lines.push(`host-record=${name},${ip}`);
    }

    // The Nebula domain (and its subdomains) is resolved by the lighthouse DNS
    // servers, which listen on vpnIp:53 (see toNebulaConfig in util/nebula.ts).
    for (const lh of state.network.lighthouses) {
        lines.push(`server=/${state.nebulaDomain}/${lh.vpnIp}`);
    }

    // Everything else goes to the public resolvers.
    for (const resolver of state.publicResolvers) {
        lines.push(`server=${resolver}`);
    }

    const config = `${lines.join('\n')}\n`;

    const container = podman.container(
        'dns',
        {
            name: state.name,
            image:
                state.dnsmasqImage ??
                'ghcr.io/bensku/containerops-builds/dnsmasq@sha256:8b888007b39a618453e91d79cf6fef0919aae8caba51cbd187dee3da55836013',
            configFiles: [['/etc/dnsmasq.conf', config]],
            network: ['podman'], // Join default bridge to access public DNS servers!
            dns: state.ip, // Self-serve own DNS, mostly for admins podman exec'ing here to troubleshoot
        },
        opts,
    );
    container.connectNebula({
        network: state.network,
        hostname: `${state.name}.dns.internal`,
        ip: state.ip,
        groups: state.groups ?? ['dns'],
        firewall: state.firewall ?? [
            ['in', 53, 'any'],
            ['out', 53, 'any'],
        ],
    });

    return {
        ip: state.ip,
    };
});
