import { type TaskOutput, taskType } from '@bensku/tunkki/task';
import type { State as ServiceState } from './service';
import type { State as TimerState } from './timer';

export const service = taskType<ServiceState, TaskOutput>(
    'systemd.service',
    import.meta.resolve('./service'),
);
export const timer = taskType<TimerState, TaskOutput>(
    'systemd.timer',
    import.meta.resolve('./timer'),
);
