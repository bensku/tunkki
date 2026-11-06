import { existsSync } from 'node:fs';
import { log, type ProbeState } from './probe';

/**
 * Remote, local and remote step. The last one fails while <dir>/<name>.fail
 * exists.
 */
export const apply = [
    {
        location: 'remote',
        handler: async (state: ProbeState) => {
            await log(state, `first ${state.name}`);
            return state;
        },
    },
    {
        location: 'local',
        handler: async (
            state: ProbeState,
            local: { host: { id: string } },
        ) => ({
            ...state,
            local: local.host.id,
        }),
    },
    {
        location: 'remote',
        handler: async (state: ProbeState & { local: string }) => {
            if (existsSync(`${state.dir}/${state.name}.fail`)) {
                throw new Error(`${state.name} failed`);
            }
            await log(state, `last ${state.name} after ${state.local}`);
            return { local: state.local };
        },
    },
];

export const cleanup = async (state: ProbeState) => {
    await log(state, `cleanup ${state.name}`);
};
