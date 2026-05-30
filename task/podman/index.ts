import { nebula } from '@bensku/tunkki';
import { type Output, taskType } from '@bensku/tunkki/task';
import type { nebula as nebulaUtil } from '@bensku/tunkki/task/util';
import type { State as ContainerState } from './container';
import type { State as NetworkState } from './network';
import type { State as PodState } from './pod';

type ContainerEndpoint = Omit<nebulaUtil.Endpoint, 'id'>;
interface ContainerOutput {
    connectNebula: (config: ContainerEndpoint) => void;
}

export const container = taskType<ContainerState, ContainerOutput>(
    'podman.container',
    import.meta.resolve('./container'),
    (id, state) => ({
        connectNebula: (endpoint) => {
            // Make Podman call nebula-netavark
            if (typeof state.network === 'string') {
                state.network = [state.network];
            } else if (!state.network) {
                state.network = [];
            }
            if (state.network.includes('nebula')) {
                throw new Error('currently, only one Nebula network per container is supported');
            }
            state.network.push('nebula');

            // Add endpoint so that nebula-netavark knows what to do with us
            nebula.endpoint(
                `${id}-nebula`,
                {
                    id: state.name,
                    ...endpoint,
                },
                { after: [id] },
            );
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
