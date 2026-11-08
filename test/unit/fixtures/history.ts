import { record, type TestState } from './log';

interface Output {
    value: unknown;
}

const show = (value: unknown) => JSON.stringify(value) ?? 'none';

/**
 * Local and remote step that record the old output they get. Cleanup records
 * the output it gets.
 */
export const apply = [
    {
        location: 'local',
        handler: async (
            state: TestState,
            _: unknown,
            _oldState?: TestState,
            oldOutput?: Output,
        ) => {
            record(`history:local:${state.name}:${show(oldOutput)}`);
            return state;
        },
    },
    {
        location: 'remote',
        handler: async (
            state: TestState,
            _: unknown,
            _oldState?: TestState,
            oldOutput?: Output,
        ): Promise<Output> => {
            record(`history:remote:${state.name}:${show(oldOutput)}`);
            return { value: state.value };
        },
    },
];

export const cleanup = async (state: TestState, output?: Output) => {
    record(`history:cleanup:${state.name}:${show(output)}`);
};
