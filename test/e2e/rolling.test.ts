import { afterAll, expect, test } from 'bun:test';
import { systemd } from '../..';
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
const unitOk = `tunkki-test-${stackOk}`;
const unitFail = `tunkki-test-${stackFail}`;
const markerOk = `/tmp/${unitOk}.mark`;
const markerFail = `/tmp/${unitFail}.mark`;

afterAll(async () => {
    if (!ready) return;
    const hosts = TEST_VMS.map(vmHost);
    for (const s of [stackOk, stackFail]) {
        try {
            await destroyStack(s, hosts);
        } catch {
            // ignore
        }
    }
    await Promise.all(
        TEST_VMS.map((vm) => vmExec(vm, `rm -f ${markerOk} ${markerFail}`)),
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

        // sleep 1 + touch: each host's task takes ≥1s. With rolling=true, the
        // runner waits for host N to finish before starting host N+1, so the
        // touch mtimes will be at least 1s apart in TEST_VMS order. (Without
        // rolling, all 3 would touch within the same second.)
        const r = await applyOnce(stackOk, hosts, () => {
            systemd.service(
                'roll',
                {
                    name: unitOk,
                    type: 'oneshot',
                    remainAfterExit: true,
                    exec: ['/bin/sh', '-c', `sleep 1 && touch ${markerOk}`],
                },
                { rolling: true },
            );
        });

        for (const result of r.results) {
            expect(result.errored).toEqual([]);
            expect(result.completed).toContain('roll');
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
            systemd.service(
                'roll',
                {
                    name: unitFail,
                    type: 'oneshot',
                    // /bin/false makes the unit fail to start, so the apply step
                    // throws -> the task errors on test1 -> rolling stops.
                    exec: '/bin/false',
                },
                { rolling: true },
            );
        });

        // test1 should have errored; test2 and test3 should not have completed.
        const byHost = new Map(r.results.map((res) => [res.host, res]));
        expect(byHost.get('test1')!.errored.map((e) => e.taskId)).toContain(
            'roll',
        );
        expect(byHost.get('test2')!.completed).not.toContain('roll');
        expect(byHost.get('test3')!.completed).not.toContain('roll');

        expect(await vmFileExists('test2', markerFail)).toBe(false);
        expect(await vmFileExists('test3', markerFail)).toBe(false);
    },
    120_000,
);
