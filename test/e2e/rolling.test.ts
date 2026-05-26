import { afterAll, expect, test } from 'bun:test';
import { on, systemd } from '../..';
import {
    applyOnce,
    destroyStack,
    TEST_VMS,
    type TestVm,
    uniqueStack,
    vmExec,
    vmFileExists,
    vmHost,
    vmsReady,
} from './helpers';

const ready = await vmsReady();
if (!ready) {
    console.warn(
        '[rolling] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

const stackOk = uniqueStack('e2e-roll-ok');
const stackFail = uniqueStack('e2e-roll-fail');
const stackPar = uniqueStack('e2e-roll-par');
const unitOk = `tunkki-test-${stackOk}`;
const unitFail = `tunkki-test-${stackFail}`;
const unitPar = `tunkki-test-${stackPar}`;
const markerOk = `/tmp/${unitOk}.mark`;
const markerFail = `/tmp/${unitFail}.mark`;
const markerPar = `/tmp/${unitPar}.mark`;

afterAll(async () => {
    if (!ready) return;
    const hosts = TEST_VMS.map(vmHost);
    for (const s of [stackOk, stackFail, stackPar]) {
        try {
            await destroyStack(s, hosts);
        } catch {
            // ignore
        }
    }
    await Promise.all(
        TEST_VMS.map((vm) =>
            vmExec(vm, `rm -f ${markerOk} ${markerFail} ${markerPar}`),
        ),
    );
});

async function readMtime(vm: TestVm, path: string): Promise<number> {
    const r = await vmExec(vm, `stat -c %Y "${path}"`);
    if (r.exitCode !== 0)
        throw new Error(`mtime ${vm}:${path} failed: ${r.stderr}`);
    return Number.parseInt(r.stdout.trim(), 10);
}

t(
    'a rolling task executes host-by-host (test1 → test2 → test3)',
    async () => {
        const hosts = TEST_VMS.map(vmHost);
        // Pre-clean any leftover marker.
        await Promise.all(
            TEST_VMS.map((vm) => vmExec(vm, `rm -f ${markerOk}`)),
        );

        // sleep 1 + touch: each host's task takes ≥1s. With rolling=true (the
        // third arg of on()), the runner waits for host N to finish before
        // starting host N+1, so the touch mtimes will be at least 1s apart in
        // TEST_VMS order. (Without rolling, all 3 would touch within the same
        // second.)
        const r = await applyOnce(stackOk, hosts, () => {
            on(
                '*',
                () => {
                    systemd.service('roll', {
                        name: unitOk,
                        type: 'oneshot',
                        remainAfterExit: true,
                        exec: ['/bin/sh', '-c', `sleep 1 && touch ${markerOk}`],
                    });
                },
                true,
            );
        });

        for (const result of r.results) {
            expect(result.errored).toEqual([]);
            expect(result.completed).toContain(`${result.host}.roll`);
        }

        const mtimes = await Promise.all(
            TEST_VMS.map((vm) => readMtime(vm, markerOk)),
        );
        // Strict <: each host must touch at least 1 wall-clock second after the
        // previous one (since each task sleeps for 1s before touching). If any
        // pair is equal, rolling didn't roll.
        for (let i = 1; i < mtimes.length; i++) {
            expect(mtimes[i]! > mtimes[i - 1]!).toBe(true);
        }
    },
    120_000,
);

t(
    'a failing rolling task halts the roll (subsequent hosts never run)',
    async () => {
        const hosts = TEST_VMS.map(vmHost);
        await Promise.all(
            TEST_VMS.map((vm) => vmExec(vm, `rm -f ${markerFail}`)),
        );

        const r = await applyOnce(stackFail, hosts, () => {
            on(
                '*',
                () => {
                    systemd.service('roll', {
                        name: unitFail,
                        type: 'oneshot',
                        // /bin/false makes the unit fail to start, so the apply step
                        // throws -> the task errors on test1 -> rolling stops.
                        exec: '/bin/false',
                    });
                },
                true,
            );
        });

        // test1 should have errored; test2 and test3 should not have completed.
        const byHost = new Map(r.results.map((res) => [res.host, res]));
        expect(byHost.get('test1')!.errored.map((e) => e.taskId)).toContain(
            'test1.roll',
        );
        expect(byHost.get('test2')!.completed).not.toContain('test2.roll');
        expect(byHost.get('test3')!.completed).not.toContain('test3.roll');

        expect(await vmFileExists('test2', markerFail)).toBe(false);
        expect(await vmFileExists('test3', markerFail)).toBe(false);
    },
    120_000,
);

t(
    'rolling=false runs hosts in parallel',
    async () => {
        const hosts = TEST_VMS.map(vmHost);
        await Promise.all(
            TEST_VMS.map((vm) => vmExec(vm, `rm -f ${markerPar}`)),
        );

        // With rolling=false (the third arg of on()), all three hosts should
        // run the task concurrently. Each task sleeps 2s then touches; with
        // rolling=true the mtimes would span ≥4s end-to-end (3 × 2s + setup),
        // with rolling=false they should land within ~1s of each other.
        const r = await applyOnce(stackPar, hosts, () => {
            on(
                '*',
                () => {
                    systemd.service('roll', {
                        name: unitPar,
                        type: 'oneshot',
                        remainAfterExit: true,
                        exec: [
                            '/bin/sh',
                            '-c',
                            `sleep 2 && touch ${markerPar}`,
                        ],
                    });
                },
                false,
            );
        });

        for (const result of r.results) {
            expect(result.errored).toEqual([]);
            expect(result.completed).toContain(`${result.host}.roll`);
        }

        const mtimes = await Promise.all(
            TEST_VMS.map((vm) => readMtime(vm, markerPar)),
        );
        const spread = Math.max(...mtimes) - Math.min(...mtimes);
        // Rolling would put each touch ≥2s after the previous (so spread ≥4s
        // for 3 hosts). Parallel execution should land all three within ~1s.
        // Allow 1s slack for VM scheduling jitter.
        expect(spread).toBeLessThanOrEqual(1);
    },
    120_000,
);
