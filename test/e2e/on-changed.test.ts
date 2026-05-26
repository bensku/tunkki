import { afterAll, expect, test } from 'bun:test';
import { files, on } from '../..';
import {
    applyOnce,
    destroyStack,
    type TestVm,
    uniqueStack,
    vmExec,
    vmHost,
    vmsReady,
} from './helpers';

const VM: TestVm = 'test1';
const ready = await vmsReady();
if (!ready) {
    console.warn(
        '[on-changed] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

// Each test owns its own stack + transient local file(s). afterAll tears
// every stack down and removes the local files so a failing test can't leak
// state into the next run.
const stacks: string[] = [];
const localFiles: string[] = [];

function setupStack(prefix: string): string {
    const stack = uniqueStack(prefix);
    stacks.push(stack);
    return stack;
}

afterAll(async () => {
    if (!ready) return;
    for (const s of stacks) {
        try {
            await destroyStack(s, [vmHost(VM)]);
        } catch {
            // ignore
        }
    }
    for (const p of localFiles) {
        await Bun.file(p)
            .delete()
            .catch(() => {});
    }
});

/** Read remote file mtime as seconds-since-epoch (integer). */
async function mtime(path: string): Promise<number> {
    const r = await vmExec(VM, `stat -c %Y "${path}"`);
    if (r.exitCode !== 0)
        throw new Error(`stat ${path} failed: ${r.stderr.trim()}`);
    return Number.parseInt(r.stdout.trim(), 10);
}

t(
    'a task with onChanged is re-applied when its dependency changes',
    async () => {
        const stack = setupStack('e2e-onchg');
        const SRC_REMOTE = `/tmp/tunkki-${stack}-src.txt`;
        const DEP_REMOTE = `/tmp/tunkki-${stack}-dep.txt`;
        const SRC_LOCAL = `/tmp/tunkki-${stack}-src.local`;
        localFiles.push(SRC_LOCAL);
        const srcId = `${VM}.src`;
        const depId = `${VM}.dep`;

        // Local source file. Will be rewritten between rounds to drive change.
        await Bun.write(SRC_LOCAL, 'src v1\n');

        const register = () => {
            on('*', () => {
                const src = files.put('src', {
                    localPath: SRC_LOCAL,
                    remotePath: SRC_REMOTE,
                });
                // `dep` has fixed content but declares onChanged: [src.id].
                // Its own state never changes between rounds, so any
                // re-application is caused by the onChanged promotion in
                // runner.plan().
                files.put(
                    'dep',
                    {
                        content: 'dep fixed content\n',
                        remotePath: DEP_REMOTE,
                    },
                    { onChanged: [src.id] },
                );
            });
        };

        // ----- Round 1: create both -----
        const r1 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r1.results[0]!.errored).toEqual([]);
        expect(r1.plans[0]!.created).toEqual(
            expect.arrayContaining([srcId, depId]),
        );
        expect(r1.results[0]!.completed).toEqual(
            expect.arrayContaining([srcId, depId]),
        );
        const depMtimeR1 = await mtime(DEP_REMOTE);

        // Sleep a beat to ensure any mtime change between rounds is observable
        // against integer-second resolution.
        await Bun.sleep(1100);

        // ----- Round 2: identical inputs → both unchanged, dep not re-applied -----
        const r2 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r2.results[0]!.errored).toEqual([]);
        expect(r2.plans[0]!.unchanged).toEqual(
            expect.arrayContaining([srcId, depId]),
        );
        expect(r2.plans[0]!.updated).toEqual([]);
        // Neither was re-applied this round.
        expect(r2.results[0]!.completed).toEqual([]);
        expect(await mtime(DEP_REMOTE)).toBe(depMtimeR1);

        await Bun.sleep(1100);

        // ----- Round 3: change src content → dep must be re-applied via onChanged -----
        await Bun.write(SRC_LOCAL, 'src v2 changed\n');
        const r3 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r3.results[0]!.errored).toEqual([]);

        // src is genuinely updated (content checksum diff).
        expect(r3.plans[0]!.updated.map((u) => u.id)).toContain(srcId);
        // dep is promoted from unchanged → updated by runner.plan because
        // its onChanged dep moved.
        expect(r3.plans[0]!.updated.map((u) => u.id)).toContain(depId);
        expect(r3.plans[0]!.unchanged).not.toContain(depId);

        expect(r3.results[0]!.completed).toEqual(
            expect.arrayContaining([srcId, depId]),
        );
        // dep was actually re-written (mtime advanced).
        expect(await mtime(DEP_REMOTE)).toBeGreaterThan(depMtimeR1);
    },
    90_000,
);

t(
    'peers without onChanged are unaffected when a sibling is promoted',
    async () => {
        // Three tasks on one host:
        //   src — driver, content changes between rounds
        //   dep — onChanged=[src.id], fixed content
        //   ind — independent, fixed content, NO onChanged
        //
        // When src changes, the planner must promote `dep` from unchanged →
        // updated while leaving `ind` untouched. A correct implementation
        // removes only `dep` from plan.unchanged; a buggy one that calls
        // `splice(index)` without a deleteCount truncates plan.unchanged from
        // `dep` onwards, dropping `ind` out of the unchanged set. Symptoms of
        // the bug: either ind shows up in `updated`, ind's mtime advances, or
        // execute() hangs because the remote was never told to reapply ind.
        const stack = setupStack('e2e-onchg-sib');
        const SRC_REMOTE = `/tmp/tunkki-${stack}-src.txt`;
        const DEP_REMOTE = `/tmp/tunkki-${stack}-dep.txt`;
        const IND_REMOTE = `/tmp/tunkki-${stack}-ind.txt`;
        const SRC_LOCAL = `/tmp/tunkki-${stack}-src.local`;
        localFiles.push(SRC_LOCAL);
        const srcId = `${VM}.src`;
        const depId = `${VM}.dep`;
        const indId = `${VM}.ind`;

        await Bun.write(SRC_LOCAL, 'src v1\n');

        const register = () => {
            on('*', () => {
                const src = files.put('src', {
                    localPath: SRC_LOCAL,
                    remotePath: SRC_REMOTE,
                });
                files.put(
                    'dep',
                    {
                        content: 'dep fixed content\n',
                        remotePath: DEP_REMOTE,
                    },
                    { onChanged: [src.id] },
                );
                files.put('ind', {
                    content: 'ind fixed content\n',
                    remotePath: IND_REMOTE,
                });
            });
        };

        // ----- Round 1: create all three -----
        const r1 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r1.results[0]!.errored).toEqual([]);
        expect(r1.plans[0]!.created).toEqual(
            expect.arrayContaining([srcId, depId, indId]),
        );
        const indMtimeR1 = await mtime(IND_REMOTE);

        await Bun.sleep(1100);

        // ----- Round 2: change src only -----
        await Bun.write(SRC_LOCAL, 'src v2 changed\n');
        const r2 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r2.results[0]!.errored).toEqual([]);

        const updatedIds = r2.plans[0]!.updated.map((u) => u.id);
        // src genuinely changed; dep promoted via onChanged.
        expect(updatedIds).toContain(srcId);
        expect(updatedIds).toContain(depId);
        // ind has no onChanged ref to src, so it MUST remain unchanged.
        expect(updatedIds).not.toContain(indId);
        expect(r2.plans[0]!.unchanged).toContain(indId);
        // ind must not have been queued for execution.
        expect(r2.results[0]!.completed).not.toContain(indId);
        expect(r2.results[0]!.errored.map((e) => e.taskId)).not.toContain(
            indId,
        );
        // ind file on the VM must not have been re-written.
        expect(await mtime(IND_REMOTE)).toBe(indMtimeR1);
    },
    90_000,
);

t(
    'multiple onChanged refs: any single ref changing promotes the task',
    async () => {
        // dep has onChanged=[s1.id, s2.id]. We change s1 alone in round 2 and
        // s2 alone in round 3; dep must be re-applied in BOTH cases.
        const stack = setupStack('e2e-onchg-multi');
        const S1_REMOTE = `/tmp/tunkki-${stack}-s1.txt`;
        const S2_REMOTE = `/tmp/tunkki-${stack}-s2.txt`;
        const DEP_REMOTE = `/tmp/tunkki-${stack}-dep.txt`;
        const S1_LOCAL = `/tmp/tunkki-${stack}-s1.local`;
        const S2_LOCAL = `/tmp/tunkki-${stack}-s2.local`;
        localFiles.push(S1_LOCAL, S2_LOCAL);
        const s1Id = `${VM}.s1`;
        const s2Id = `${VM}.s2`;
        const depId = `${VM}.dep`;

        await Bun.write(S1_LOCAL, 's1 v1\n');
        await Bun.write(S2_LOCAL, 's2 v1\n');

        const register = () => {
            on('*', () => {
                const s1 = files.put('s1', {
                    localPath: S1_LOCAL,
                    remotePath: S1_REMOTE,
                });
                const s2 = files.put('s2', {
                    localPath: S2_LOCAL,
                    remotePath: S2_REMOTE,
                });
                files.put(
                    'dep',
                    {
                        content: 'dep fixed content\n',
                        remotePath: DEP_REMOTE,
                    },
                    { onChanged: [s1.id, s2.id] },
                );
            });
        };

        // ----- Round 1: create all three -----
        const r1 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r1.results[0]!.errored).toEqual([]);
        const depMtimeR1 = await mtime(DEP_REMOTE);

        await Bun.sleep(1100);

        // ----- Round 2: change ONLY s1 -----
        await Bun.write(S1_LOCAL, 's1 v2\n');
        const r2 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r2.results[0]!.errored).toEqual([]);
        const updatedR2 = r2.plans[0]!.updated.map((u) => u.id);
        expect(updatedR2).toContain(s1Id);
        expect(updatedR2).not.toContain(s2Id);
        expect(r2.plans[0]!.unchanged).toContain(s2Id);
        // Critical assertion: dep is promoted because one of its onChanged
        // refs (s1) moved, even though the other (s2) didn't.
        expect(updatedR2).toContain(depId);
        const depMtimeR2 = await mtime(DEP_REMOTE);
        expect(depMtimeR2).toBeGreaterThan(depMtimeR1);

        await Bun.sleep(1100);

        // ----- Round 3: change ONLY s2 -----
        await Bun.write(S2_LOCAL, 's2 v2\n');
        const r3 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r3.results[0]!.errored).toEqual([]);
        const updatedR3 = r3.plans[0]!.updated.map((u) => u.id);
        expect(updatedR3).not.toContain(s1Id);
        expect(r3.plans[0]!.unchanged).toContain(s1Id);
        expect(updatedR3).toContain(s2Id);
        expect(updatedR3).toContain(depId);
        expect(await mtime(DEP_REMOTE)).toBeGreaterThan(depMtimeR2);
    },
    120_000,
);

t(
    'transitive onChanged: A→B→C re-applies all when A changes',
    async () => {
        // C has onChanged=[B.id]; B has onChanged=[A.id]. The semantic "if
        // any listed task is changed, this task is also considered changed"
        // implies that when A changes, B is promoted, and because B is now
        // considered changed, C must also be promoted. The planner must
        // therefore propagate to a fixed point — a single pass that consults
        // an unchanged-snapshot frozen at entry would miss C.
        const stack = setupStack('e2e-onchg-trans');
        const A_REMOTE = `/tmp/tunkki-${stack}-A.txt`;
        const B_REMOTE = `/tmp/tunkki-${stack}-B.txt`;
        const C_REMOTE = `/tmp/tunkki-${stack}-C.txt`;
        const A_LOCAL = `/tmp/tunkki-${stack}-A.local`;
        localFiles.push(A_LOCAL);
        const aId = `${VM}.A`;
        const bId = `${VM}.B`;
        const cId = `${VM}.C`;

        await Bun.write(A_LOCAL, 'A v1\n');

        const register = () => {
            on('*', () => {
                const a = files.put('A', {
                    localPath: A_LOCAL,
                    remotePath: A_REMOTE,
                });
                const b = files.put(
                    'B',
                    {
                        content: 'B fixed content\n',
                        remotePath: B_REMOTE,
                    },
                    { onChanged: [a.id] },
                );
                files.put(
                    'C',
                    {
                        content: 'C fixed content\n',
                        remotePath: C_REMOTE,
                    },
                    { onChanged: [b.id] },
                );
            });
        };

        // ----- Round 1: create -----
        const r1 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r1.results[0]!.errored).toEqual([]);
        const bMtimeR1 = await mtime(B_REMOTE);
        const cMtimeR1 = await mtime(C_REMOTE);

        await Bun.sleep(1100);

        // ----- Round 2: change A → both B and C must be promoted -----
        await Bun.write(A_LOCAL, 'A v2\n');
        const r2 = await applyOnce(stack, [vmHost(VM)], register);
        expect(r2.results[0]!.errored).toEqual([]);

        const updated = r2.plans[0]!.updated.map((u) => u.id);
        expect(updated).toContain(aId);
        expect(updated).toContain(bId);
        // The transitive promotion — C only depends on B via onChanged.
        expect(updated).toContain(cId);

        expect(await mtime(B_REMOTE)).toBeGreaterThan(bMtimeR1);
        expect(await mtime(C_REMOTE)).toBeGreaterThan(cMtimeR1);
    },
    90_000,
);
