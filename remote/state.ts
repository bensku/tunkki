import * as fs from 'node:fs/promises';
import { Semaphore } from './util';

/**
 * This remote's state, i.e. last known inputs and outputs of tasks.
 */
export interface State {
    /**
     * Gets input that was recorded to state for a task.
     * @param id Task id.
     */
    input(id: string): unknown | undefined;

    /**
     * Set input of the task with given id and write it to disk.
     * @param id Task id.
     * @param newInput New state.
     */
    setInput(id: string, newInput: unknown): Promise<void>;

    /**
     * Gets output that was recorded to state for given task.
     * @param id Task id.
     */
    output(id: string): unknown | undefined;

    /**
     * Set output of the task with given id and write it to disk.
     * @param id Stask id.
     * @param newOutput New output.
     */
    setOutput(id: string, newOutput: unknown): Promise<void>;

    /**
     * Delete state of the task with given id, "forgetting" it.
     * @param id Task id.
     */
    delete(id: string): Promise<void>;

    /**
     * Get local state as record. Don't change this, use
     * set(...) instead!
     */
    getState(): Readonly<Record<string, unknown>>;
}

/**
 * Loads local state from disk to memory.
 * @param stateDir State database directory.
 * @returns Local state.
 */
export async function loadState(stateDir: string): Promise<State> {
    const file = Bun.file(`${stateDir}/current.json`);
    const state: Record<string, unknown> = (await file.exists())
        ? await file.json()
        : {};
    const writeLock = new Semaphore(1);
    return {
        input(id) {
            return state[id];
        },
        async setInput(id, newState) {
            const release = await writeLock.acquire();
            try {
                state[id] = newState;
                await Bun.write(`${stateDir}/next.json`, JSON.stringify(state));
                await fs.rename(
                    `${stateDir}/next.json`,
                    `${stateDir}/current.json`,
                );
            } finally {
                release();
            }
        },
        output(id) {
            return state[`${id}$out`];
        },
        async setOutput(id, newOutput) {
            const release = await writeLock.acquire();
            try {
                state[`${id}$out`] = newOutput;
                await Bun.write(`${stateDir}/next.json`, JSON.stringify(state));
                await fs.rename(
                    `${stateDir}/next.json`,
                    `${stateDir}/current.json`,
                );
            } finally {
                release();
            }
        },
        async delete(id) {
            const release = await writeLock.acquire();
            try {
                delete state[id];
                await Bun.write(`${stateDir}/next.json`, JSON.stringify(state));
                await fs.rename(
                    `${stateDir}/next.json`,
                    `${stateDir}/current.json`,
                );
            } finally {
                release();
            }
        },
        getState() {
            return state;
        },
    };
}
