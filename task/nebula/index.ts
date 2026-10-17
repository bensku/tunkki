import * as path from 'node:path';
import { files, podman, systemd } from '@bensku/tunkki';
import { combine, type Output, taskType } from '@bensku/tunkki/task';
import type { nebula } from '@bensku/tunkki/task/util';

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
            remotePath: '/usr/bin/nebula',
            mode: 0o755,
        },
        opts,
    );
    files.put(
        'nebula-cert',
        {
            localPath: path.join(state.localPath, 'nebula-cert'),
            remotePath: '/usr/bin/nebula-cert',
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
            remotePath: '/usr/bin/nebula-netavarkd',
            mode: 0o755,
        },
        opts,
    );
    const pluginFile = files.put(
        'plugin',
        {
            localPath: path.join(state.localPath, 'nebula-netavark-plugin'),
            remotePath: '/usr/lib/netavark/nebula',
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
            exec: ['/usr/bin/nebula-netavarkd'],
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

export type CA = nebula.CA;
export type Network = nebula.Network;

export const network = taskType<nebula.Network, Output>(
    'nebula.network',
    import.meta.resolve('./network'),
);

export type Endpoint = nebula.Endpoint;

/**
 * Creates a Nebula endpoint, but does not by itself connect it to anything.
 */
export const endpoint = taskType<nebula.Endpoint, Output>(
    'nebula.endpoint',
    import.meta.resolve('./endpoint'),
);
