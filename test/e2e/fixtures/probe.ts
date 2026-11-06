import { appendFile, mkdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';

/**
 * Task type for E2E tests. Writes value to <dir>/<name> and logs each call to
 * <dir>/log, so that tests can see what ran and in which order.
 */
export interface ProbeState {
    name: string;
    dir: string;
    value?: unknown;
    fail?: boolean;
}

export async function log(state: ProbeState, line: string) {
    await mkdir(state.dir, { recursive: true });
    await appendFile(`${state.dir}/log`, `${line}\n`);
}

export const apply = {
    location: 'remote',
    handler: async (state: ProbeState) => {
        await log(state, `apply ${state.name}`);
        if (state.fail) {
            throw new Error(`${state.name} failed`);
        }
        await Bun.write(
            `${state.dir}/${state.name}`,
            JSON.stringify(state.value ?? null),
        );
        return { host: hostname(), value: state.value };
    },
};

export const cleanup = async (state: ProbeState) => {
    await log(state, `cleanup ${state.name}`);
    await rm(`${state.dir}/${state.name}`, { force: true });
};
