import { deploy, nebula, on, podman } from '@bensku/tunkki';
import { TEST_HOSTS } from './host';

const network = await nebula.network(import.meta.resolve('./network.json'));

on('*', (host) => {
    const setup = nebula.setup('nebula-setup', {
        localPath: '../nebula',
    });
    const hostEndpoint = nebula.endpoint(
        'host-endpoint',
        {
            network,
            id: 'host',
            hostname: `${host.id}.nebula.test`,
            ip: host.tags?.hostVpnIp,
            underlay: {
                port: 4242,
            },
            groups: ['host'],
            firewall: {
                outbound: [
                    {
                        port: 'any',
                        host: 'any',
                    },
                ],
                inbound: [
                    {
                        port: 'any',
                        host: 'any',
                    },
                ],
            },
        },
        { after: [setup.id] },
    );
    hostEndpoint.service();

    nebula.netavarkSetup('netavark-setup', {
        localPath: '../nebula-netavark',
    });
});

on('test1', () => {
    const nginxEndpoint = nebula.endpoint('nginx-endpoint', {
        network,
        id: 'nginx',
        hostname: `nginx1.nebula.test`,
        groups: ['nginx'],
        firewall: {
            outbound: [],
            inbound: [
                {
                    port: 'any',
                    group: 'host',
                },
            ],
        },
    });
    podman.container(
        'nginx',
        {
            name: 'nginx',
            image: 'docker.io/nginx:latest',
            network: ['nebula'],
        },
        { after: [nginxEndpoint.id] },
    );
});

deploy('nebula', TEST_HOSTS);
