import { afterAll, expect, test } from 'bun:test';
import { on, podman, systemd } from '../..';
import {
    applyOnce,
    destroyStack,
    type TestVm,
    uniqueStack,
    vmFileExists,
    vmHost,
    vmsReady,
    waitForServiceState,
} from './helpers';

const VM: TestVm = 'test1';
const ready = await vmsReady();
if (!ready) {
    console.warn(
        '[recreate] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

const stack = uniqueStack('e2e-recreate');
const name = `tunkki-test-${stack}`;
const servicePath = `/etc/systemd/system/${name}.service`;
const containerPath = `/etc/containers/systemd/${name}.container`;
const id = `${VM}.foo`;

afterAll(async () => {
    if (!ready) return;
    try {
        await destroyStack(stack, [vmHost(VM)]);
    } catch {
        // ignore
    }
});

t(
    "changing a task's type recreates: old handler cleans up, new handler applies",
    async () => {
        // ---- Phase 1: task `foo` is a systemd.service ----
        const r1 = await applyOnce(stack, [vmHost(VM)], () => {
            on('*', () => {
                systemd.service('foo', {
                    name,
                    type: 'simple',
                    exec: ['/usr/bin/sleep', '86400'],
                });
            });
        });
        expect(r1.results[0]!.errored).toEqual([]);
        expect(r1.results[0]!.completed).toContain(id);
        expect(await vmFileExists(VM, servicePath)).toBe(true);
        expect(await vmFileExists(VM, containerPath)).toBe(false);
        await waitForServiceState(VM, `${name}.service`, 'active');

        // ---- Phase 2: same id, different type ----
        // The remote runner detects the handler change and runs the OLD handler's
        // cleanup before applying with the new handler (see remote/runner.ts:291).
        const r2 = await applyOnce(stack, [vmHost(VM)], () => {
            on('*', () => {
                podman.container('foo', {
                    name,
                    image: 'docker.io/library/nginx:latest', // pre-cached on the VM
                });
            });
        });
        expect(r2.results[0]!.errored).toEqual([]);
        expect(r2.results[0]!.completed).toContain(id);

        // Old systemd .service unit file is gone — cleanup ran.
        expect(await vmFileExists(VM, servicePath)).toBe(false);
        // New Quadlet .container unit file is present.
        expect(await vmFileExists(VM, containerPath)).toBe(true);
        // The container's generated systemd service must be active.
        await waitForServiceState(VM, `${name}.service`, 'active', 30_000);
    },
    180_000,
);
