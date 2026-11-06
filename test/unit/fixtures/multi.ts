import type { TestState } from './log';

type Passed = TestState & { host: string; old: unknown };

/**
 * Local, remote and remote step. Fails in the last step if state.fail is set.
 */
export const apply = [
    {
        location: 'local',
        handler: async (
            state: TestState,
            local: { host: { id: string } },
            oldState?: TestState,
        ) => ({ ...state, host: local.host.id, old: oldState?.value }),
    },
    {
        location: 'remote',
        handler: async (state: Passed) => state,
    },
    {
        location: 'remote',
        handler: async (state: Passed) => {
            if (state.fail) {
                throw new Error(`${state.name} failed`);
            }
            return { host: state.host, old: state.old };
        },
    },
];
