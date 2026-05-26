import { deploy, files, on, podman } from '@bensku/tunkki';
import { TEST_HOSTS } from './host';

on(
    '*',
    () => {
        podman.container('test-nginx', {
            name: 'nginx',
            image: 'docker.io/nginx:latest',
            publishPort: [
                {
                    containerPort: 80,
                    hostPort: 80,
                },
            ],
        });

        files.put('test-upload', {
            localPath: 'index.ts',
            remotePath: '/var/test/index.ts',
            mode: 0o777,
        });
        files.put('test-write', {
            content: 'hello!',
            remotePath: '/var/test/hello.txt',
        });
    },
    true,
);

deploy('test', TEST_HOSTS);
