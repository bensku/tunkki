import { files, type Host, podman, protocols } from '@bensku/tunkki';
import network from './network.json' with { type: 'json' };

export const TEST_HOSTS: Host[] = [
    {
        id: 'test1',
        tags: {
            hostVpnIp: network.lighthouses[0]!.vpnIp,
        },
        conn: protocols.proxyCmd(
            ['limactl', 'shell', 'test1', 'sudo', '/opt/tunkki/tunkki'],
            [
                'sh',
                '-c',
                `limactl shell test1 sudo sh -c 'mkdir -p $(dirname "$0") && tee "$0" >/dev/null && chmod +x "$0"' "$REMOTE_PATH" < "$LOCAL_PATH"`,
            ],
        ),
    },
    {
        id: 'test2',
        tags: {
            hostVpnIp: network.lighthouses[1]!.vpnIp,
        },
        conn: protocols.proxyCmd(
            ['limactl', 'shell', 'test2', 'sudo', '/opt/tunkki/tunkki'],
            [
                'sh',
                '-c',
                `limactl shell test2 sudo sh -c 'mkdir -p $(dirname "$0") && tee "$0" >/dev/null && chmod +x "$0"' "$REMOTE_PATH" < "$LOCAL_PATH"`,
            ],
        ),
    },
    {
        id: 'test3',
        tags: {
            hostVpnIp: 'fdce:1743:c829:756c:5cfc:7158:a051:c3ac', // Not lighthouse!
        },
        conn: protocols.proxyCmd(
            ['limactl', 'shell', 'test3', 'sudo', '/opt/tunkki/tunkki'],
            [
                'sh',
                '-c',
                `limactl shell test3 sudo sh -c 'mkdir -p $(dirname "$0") && tee "$0" >/dev/null && chmod +x "$0"' "$REMOTE_PATH" < "$LOCAL_PATH"`,
            ],
        ),
    },
];
