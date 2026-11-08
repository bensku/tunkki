import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { SHARED_MODULES } from '../../common/task';
import { bundleHandler } from '../../local/task';
// Registers handlers of in-tree task types
import '../..';

const ROOT = path.join(import.meta.dir, '../..');

async function codeOf(type: string): Promise<string> {
    const url = await bundleHandler(type);
    const base64 = url.slice(url.indexOf(',') + 1);
    return Buffer.from(base64, 'base64').toString();
}

describe('handler bundles', () => {
    test('import shared modules instead of bundling them', async () => {
        const code = await codeOf('podman.secretv2');
        expect(code).toContain('"@bensku/tunkki/task"');
        // From task/index.ts and local/task.ts
        expect(code).not.toContain('function taskType(');
        expect(code).not.toContain('function registerHandler(');
    });

    test('of all in-tree task types only import modules agent provides', async () => {
        const types = [
            'files.directory',
            'files.put',
            'nebula.endpoint',
            'nebula.network',
            'podman.container',
            'podman.network',
            'podman.pod',
            'podman.secret',
            'podman.secretv2',
            'systemd.service',
            'systemd.timer',
        ];
        for (const type of types) {
            const code = await codeOf(type);
            const imported = [
                ...code.matchAll(/from\s*"(@bensku\/tunkki[^"]*)"/g),
            ].map((match) => match[1]);
            for (const specifier of imported) {
                expect(SHARED_MODULES).toContain(specifier as string);
            }
        }
    });

    test('bundle task utils themselves', async () => {
        const code = await codeOf('podman.container');
        expect(code).not.toContain('"@bensku/tunkki/task/util"');
        expect(code).toContain('function renderPublishPort(');
    });
});

describe('agent', () => {
    test('does not include task types or utils', async () => {
        const result = await Bun.build({
            entrypoints: [path.join(ROOT, 'remote/index.ts')],
            target: 'bun',
            metafile: true,
        });
        expect(result.success).toBe(true);
        const inputs = Object.keys(result.metafile?.inputs ?? {});
        // Changing these must not require installing the agent again
        expect(inputs.filter((input) => input.startsWith('task/'))).toEqual([
            'task/index.ts',
        ]);
        expect(inputs).not.toContain('index.ts');
    });
});
