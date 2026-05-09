import { type Output, taskType } from '@bensku/tunkki/task';
import type { State as ServiceState } from './service';
import type { State as TimerState } from './timer';

export const service = taskType<ServiceState, Output>(
    'systemd.service',
    import.meta.resolve('./service'),
);
export const timer = taskType<TimerState, Output>(
    'systemd.timer',
    import.meta.resolve('./timer'),
);
