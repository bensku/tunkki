import { deploy, nebula, on, podman } from '@bensku/tunkki';
import { TEST_HOSTS } from './host';

const NGINX_IP = 'fd99:40c0:9ffa:1189:6d30:5f9c:72a3:dc85';
const GATEWAY_IPS: Record<string, string> = {
    test1: 'fdce:1743:c829:1859:7c29:11d6:b9ac:61c1',
    test2: 'fdce:1743:c829:30cf:581d:e727:5eee:1fa',
    test3: 'fdce:1743:c829:9:d08b:4721:54a9:7f90',
};

const network = await nebula.network(import.meta.resolve('./network.json'));

on('*', (host) => {
    const net = podman.network('nginx-net', {
        name: 'nginx-net',
        subnet: 'fd99:40c0:9ffa::/48',
        internal: true,
    });

    const config = `server {
    listen       80;
    listen  [::]:80;
    server_name  localhost;

    location / {
        return 200 'healthy host ${host.id}';
    }
}`;
    const nginx = podman.container(
        'nginx',
        {
            name: 'nginx',
            image: 'docker.io/nginx:latest',
            network: [`nginx-net:ip6=${NGINX_IP}`],
            configFiles: [['/etc/nginx/conf.d/default.conf', config]],
        },
        { after: [net.id] },
    );
    nginx.connectNebula({
        network,
        hostname: `${host.id}.nginx2.nebula.test`,
        ip: GATEWAY_IPS[host.id],
        groups: ['nginx'],
        firewall: {
            inbound: [
                {
                    port: 80,
                    host: 'any',
                    localCidr: '::/0',
                },
                {
                    port: 'any',
                    proto: 'icmp',
                    host: 'any',
                    localCidr: '::/0',
                },
            ],
            outbound: [],
        },
    });
});

deploy('nebula-unsafe', TEST_HOSTS);
