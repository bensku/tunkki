import * as fs from 'node:fs/promises';
import { step } from '@bensku/tunkki/task';
import { $ } from 'bun';

export interface State {
    /**
     * Path where there should exist a directory.
     */
    path: string;

    /**
     * Mode for the remote file, e.g. 0o700.
     */
    mode?: number;

    /**
     * User who should own the remote file.
     */
    user?: string | number;

    /**
     * Group who should own the remote file.
     */
    group?: string | number;
}

export const apply = step<State>('remote', async (state) => {
    await fs.mkdir(state.path, {
        recursive: true,
        mode: '000', // Allow nothing until user/group have been set
    });
    if (state.user) {
        await $`chown ${state.user} ${state.path}`;
    }
    if (state.group) {
        await $`chgrp ${state.group} ${state.path}`;
    }
    // Set desired permissions now that ownership is correct
    $`chmod ${state.mode ?? '700'} ${state.path}`;
});
