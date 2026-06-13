import { deploy, nebula, on, podman } from '@bensku/tunkki';
import { TEST_HOSTS } from './host';

const network = await nebula.network(import.meta.resolve('./network.json'));

const TARGET_IPS: Record<string, string> = {
    test1: 'fdce:1743:c829:364e:8ec2:2876:7f0a:5adc',
    test2: 'fdce:1743:c829:8ba:69a1:e452:36f6:29ec',
    test3: 'fdce:1743:c829:5030:d8d5:9ac2:ccab:6ec6',
};

on('*', (host) => {
    const targetCfg = `server {
    listen       80;
    listen  [::]:80;
    server_name  localhost;

    location / {
        return 200 'healthy host ${host.id}';
    }
}`;

    const target = podman.container('bridge-target', {
        name: 'bridge-target',
        image: 'docker.io/nginx:latest',
        configFiles: [['/etc/nginx/conf.d/default.conf', targetCfg]],
    });
    target.connectNebula({
        network,
        hostname: `${host.id}.bridge-target.nebula.test`,
        ip: TARGET_IPS[host.id],
        groups: ['bridge-target'],
        firewall: [
            ['in', 80, 'any'], // allow all inbound
        ],
    });

    const bridgeSetup = nebula.bridgedSetup('bridge-setup', {
        localPath: '../bridged',
    });
    nebula.bridge(
        'bridge',
        {
            id: 'test',
            ingress: {
                network,
                hostname: 'bridge.nebula.test',
                ip: 'fdce:1743:c829:5eb6:e784:8590:8502:deba',
                groups: ['bridge-in'],
                firewall: [
                    ['in', 80, 'any'], // allow all inbound
                ],
            },
            egress: {
                network,
                hostname: `${host.id}.bridge-out.nebula.test`,
                groups: ['bridge-out'],
                firewall: [
                    ['out', 80, 'any'], // allow all inbound
                ],
            },
            routes: [
                {
                    listen: ':80',
                    targets: [
                        // Hosts don't have Nebula DNS available!
                        `[${TARGET_IPS.test1}]:80`,
                        `[${TARGET_IPS.test2}]:80`,
                        `[${TARGET_IPS.test3}]:80`,
                    ],
                    type: 'first_healthy',
                    timeout: '3s',
                    health: {
                        interval: '10s',
                        ok_threshold: 1,
                        fail_threshold: 1,
                        window: 2,
                    },
                },
            ],
        },
        { after: [bridgeSetup.id] },
    );
});

deploy('bridges', TEST_HOSTS);
