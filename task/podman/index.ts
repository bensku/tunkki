import { type Output, taskType } from '@bensku/tunkki/task';
import type { State as PodState } from './pod';

export const pod = taskType<PodState, Output>(
    'podman.pod',
    import.meta.resolve('./pod'),
);
