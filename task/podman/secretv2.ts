import { log, step } from '@bensku/tunkki/task';
import { $ } from 'bun';

export interface SecretRef {
    driver: string;
    podmanId: string;
}

export type SecretDriver = (source: string) => string;

export const SECRET_DRIVERS: Record<string, SecretDriver> = {
    localEnv: (source) => {
        const value = process.env[source];
        if (!value) {
            throw new Error(
                `tried to read secret from missing env variable: ${source}`,
            );
        }
        return value;
    },
    // podman.registerSecretDriver(...) can add here
};

export interface Input {
    /**
     * Secret driver id, we'll use this to lookup a driver.
     */
    driver: string;

    /**
     * Source to be fed to the driver.
     */
    source: string;

    /**
     * Filled by querying secret from driver. This is needed for change
     * detection!
     */
    hash: string;
}

export interface Output {
    ref: SecretRef;
}

interface WriteSecret {
    driver: string;
    name: string;
    value: string;
}

/**
 * Creates a secret under a new name whenever its value changes. Tasks that use
 * it get the new name through outputs, so they are applied again. The old
 * secret is removed once the new one exists. If that fails, it is logged and
 * left behind.
 */
export const apply = [
    step<Input, WriteSecret>('local', async (state) => {
        const driver = SECRET_DRIVERS[state.driver];
        if (!driver) {
            // The task type wrapper checks this, so it should not happen
            throw new Error(`unknown secret driver ${state.driver}`);
        }
        return {
            driver: state.driver,
            name: `tunkkiv2-${crypto.randomUUID()}`,
            value: driver(state.source),
        };
    }),
    step<WriteSecret, Output, unknown, Output>(
        'remote',
        async (state, _, _oldState, oldOutput) => {
            // Value goes through stdin, so that it doesn't show up in ps
            await $`podman secret create --replace ${state.name} - < ${Buffer.from(state.value)}`.quiet();
            const oldName = oldOutput?.ref.podmanId;
            if (oldName && oldName !== state.name) {
                // New secret exists and is used from now on; failing here would
                // leave it out of state, and create yet another one next time
                const rm = await $`podman secret rm --ignore ${oldName}`
                    .nothrow()
                    .quiet();
                if (rm.exitCode !== 0) {
                    log.error(
                        'failed to remove old secret',
                        oldName,
                        'error',
                        rm.stderr.toString().trim(),
                    );
                }
            }
            return {
                ref: {
                    driver: state.driver,
                    podmanId: state.name,
                },
            };
        },
    ),
];

export const cleanup = async (_state: Input, output?: Output) => {
    const name = output?.ref.podmanId;
    if (name) {
        await $`podman secret rm --ignore ${name}`.quiet();
    }
};
