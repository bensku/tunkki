import { nebula } from '@bensku/tunkki';
import { type Output, type TaskType, taskType } from '@bensku/tunkki/task';
import type { nebula as nebulaUtil } from '@bensku/tunkki/task/util';
import type { State as ContainerState } from './container';
import type { State as NetworkState } from './network';
import type { State as PodState } from './pod';
import type { RandomString, ReadFromEnv, State as SecretState } from './secret';

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
            opts.after.push(ep.id);

            if (endpoint.network.dnsServers && !state.dns) {
                state.dns = [...endpoint.network.dnsServers];
            }
        },
    }),
);

export const network = taskType<NetworkState, Output>(
    'podman.network',
    import.meta.resolve('./network'),
);
export const pod = taskType<PodState, Output>(
    'podman.pod',
    import.meta.resolve('./pod'),
);

export type SecretInput = RandomString | Omit<ReadFromEnv, 'hash'>;

export interface SecretOutput extends Output {
    name: string;
}

export const secret: TaskType<SecretInput, SecretOutput> = (id, input, opts) => {
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
