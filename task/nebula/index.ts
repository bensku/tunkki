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
    health: {
        interval: string;
        timeout: string;
        window: number;
        ok_threshold: number;
        fail_threshold: number;
    };
}

export interface BridgeState {
    id: string;
    ingress: Omit<nebula.Endpoint, 'id'>;
    egress: Omit<nebula.Endpoint, 'id'>;
    routes: BridgeRoute[];
}

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
