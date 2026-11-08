/**
 * Handlers for apply tests. Remotes run in the same process as the tests, so
 * handlers report what they do through globalThis.applyTest.
 */

export interface TestState {
    name: string;
    value?: unknown;
    fail?: boolean;
}

interface TestGlobal {
    calls: string[];
}

export function record(call: string) {
    (globalThis as unknown as { applyTest: TestGlobal }).applyTest.calls.push(
        call,
    );
}

/**
 * A handler with one remote step, whose output is { value }.
 */
export function singleStep(label: string) {
    return {
        apply: {
            location: 'remote',
            handler: async (state: TestState) => {
                record(`${label}:apply:${state.name}`);
                if (state.fail) {
                    throw new Error(`${state.name} failed`);
                }
                return { value: state.value };
            },
        },
        cleanup: async (state: TestState) => {
            record(`${label}:cleanup:${state.name}`);
        },
    };
}
