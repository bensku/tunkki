import { deploy, podman, protocols } from '@bensku/tunkki';

const pod2 = podman.pod('foo', {});
const pod1 = podman.pod('test-nginx', { foo: '123' }, [pod2.id]);
podman.pod('foobar', {}, [pod2.id]);

deploy('test', [
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
