import type { Step } from '@bensku/tunkki/task';

export type TagSet = Record<string, string>;

export interface TaskHandler {
    apply: Step | Step[];
    cleanup?: Step['handler'];
}
