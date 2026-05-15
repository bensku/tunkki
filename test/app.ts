import { deploy, files, podman, protocols } from '@bensku/tunkki';

podman.container(
    'test-nginx',
    {
        name: 'nginx',
        image: 'docker.io/nginx:latest',
        publishPort: [
            {
                containerPort: 80,
                hostPort: 80,
            },
        ],
    },
    { rolling: true },
);

files.put('test-upload', {
    localPath: 'index.ts',
    remotePath: '/var/test/index.ts',
    mode: 0o777,
});
files.put('test-write', {
    content: 'hello!',
    remotePath: '/var/test/hello.txt',
});

deploy('test', [
    {
        id: 'test1',
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
        conn: protocols.proxyCmd(
            ['limactl', 'shell', 'test3', 'sudo', '/opt/tunkki/tunkki'],
            [
                'sh',
                '-c',
                `limactl shell test3 sudo sh -c 'mkdir -p $(dirname "$0") && tee "$0" >/dev/null && chmod +x "$0"' "$REMOTE_PATH" < "$LOCAL_PATH"`,
            ],
        ),
    },
]);
