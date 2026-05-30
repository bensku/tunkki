import * as path from 'node:path';
import { files, systemd } from '@bensku/tunkki';
import {
    combine,
    type Output,
    taskType,
} from '@bensku/tunkki/task';
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
    systemd.service(
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
});

interface EndpointOutput {
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
