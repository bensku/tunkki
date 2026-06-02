import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { step } from '@bensku/tunkki/task';
import { $ } from 'bun';
import type { PutInput } from '.';

export type State = PutInput & {
    /**
     * Checksum of file, automatically computed.
     */
    checksum: string;
};

interface PutReq {
    data: Uint8Array;
    path: string;
    mode?: number;
    user?: string | number;
    group?: string | number;

    deleteOld?: string;
}

export const apply = [
    step<State, PutReq>('local', async (state, _, oldState) => {
        // If this executes, remote has noticed a difference in state, e.g. the checksum
        // Load data to memory if it isn't already there
        let data: Uint8Array;
        if (state.localPath) {
            data = await Bun.file(state.localPath).bytes();
        } else {
            if (typeof state.content === 'string') {
                data = Buffer.from(state.content, 'utf-8');
            } else if (state.content instanceof Uint8Array) {
                data = state.content;
            } else {
                data = Buffer.from(JSON.stringify(state.content), 'utf-8');
            }
        }
        return {
            data, // Pass data to next step that runs on remote
            path: state.remotePath,
            mode: state.mode,
            user: state.user,
            group: state.group,
            // If path changed, delete at old path, similar to how cleanup() works
            deleteOld:
                oldState?.remotePath !== state.remotePath
                    ? oldState?.remotePath
                    : undefined,
        };
    }),
    step<PutReq>('remote', async (state) => {
        // Delete old file if requested
        if (state.deleteOld) {
            await Bun.file(state.deleteOld).delete();
        }
        // Make sure the directory we're writing to exists, create if it doesn't
        await fs.mkdir(path.dirname(state.path), {
            recursive: true,
        });

        // Write to tmp dir, set permissions, atomically move
        const tmpdir = await fs.mkdtemp(
            path.join(path.dirname(state.path), 'tunkki-'),
        );
        const tmpfile = path.join(tmpdir, 'upload');
        await fs.writeFile(tmpfile, state.data, { mode: 0o600 });
        if (state.mode) {
            // fs.writeFile is subject to umask, so set user-specified mode explicitly if provided
            await fs.chmod(tmpfile, state.mode);
        }
        if (state.user) {
            await $`chown ${state.user} ${tmpfile}`;
        }
        if (state.group) {
            await $`chgrp ${state.group} ${tmpfile}`;
        }
        await fs.rename(tmpfile, state.path);

        // Clean up
        await fs.rmdir(tmpdir);
    }),
];

export const cleanup = async (state: State) => {
    await Bun.file(state.remotePath).delete();
};
