import { deploy, nebula, on, podman } from '@bensku/tunkki';
import { TEST_HOSTS } from './host';

const network = await nebula.network(import.meta.resolve('./network.json'));

const DNS_SERVERS: Record<string, string> = {
    test1: 'fdce:1743:c829:873:f666:a83c:2724:d773',
    test2: 'fdce:1743:c829:38da:c3ef:62fc:8886:5ec5',
    test3: 'fdce:1743:c829:79ca:a6b6:8be6:b8da:1a31',
};

on('*', (host) => {
    const dns = nebula.dns('nebula-dns', {
        network,
        ip: DNS_SERVERS[host.id]!,
        name: `dns-${host.id}`,
        nebulaDomain: 'nebula.test',
        publicResolvers: ['1.1.1.1', '8.8.8.8'],
        staticHosts: [['foo.bar', '1.1.1.1']],
    });

    nebula.bridge('bridge', {
        id: 'dns',
        ingress: {
            network,
            hostname: 'dns.nebula.test',
            ip: 'fdce:1743:c829:155f:560c:eb11:aa82:4f6f',
            groups: ['bridge-in'],
            firewall: [
                ['in', 53, 'any'], // allow all inbound
            ],
        },
        egress: {
            network,
            hostname: `${host.id}.dns-out.nebula.test`,
            groups: ['bridge-out'],
            firewall: [
                ['out', 53, 'any'], // allow all inbound
            ],
        },
        routes: [
            {
                listen: ':53',
                targets: [
                    // Hosts don't have Nebula DNS available!
                    `[${DNS_SERVERS.test1}]:53`,
                    `[${DNS_SERVERS.test2}]:53`,
                    `[${DNS_SERVERS.test3}]:53`,
                ],
                type: 'first_healthy',
                timeout: '3s',
                health: {
                    interval: '10s',
                    ok_threshold: 1,
                    fail_threshold: 1,
                    window: 2,
                    dns: {
                        enabled: true,
                    },
                },
            },
        ],
    });

    const nginx2 = podman.container('nginx2', {
        name: 'nginx2',
        image: 'docker.io/nginx:latest',
        dns: dns.ip,
    });
    nginx2.connectNebula({
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
}`;

    const nginx3 = podman.container('nginx3', {
        name: 'nginx3',
        image: 'docker.io/nginx:latest',
        configFiles: [['/etc/nginx/conf.d/default.conf', config]],
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
