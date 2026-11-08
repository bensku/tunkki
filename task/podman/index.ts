import { nebula } from '@bensku/tunkki';
import { type TaskOutput, type TaskType, taskType } from '@bensku/tunkki/task';
import type { nebula as nebulaUtil } from '@bensku/tunkki/task/util';
import type { State as ContainerState } from './container';
import type { State as NetworkState } from './network';
import type { State as PodState } from './pod';
import type { RandomString, ReadFromEnv, Input as SecretState } from './secret';
import {
    SECRET_DRIVERS,
    type SecretDriver,
    type Input as SecretV2In,
    type Output as SecretV2Out,
} from './secretv2';

export type ContainerEndpoint = Omit<nebulaUtil.Endpoint, 'id'>;
export interface ContainerOutput {
    connectNebula: (config: ContainerEndpoint) => void;
}

export const container = taskType<ContainerState, ContainerOutput>(
    'podman.container',
    import.meta.resolve('./container'),
    (id, state, opts) => ({
        connectNebula: (endpoint) => {
            // Make Podman call nebula-netavark plugin
            if (typeof state.network === 'string') {
                state.network = [state.network];
            } else if (!state.network) {
                state.network = [];
            }
            if (state.network.includes('nebula')) {
                throw new Error(
                    'currently, only one Nebula network per container is supported',
                );
            }
            state.network.push('nebula');

            // Ensure nebula-netavarkd is up before we start
            if (typeof state.unit?.after === 'string') {
                state.unit.after = [
                    state.unit.after,
                    'nebula-netavarkd.service',
                ];
            } else if (!state.unit?.after) {
                if (state.unit) {
                    state.unit.after = ['nebula-netavarkd.service'];
                } else {
                    state.unit = {
                        after: ['nebula-netavarkd.service'],
                    };
                }
            }

            // Add endpoint so that nebula-netavark knows what to do with us
            const ep = nebula.endpoint(`${id}-nebula`, {
                id: state.name,
                ...endpoint,
            });

            // Make sure we're deployed BEFORE the container! Otherwise it won't start
            opts.dependencies.push(ep.id);
        },
    }),
);

export const network = taskType<NetworkState, TaskOutput>(
    'podman.network',
    import.meta.resolve('./network'),
);
export const pod = taskType<PodState, TaskOutput>(
    'podman.pod',
    import.meta.resolve('./pod'),
);

export type SecretInput = RandomString | Omit<ReadFromEnv, 'hash'>;

export interface SecretOutput extends TaskOutput {
    name: string;
}

export const secret: TaskType<SecretInput, SecretOutput> = (
    id,
    input,
    opts,
) => {
    // If input is local env variable, include its hash in state so redeploys update the value!
    if (input.source === 'env') {
        const secretValue = process.env[input.localEnv as string];
        if (!secretValue) {
            throw new Error(`missing secret localEnv ${input.localEnv}`);
        }
        return secretInternal(
            id,
            {
                ...input,
                hash: Bun.CryptoHasher.hash('sha256', secretValue).toBase64(),
            },
            opts,
        );
    } else {
        return secretInternal(id, input, opts);
    }
};

const secretInternal = taskType<SecretState, SecretOutput>(
    'podman.secret',
    import.meta.resolve('./secret'),
    (id, state) => ({
        id: id,
        name: state.name,
    }),
);

export type SecretV2Input = Omit<SecretV2In, 'hash'>;
export type SecretV2Output = SecretV2Out;

/**
 * Creates a Podman secret on host from given source. Its name changes
 * whenever its value changes; use `outputs.ref` to refer to it.
 */
export const secretv2: TaskType<
    SecretV2Input,
    TaskOutput & { outputs: SecretV2Output }
> = (id, input, opts) => {
    const driver = SECRET_DRIVERS[input.driver];
    if (!driver) {
        throw new Error(
            `invalid secret driver ${input.driver} for secret ${id}`,
        );
    }
    return secretV2Internal(
        id,
        {
            driver: input.driver,
            source: input.source,
            hash: Bun.CryptoHasher.hash(
                'sha256',
                driver(input.source),
            ).toBase64(),
        },
        opts,
    );
};

const secretV2Internal = taskType<SecretV2In, unknown, SecretV2Output>(
    'podman.secretv2',
    import.meta.resolve('./secretv2'),
);

/**
 * Registers a new secret driver.
 * @param id Driver id, used in secretv2 inputs.
 * @param driver Driver function. Takes secret source strings in, returns
 * secret values out. The driver MUST NOT generate a new secret each time,
 * but fetch them from somewhere (e.g. local environment variables).
 */
export function registerSecretDriver(id: string, driver: SecretDriver): void {
    if (SECRET_DRIVERS[id]) {
        throw new Error(`secret driver ${id} already registered`);
    }
    SECRET_DRIVERS[id] = driver;
}
