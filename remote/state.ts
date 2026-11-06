import * as fs from 'node:fs/promises';
import type { StateFile, TaskRecord } from '../common/event';
import { Semaphore } from './util';

/**
 * A stack's state on this remote.
 */
export interface State {
    readonly records: Readonly<StateFile>;

    /**
     * Hash of the state file as it was when loaded.
     */
    readonly hash: string;

    /**
     * Sets a task's record and writes the state file.
     */
    commit(id: string, record: TaskRecord): Promise<void>;

    /**
     * Removes a task's record and writes the state file.
     */
    delete(id: string): Promise<void>;
}

export function stateDir(stack: string): string {
    return `/opt/tunkki/${stack}/state`;
}

/**
 * Hashes state file contents. A missing file hashes as empty.
 */
export function hashState(bytes: Uint8Array): string {
    return Bun.CryptoHasher.hash('sha256', bytes, 'hex');
}

/**
 * Loads state from the given directory. Missing state is empty.
 */
export async function loadState(dir: string): Promise<State> {
    const file = Bun.file(`${dir}/current.json`);
    const bytes = (await file.exists())
        ? await file.bytes()
        : new Uint8Array(0);
    const records: StateFile =
        bytes.byteLength > 0 ? JSON.parse(new TextDecoder().decode(bytes)) : {};

    const writeLock = new Semaphore(1);
    const write = async (change: () => void) => {
        const release = await writeLock.acquire();
        try {
            change();
            // Write and rename, so that a crash never leaves a partial file
            await fs.mkdir(dir, { recursive: true });
            await Bun.write(`${dir}/next.json`, JSON.stringify(records));
            await fs.rename(`${dir}/next.json`, `${dir}/current.json`);
        } finally {
            release();
        }
    };

    return {
        records,
        hash: hashState(bytes),
        commit(id, record) {
            return write(() => {
                records[id] = record;
            });
        },
        delete(id) {
            return write(() => {
                delete records[id];
            });
        },
    };
}
