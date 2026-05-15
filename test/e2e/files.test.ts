import { afterAll, expect, test } from 'bun:test';
import { files } from '../..';
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
        '[files] Lima VMs not ready — skipping. Run test/test-vms.sh first.',
    );
}
const t = test.skipIf(!ready);

const stack = uniqueStack('e2e-files');

// Distinct remote paths so per-test cleanup can't collide.
const LIFECYCLE_PATH = `/tmp/tunkki-${stack}-lifecycle.txt`;
const LIFECYCLE_PATH_MOVED = `/tmp/tunkki-${stack}-lifecycle-moved.txt`;
const CONTENT_PATH = `/tmp/tunkki-${stack}-content.txt`;
const MODE_PATH = `/tmp/tunkki-${stack}-mode.sh`;
const NESTED_PATH = `/tmp/tunkki-${stack}-nested/sub/dir/created.txt`;
const BINARY_PATH = `/tmp/tunkki-${stack}-binary.bin`;
const OWNED_PATH = `/tmp/tunkki-${stack}-owned.txt`;

// Single local fixture path that gets rewritten in place across phases — lets
// us verify checksum-based detection isolates from localPath string comparison.
const LOCAL_SRC = `/tmp/tunkki-test-src-${stack}.txt`;
if (ready) {
    await Bun.write(LOCAL_SRC, 'hello v1\n');
}

afterAll(async () => {
    if (!ready) return;
    try {
        await destroyStack(stack, [vmHost(VM)]);
    } catch {
        // ignore
    }
    await Bun.file(LOCAL_SRC)
        .delete()
        .catch(() => {});
});

t(
    'create → unchanged → update content → update path → delete',
    async () => {
        // ----------------------------------------------------------------------
        // CREATE
        // ----------------------------------------------------------------------
        const create = await applyOnce(stack, [vmHost(VM)], () => {
            files.put('lc', {
                localPath: LOCAL_SRC,
                remotePath: LIFECYCLE_PATH,
            });
        });
        expect(create.plans).toHaveLength(1);
        expect(create.plans[0]!.created).toContain('lc');
        expect(create.plans[0]!.unchanged).toEqual([]);
        expect(create.plans[0]!.updated).toEqual([]);
        expect(create.plans[0]!.deleted).toEqual([]);
        expect(create.results[0]!.completed).toContain('lc');
        expect(create.results[0]!.errored).toEqual([]);

        expect(await vmFileExists(VM, LIFECYCLE_PATH)).toBe(true);
        expect(await vmRead(VM, LIFECYCLE_PATH)).toBe('hello v1\n');

        // ----------------------------------------------------------------------
        // UNCHANGED — same input, same local bytes, no diff
        // ----------------------------------------------------------------------
        const unchanged = await applyOnce(stack, [vmHost(VM)], () => {
            files.put('lc', {
                localPath: LOCAL_SRC,
                remotePath: LIFECYCLE_PATH,
            });
        });
        expect(unchanged.plans[0]!.unchanged).toContain('lc');
        expect(unchanged.plans[0]!.created).toEqual([]);
        expect(unchanged.plans[0]!.updated).toEqual([]);
        expect(unchanged.plans[0]!.deleted).toEqual([]);
        expect(unchanged.results[0]!.completed).toEqual([]);

        // ----------------------------------------------------------------------
        // UPDATE content — rewrite LOCAL_SRC in place. Every input field is
        // byte-for-byte identical to the previous apply; only the bytes at the
        // referenced path differ. So the update must be driven by the SHA-256
        // checksum, not any input-string comparison.
        // ----------------------------------------------------------------------
        await Bun.write(LOCAL_SRC, 'hello v2 changed\n');

        const updateContent = await applyOnce(stack, [vmHost(VM)], () => {
            files.put('lc', {
                localPath: LOCAL_SRC,
                remotePath: LIFECYCLE_PATH,
            });
        });
        expect(updateContent.plans[0]!.updated.map((u) => u.id)).toContain(
            'lc',
        );
        expect(updateContent.results[0]!.completed).toContain('lc');
        expect(updateContent.results[0]!.errored).toEqual([]);
        expect(await vmRead(VM, LIFECYCLE_PATH)).toBe('hello v2 changed\n');

        // ----------------------------------------------------------------------
        // UPDATE path — content unchanged, remotePath changes. Exercises the
        // deleteOld branch in task/files/put.ts.
        // ----------------------------------------------------------------------
        const updatePath = await applyOnce(stack, [vmHost(VM)], () => {
            files.put('lc', {
                localPath: LOCAL_SRC,
                remotePath: LIFECYCLE_PATH_MOVED,
            });
        });
        expect(updatePath.plans[0]!.updated.map((u) => u.id)).toContain('lc');
        expect(updatePath.results[0]!.completed).toContain('lc');
        expect(updatePath.results[0]!.errored).toEqual([]);

        expect(await vmFileExists(VM, LIFECYCLE_PATH)).toBe(false);
        expect(await vmFileExists(VM, LIFECYCLE_PATH_MOVED)).toBe(true);
        expect(await vmRead(VM, LIFECYCLE_PATH_MOVED)).toBe(
            'hello v2 changed\n',
        );

        // ----------------------------------------------------------------------
        // DELETE — apply with no tasks; cleanup removes the remote file.
        // ----------------------------------------------------------------------
        const del = await applyOnce(stack, [vmHost(VM)], () => {
            // intentionally empty
        });
        expect(del.plans[0]!.deleted.map((d) => d.id)).toContain('lc');
        expect(del.results[0]!.completed).toContain('lc');
        expect(del.results[0]!.errored).toEqual([]);
        expect(await vmFileExists(VM, LIFECYCLE_PATH_MOVED)).toBe(false);
    },
    60_000,
);

t(
    'writes literal string content',
    async () => {
        const body = 'literal contents here\n';
        const r = await applyOnce(stack, [vmHost(VM)], () => {
            files.put('content', { content: body, remotePath: CONTENT_PATH });
        });
        expect(r.plans[0]!.created).toContain('content');
        expect(r.results[0]!.completed).toContain('content');
        expect(r.results[0]!.errored).toEqual([]);
        expect(await vmRead(VM, CONTENT_PATH)).toBe(body);
    },
    60_000,
);

t(
    'honors explicit mode despite umask',
    async () => {
        const body = '#!/bin/sh\necho hi\n';
        const r = await applyOnce(stack, [vmHost(VM)], () => {
            files.put('mode', {
                content: body,
                remotePath: MODE_PATH,
                mode: 0o755,
            });
        });
        expect(r.results[0]!.completed).toContain('mode');
        expect(r.results[0]!.errored).toEqual([]);

        const stat = await vmExec(VM, `stat -c %a ${MODE_PATH}`);
        expect(stat.exitCode).toBe(0);
        expect(stat.stdout.trim()).toBe('755');
        expect(await vmRead(VM, MODE_PATH)).toBe(body);
    },
    60_000,
);

t(
    'creates missing parent directories',
    async () => {
        const r = await applyOnce(stack, [vmHost(VM)], () => {
            files.put('nested', {
                content: 'deep',
                remotePath: NESTED_PATH,
            });
        });
        expect(r.results[0]!.completed).toContain('nested');
        expect(r.results[0]!.errored).toEqual([]);
        expect(await vmFileExists(VM, NESTED_PATH)).toBe(true);
        expect(await vmRead(VM, NESTED_PATH)).toBe('deep');
    },
    60_000,
);

t(
    'preserves binary content (Uint8Array)',
    async () => {
        const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80]);
        const r = await applyOnce(stack, [vmHost(VM)], () => {
            files.put('binary', {
                content: bytes,
                remotePath: BINARY_PATH,
            });
        });
        expect(r.results[0]!.completed).toContain('binary');
        expect(r.results[0]!.errored).toEqual([]);

        const size = await vmExec(VM, `wc -c < ${BINARY_PATH}`);
        expect(size.exitCode).toBe(0);
        expect(size.stdout.trim()).toBe('6');

        const dump = await vmExec(VM, `od -An -tx1 ${BINARY_PATH}`);
        expect(dump.exitCode).toBe(0);
        expect(dump.stdout.replace(/\s+/g, ' ').trim()).toBe(
            '00 01 ff fe 7f 80',
        );
    },
    60_000,
);

t(
    'sets user and group ownership',
    async () => {
        const r = await applyOnce(stack, [vmHost(VM)], () => {
            files.put('owned', {
                content: 'owned\n',
                remotePath: OWNED_PATH,
                user: 'nobody',
                group: 'nobody',
            });
        });
        expect(r.results[0]!.completed).toContain('owned');
        expect(r.results[0]!.errored).toEqual([]);

        const owner = await vmExec(VM, `stat -c '%U %G' ${OWNED_PATH}`);
        expect(owner.exitCode).toBe(0);
        expect(owner.stdout.trim()).toBe('nobody nobody');
        expect(await vmRead(VM, OWNED_PATH)).toBe('owned\n');
    },
    60_000,
);
