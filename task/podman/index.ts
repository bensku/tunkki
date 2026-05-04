import { type Output, taskType } from '@bensku/tunkki/task';
import type { State as ContainerState } from './container';
import type { State as NetworkState } from './network';
import type { State as PodState } from './pod';

export const container = taskType<ContainerState, Output>(
    'podman.container',
    import.meta.resolve('./container'),
);
export const network = taskType<NetworkState, Output>(
    'podman.network',
    import.meta.resolve('./network'),
);
export const pod = taskType<PodState, Output>(
    'podman.pod',
    import.meta.resolve('./pod'),
);
