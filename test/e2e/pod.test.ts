import { afterAll, expect, test } from 'bun:test';
import { on, podman } from '../..';
import {
    applyOnce,
    destroyStack,
    type TestVm,
    uniqueStack,
    vmExec,
    vmFileExists,
    vmHost,
    vmsReady,
    waitForServiceState,
} from './helpers';

const VM: TestVm = 'test1';
const ready = await vmsReady();
if (!ready) {
    console.warn(
        '[pod] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

const stack = uniqueStack('e2e-pod');
const podName = `tunkki-test-${stack}`;
// When `state.pod` is set on a container, its Quadlet file is named
// `<pod>-<name>.container` (see task/podman/container.ts apply step), so the
// systemd service ends up as `<pod>-<name>.service`. Because we pass the
// `.pod` suffix in `state.pod`, the literal substitution leaves a dot in the
// composed name, which Quadlet/systemd treat as a regular character.

afterAll(async () => {
    if (!ready) return;
    try {
        await destroyStack(stack, [vmHost(VM)]);
    } catch {
        // ignore
    }
});

t(
    'podman.pod + podman.container apply, run, and depend in order',
    async () => {
        const r = await applyOnce(stack, [vmHost(VM)], () => {
            on('*', () => {
                const pod = podman.pod('pod', { name: podName });
                podman.container(
                    'app',
                    {
                        name: 'app',
                        image: 'docker.io/library/nginx:latest', // pre-cached on the VM
                        pod: `${podName}.pod`,
                    },
                    { after: [pod.id] },
                );
            });
        });

        expect(r.results[0]!.errored).toEqual([]);
        expect(r.results[0]!.completed).toEqual(
            expect.arrayContaining([`${VM}.pod`, `${VM}.app`]),
        );

        expect(
            await vmFileExists(VM, `/etc/containers/systemd/${podName}.pod`),
        ).toBe(true);
        expect(
            await vmFileExists(
                VM,
                `/etc/containers/systemd/${podName}.pod-app.container`,
            ),
        ).toBe(true);

        await waitForServiceState(
            VM,
            `${podName}-pod.service`,
            'active',
            15_000,
        );
        await waitForServiceState(
            VM,
            `${podName}.pod-app.service`,
            'active',
            30_000,
        );

        const pods = await vmExec(VM, 'podman pod ps --format "{{.Name}}"');
        expect(pods.stdout).toContain(podName);
    },
    120_000,
);
