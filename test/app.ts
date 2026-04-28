import { deploy, hosts, podman, protocols } from '@bensku/tunkki';

hosts([
    {
        id: 'test1',
        conn: protocols.proxyCmd(
            [
                'limactl',
                'shell',
                'test1',
                'sudo',
                '/opt/tunkki/tunkki',
                '--debug',
            ],
            [
                'sh',
                '-c',
                `limactl shell test1 sudo sh -c 'mkdir -p $(dirname "$0") && tee "$0" >/dev/null && chmod +x "$0"' "$REMOTE_PATH" < "$LOCAL_PATH"`,
            ],
        ),
    },
    {
        id: 'test2',
        conn: protocols.proxyCmd(
            [
                'limactl',
                'shell',
                'test2',
                'sudo',
                '/opt/tunkki/tunkki',
                '--debug',
            ],
            [
                'sh',
                '-c',
                `limactl shell test2 sudo sh -c 'mkdir -p $(dirname "$0") && tee "$0" >/dev/null && chmod +x "$0"' "$REMOTE_PATH" < "$LOCAL_PATH"`,
            ],
        ),
    },
    {
        id: 'test3',
        conn: protocols.proxyCmd(
            [
                'limactl',
                'shell',
                'test3',
                'sudo',
                '/opt/tunkki/tunkki',
                '--debug',
            ],
            [
                'sh',
                '-c',
                `limactl shell test3 sudo sh -c 'mkdir -p $(dirname "$0") && tee "$0" >/dev/null && chmod +x "$0"' "$REMOTE_PATH" < "$LOCAL_PATH"`,
            ],
        ),
    },
]);

podman.pod('test-nginx', {});

deploy({});
