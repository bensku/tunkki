import { deploy, nebula, on, podman } from '@bensku/tunkki';
import { TEST_HOSTS } from './host';

const network = await nebula.network(import.meta.resolve('./network.json'));

on('*', (host) => {
    const nginx = podman.container('nginx2', {
        name: 'nginx2',
        image: 'docker.io/nginx:latest',
    });
    nginx.connectNebula({
        network,
        hostname: `${host.id}.nginx2.nebula.test`,
        groups: ['nginx2'],
        firewall: [
            ['in', 80, 'any'], // allow all inbound
        ],
    });

    const config = `server {
    listen       80;
    listen  [::]:80;
    server_name  localhost;

    location / {
        return 200 'healthy host ${host.id}';
    }
}`

    const nginx3 = podman.container('nginx3', {
        name: 'nginx3',
        image: 'docker.io/nginx:latest',
        configFiles: [
            ['/etc/nginx/conf.d/default.conf', config],
        ]
    });
    nginx3.connectNebula({
        network,
        ip: 'fdce:1743:c829:1568:8830:4a85:ed1a:1e8c',
        hostname: `ha-nginx.nebula.test`,
        groups: ['nginx3'],
        firewall: [
            ['in', 80, 'any'], // allow all inbound
        ],
    });
});

deploy('nebula2', TEST_HOSTS);
