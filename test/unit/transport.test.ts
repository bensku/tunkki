import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { proxyCmd, ssh } from '../../protocol';

/**
 * Stands in for ssh: asks the user for presence like OpenSSH does with
 * security keys, warns about something and then runs the remote command
 * locally, with cat as the agent.
 */
const FAKE_SSH = `#!/bin/sh
for last; do :; done
SSH_ASKPASS_PROMPT=none "$SSH_ASKPASS" "Confirm user presence for key ED25519-SK SHA256:abc"
echo "Warning: Permanently added 'host' to the list of known hosts." >&2
exec sh -c "$(printf '%s' "$last" | sed 's#/opt/tunkki/tunkki#cat#')"
`;

let dir: string;
let oldPath: string | undefined;
beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-test-'));
    await fs.writeFile(path.join(dir, 'ssh'), FAKE_SSH, { mode: 0o755 });
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
});
afterAll(async () => {
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
});

async function readSome(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return new TextDecoder().decode(value);
}

describe('ssh connector', () => {
    test('reports prompts, messages and authentication', async () => {
        const prompts: string[] = [];
        const messages: string[] = [];
        const conn = await ssh('host').connect({
            onPrompt: (prompt) => prompts.push(prompt),
            onMessage: (message) => messages.push(message),
        });
        await conn.authenticated;
        expect(prompts).toEqual([
            'Confirm user presence for key ED25519-SK SHA256:abc',
        ]);

        // The marker is not passed on, but other output is
        conn.in.write('hello');
        conn.in.flush();
        expect(await readSome(conn.out)).toBe('hello');
        expect(messages).toEqual([
            "Warning: Permanently added 'host' to the list of known hosts.",
        ]);
        await conn.close();
    });
});

describe('proxyCmd', () => {
    test('fails authentication with what the command printed', async () => {
        const conn = await proxyCmd(
            ['sh', '-c', 'echo "Permission denied (publickey)." >&2; exit 255'],
            undefined,
            { authMarker: 'ok' },
        ).connect();
        await expect(conn.authenticated).rejects.toThrow(
            'Permission denied (publickey).',
        );
    });

    test('fails authentication with exit code when nothing was printed', async () => {
        const conn = await proxyCmd(['sh', '-c', 'exit 3'], undefined, {
            authMarker: 'ok',
        }).connect();
        await expect(conn.authenticated).rejects.toThrow(
            'sh exited with code 3',
        );
    });

    test('counts as authenticated without a marker', async () => {
        const conn = await proxyCmd(['cat']).connect();
        expect(conn.authenticated).toBeUndefined();
        await conn.close();
    });
});
