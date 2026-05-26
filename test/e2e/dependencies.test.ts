import { afterAll, expect, test } from 'bun:test';
import { on, systemd } from '../..';
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
} from './helpers';

const VM: TestVm = 'test1';
const ready = await vmsReady();
if (!ready) {
    console.warn(
        '[dependencies] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

const stackOk = uniqueStack('e2e-dep-ok');
const stackFail = uniqueStack('e2e-dep-fail');
const unitOkA = `tunkki-test-${stackOk}-a`;
const unitOkB = `tunkki-test-${stackOk}-b`;
const unitFailA = `tunkki-test-${stackFail}-a`;
const unitFailB = `tunkki-test-${stackFail}-b`;
const orderLog = `/tmp/${stackOk}.order`;
const markerFailB = `/tmp/${unitFailB}.mark`;

afterAll(async () => {
    if (!ready) return;
    for (const s of [stackOk, stackFail]) {
        try {
            await destroyStack(s, [vmHost(VM)]);
        } catch {
            // ignore
        }
    }
    await vmExec(VM, `rm -f ${orderLog} ${markerFailB}`);
});

t(
    'A depends on B → B completes before A',
    async () => {
        // Each task appends its id to a shared log, so the resulting log content
        // ("BA") directly encodes execution order. (Avoid time-based markers via
        // `%s%N` — systemd would expand the % specifiers before the shell sees
        // them, e.g. `%s` becomes the user's shell and `%N` becomes the unit name.)
        //
        // oneshot+RemainAfterExit ensures `systemctl restart` (called from the
        // apply step) blocks until ExecStart has finished, so the log is
        // guaranteed flushed by the time the task is reported done.
        await vmExec(VM, `rm -f ${orderLog}`);

        const r = await applyOnce(stackOk, [vmHost(VM)], () => {
            on('*', () => {
                const b = systemd.service('b', {
                    name: unitOkB,
                    type: 'oneshot',
                    remainAfterExit: true,
                    exec: ['/bin/sh', '-c', `printf B >> ${orderLog}`],
                });
                systemd.service(
                    'a',
                    {
                        name: unitOkA,
                        type: 'oneshot',
                        remainAfterExit: true,
                        exec: ['/bin/sh', '-c', `printf A >> ${orderLog}`],
                    },
                    { after: [b.id] },
                );
            });
        });

        expect(r.results[0]!.errored).toEqual([]);
        expect(r.results[0]!.completed).toEqual(
            expect.arrayContaining([`${VM}.a`, `${VM}.b`]),
        );

        const log = await vmRead(VM, orderLog);
        expect(log).toBe('BA');
    },
    60_000,
);

t(
    'failed dependency causes the dependent to be skipped (its handler never runs)',
    async () => {
        const r = await applyOnce(stackFail, [vmHost(VM)], () => {
            on('*', () => {
                const a = systemd.service('a', {
                    name: unitFailA,
                    type: 'oneshot',
                    // /bin/false fails -> systemctl restart fails -> apply throws ->
                    // the task is marked errored.
                    exec: '/bin/false',
                });
                systemd.service(
                    'b',
                    {
                        name: unitFailB,
                        type: 'oneshot',
                        remainAfterExit: true,
                        exec: ['/bin/sh', '-c', `date +%s%N > ${markerFailB}`],
                    },
                    { after: [a.id] },
                );
            });
        });

        expect(r.results[0]!.errored.map((e) => e.taskId)).toContain(`${VM}.a`);
        expect(r.results[0]!.skipped).toContain(`${VM}.b`);
        // B's ExecStart never ran -> no marker.
        expect(await vmFileExists(VM, markerFailB)).toBe(false);
    },
    60_000,
);
