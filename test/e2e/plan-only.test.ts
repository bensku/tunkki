import { afterAll, expect, test } from 'bun:test';
import { connect, on, systemd } from '../..';
import {
    clearTasks,
    destroyStack,
    type TestVm,
    uniqueStack,
    vmFileExists,
    vmHost,
    vmsReady,
} from './helpers';

const VM: TestVm = 'test1';
const ready = await vmsReady();
if (!ready) {
    console.warn(
        '[plan-only] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

const stack = uniqueStack('e2e-plan');
const unit = `tunkki-test-${stack}`;
const statePath = `/opt/tunkki/${stack}/state/current.json`;
const id = `${VM}.only`;

afterAll(async () => {
    if (!ready) return;
    try {
        await destroyStack(stack, [vmHost(VM)]);
    } catch {
        // ignore
    }
});

t(
    'plan() is read-only: re-planning produces the same diff and writes no state',
    async () => {
        // Sources are registered with on() each round; clearTasks() in between
        // resets both the loaded tasks and the source list so we get a clean
        // re-load without double-registering.
        const register = () => {
            on('*', () => {
                systemd.service('only', {
                    name: unit,
                    type: 'simple',
                    exec: ['/usr/bin/sleep', '86400'],
                });
            });
        };

        // ---- Round 1 ----
        clearTasks();
        register();
        const pool1 = await connect([vmHost(VM)]);
        try {
            const plan1 = await pool1.plan(stack);
            expect(plan1[0]!.created).toContain(id);
            expect(plan1[0]!.unchanged).toEqual([]);
            expect(plan1[0]!.updated).toEqual([]);
            expect(plan1[0]!.deleted).toEqual([]);
            // Deliberately NOT calling pool1.execute().
        } finally {
            await pool1.close();
        }

        // ---- Round 2: identical input, fresh pool ----
        clearTasks();
        register();
        const pool2 = await connect([vmHost(VM)]);
        try {
            const plan2 = await pool2.plan(stack);
            // Plan is identical: the task is still "created" (i.e. doesn't
            // exist on the remote yet) because the first plan didn't change
            // any persisted state.
            expect(plan2[0]!.created).toContain(id);
            expect(plan2[0]!.unchanged).toEqual([]);
        } finally {
            await pool2.close();
        }

        // The state file would only be written by the runner's apply path,
        // which `execute()` triggers. After two plan-only rounds it must not
        // exist.
        expect(await vmFileExists(VM, statePath)).toBe(false);

        clearTasks();
    },
    60_000,
);
