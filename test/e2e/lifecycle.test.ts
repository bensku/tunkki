import { afterAll, expect, test } from 'bun:test';
import { systemd } from '../..';
import {
    applyOnce,
    destroyStack,
    type TestVm,
    uniqueStack,
    vmExec,
    vmFileExists,
    vmHost,
    vmRead,
    vmsReady,
    waitForServiceState,
} from './helpers';

const VM: TestVm = 'test1';
const ready = await vmsReady();
if (!ready) {
    console.warn(
        '[lifecycle] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

const stack = uniqueStack('e2e-lc');
// Globally unique on the VM — systemd unit paths aren't scoped per stack.
const unit = `tunkki-test-${stack}`;
const unitPath = `/etc/systemd/system/${unit}.service`;
const statePath = `/opt/tunkki/${stack}/state/current.json`;

afterAll(async () => {
    if (!ready) return;
    // Best-effort cleanup so a failing test doesn't leave a runaway sleep.
    try {
        await destroyStack(stack, [vmHost(VM)]);
    } catch {
        // ignore
    }
});

async function activeEnterTimestamp(): Promise<string> {
    const r = await vmExec(
        VM,
        `systemctl show -p ActiveEnterTimestampMonotonic --value ${unit}`,
    );
    return r.stdout.trim();
}

t(
    'create → unchanged → update → delete',
    async () => {
        // ----------------------------------------------------------------------
        // CREATE
        // ----------------------------------------------------------------------
        const create = await applyOnce(stack, [vmHost(VM)], () => {
            systemd.service('lc', {
                name: unit,
                type: 'simple',
                exec: ['/usr/bin/sleep', '86400'],
            });
        });
        expect(create.plans).toHaveLength(1);
        expect(create.plans[0]!.created).toContain('lc');
        expect(create.plans[0]!.unchanged).toEqual([]);
        expect(create.results).toHaveLength(1);
        expect(create.results[0]!.completed).toContain('lc');
        expect(create.results[0]!.errored).toEqual([]);

        expect(await vmFileExists(VM, unitPath)).toBe(true);
        await waitForServiceState(VM, `${unit}.service`, 'active');

        const state1 = JSON.parse(await vmRead(VM, statePath));
        expect(state1).toHaveProperty('lc');
        expect(state1.lc.handler).toBe('systemd.service');
        expect(state1.lc.state.exec).toEqual(['/usr/bin/sleep', '86400']);

        const tsAfterCreate = await activeEnterTimestamp();
        expect(tsAfterCreate).not.toBe('0');

        // ----------------------------------------------------------------------
        // UNCHANGED — same input, no diff
        // ----------------------------------------------------------------------
        const unchanged = await applyOnce(stack, [vmHost(VM)], () => {
            systemd.service('lc', {
                name: unit,
                type: 'simple',
                exec: ['/usr/bin/sleep', '86400'],
            });
        });
        expect(unchanged.plans[0]!.unchanged).toContain('lc');
        expect(unchanged.plans[0]!.created).toEqual([]);
        expect(unchanged.plans[0]!.updated).toEqual([]);
        expect(unchanged.plans[0]!.deleted).toEqual([]);
        // Nothing was applied: no completion event, no restart.
        expect(unchanged.results[0]!.completed).toEqual([]);
        expect(await activeEnterTimestamp()).toBe(tsAfterCreate);

        // ----------------------------------------------------------------------
        // UPDATE — change a field, expect plan diff + service restart
        // ----------------------------------------------------------------------
        const update = await applyOnce(stack, [vmHost(VM)], () => {
            systemd.service('lc', {
                name: unit,
                type: 'simple',
                exec: ['/usr/bin/sleep', '99999'], // changed
            });
        });
        expect(update.plans[0]!.updated.map((u) => u.id)).toContain('lc');
        expect(update.plans[0]!.updated[0]!.oldState).toMatchObject({
            exec: ['/usr/bin/sleep', '86400'],
        });
        expect(update.results[0]!.completed).toContain('lc');

        const newUnit = await vmRead(VM, unitPath);
        expect(newUnit).toContain('ExecStart=/usr/bin/sleep 99999');
        expect(newUnit).not.toContain('ExecStart=/usr/bin/sleep 86400');

        await waitForServiceState(VM, `${unit}.service`, 'active');
        expect(await activeEnterTimestamp()).not.toBe(tsAfterCreate);

        const state2 = JSON.parse(await vmRead(VM, statePath));
        expect(state2.lc.state.exec).toEqual(['/usr/bin/sleep', '99999']);

        // ----------------------------------------------------------------------
        // DELETE — apply with no tasks; remote infers deletion
        // ----------------------------------------------------------------------
        const del = await applyOnce(stack, [vmHost(VM)], () => {
            // intentionally empty
        });
        expect(del.plans[0]!.deleted.map((d) => d.id)).toContain('lc');
        expect(del.plans[0]!.deleted[0]!.oldState).toMatchObject({
            exec: ['/usr/bin/sleep', '99999'],
        });
        expect(del.results[0]!.completed).toContain('lc');

        expect(await vmFileExists(VM, unitPath)).toBe(false);
        await waitForServiceState(VM, `${unit}.service`, 'inactive');

        const state3 = JSON.parse(await vmRead(VM, statePath));
        expect(state3).not.toHaveProperty('lc');
    },
    60_000,
);
