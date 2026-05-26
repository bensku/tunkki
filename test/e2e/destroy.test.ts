import { afterAll, expect, test } from 'bun:test';
import { files, on } from '../..';
import {
    applyOnce,
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
        '[destroy] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

const stack = uniqueStack('e2e-destroy');
const A_PATH = `/tmp/tunkki-${stack}-a.txt`;
const B_PATH = `/tmp/tunkki-${stack}-b.txt`;
const C_PATH = `/tmp/tunkki-${stack}-c.txt`;

afterAll(async () => {
    if (!ready) return;
    try {
        await destroyStack(stack, [vmHost(VM)]);
    } catch {
        // ignore
    }
});

t(
    'destroy with the same tasks still defined cleans up exactly once (no duplicate runs)',
    async () => {
        // Same `define` is reused for both apply and destroy. The bug this
        // regression-tests: in destroy mode, this.#tasks is still populated
        // by the on() block, AND plan.deleted reports every one of those
        // ids — so every task ended up queued twice, the first run cleaned
        // up successfully and the second errored with ENOENT.
        const define = () => {
            on('*', () => {
                files.put('a', { content: 'a\n', remotePath: A_PATH });
                files.put('b', { content: 'b\n', remotePath: B_PATH });
                files.put('c', { content: 'c\n', remotePath: C_PATH });
            });
        };

        // Apply: create three files.
        const r1 = await applyOnce(stack, [vmHost(VM)], define);
        expect(r1.results[0]!.errored).toEqual([]);
        expect(r1.results[0]!.completed).toEqual(
            expect.arrayContaining([`${VM}.a`, `${VM}.b`, `${VM}.c`]),
        );
        for (const p of [A_PATH, B_PATH, C_PATH]) {
            expect(await vmFileExists(VM, p)).toBe(true);
        }

        // Destroy with the same `define` still active.
        const r2 = await applyOnce(stack, [vmHost(VM)], define, 'destroy');

        // No errors. Each task id appears at most once in completed (no
        // duplicate runs).
        expect(r2.results[0]!.errored).toEqual([]);
        const counts = new Map<string, number>();
        for (const id of r2.results[0]!.completed) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        for (const [id, n] of counts) {
            expect(n).toBe(1);
        }
        // The user's tasks were cleaned up.
        for (const id of [`${VM}.a`, `${VM}.b`, `${VM}.c`]) {
            expect(counts.get(id)).toBe(1);
        }

        // Remote files were actually removed.
        for (const p of [A_PATH, B_PATH, C_PATH]) {
            expect(await vmFileExists(VM, p)).toBe(false);
        }
    },
    90_000,
);
