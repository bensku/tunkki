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
        '[service] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

const stack = uniqueStack('e2e-svc');
const unit = `tunkki-test-${stack}`;
const markerFile = `/tmp/${unit}.env`;

afterAll(async () => {
    if (!ready) return;
    try {
        await destroyStack(stack, [vmHost(VM)]);
    } catch {
        // ignore
    }
});

t(
    'service with [Install], Environment=, and Restart= reaches the running process',
    async () => {
        const env = { TUNKKI_TEST_KEY: 'hello-from-tunkki', LANG: 'C.UTF-8' };

        const r = await applyOnce(stack, [vmHost(VM)], () => {
            systemd.service('svc', {
                name: unit,
                type: 'simple',
                // Dump env to a file so we can inspect it from the host, then
                // sleep so the unit stays active.
                exec: [
                    '/bin/sh',
                    '-c',
                    `printenv | sort > ${markerFile}; exec /usr/bin/sleep 86400`,
                ],
                environment: env,
                restart: 'always',
                install: { wantedBy: 'multi-user.target' },
            });
        });

        expect(r.results[0]!.errored).toEqual([]);
        expect(r.results[0]!.completed).toContain('svc');

        // Service must be active before printenv has had a chance to run.
        await waitForServiceState(VM, `${unit}.service`, 'active');
        // Give the shell a moment to flush the marker file.
        await Bun.sleep(150);

        // [Install] WantedBy was honoured -> systemctl reenable created the symlink.
        expect(
            await vmFileExists(
                VM,
                `/etc/systemd/system/multi-user.target.wants/${unit}.service`,
            ),
        ).toBe(true);

        // Environment= reached the process.
        const dumped = await vmRead(VM, markerFile);
        for (const [k, v] of Object.entries(env)) {
            expect(dumped).toContain(`${k}=${v}`);
        }

        // Restart= directive is in the unit file (functional restart-after-kill
        // is intentionally not tested here — it'd race with systemd's start-rate
        // limiter and the test runner's timeout).
        const unitContent = await vmRead(
            VM,
            `/etc/systemd/system/${unit}.service`,
        );
        expect(unitContent).toContain('Restart=always');
        expect(unitContent).toContain('WantedBy=multi-user.target');

        // Clean up the marker file ourselves; the cleanup handler doesn't know
        // about it, and afterAll only stops the service.
        await vmExec(VM, `rm -f ${markerFile}`);
    },
    60_000,
);
