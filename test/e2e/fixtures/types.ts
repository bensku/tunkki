import { taskType } from '../../../task';
import type { ProbeState } from './probe';

export const probe = taskType<
    ProbeState,
    unknown,
    { host: string; value: unknown }
>('e2e.probe', import.meta.resolve('./probe'));

export const twostep = taskType<ProbeState, unknown, { local: string }>(
    'e2e.twostep',
    import.meta.resolve('./twostep'),
);
