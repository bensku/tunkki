import { planAndApply } from './apply';
import type { CliContext } from './plan';

export function run(ctx: CliContext): Promise<number> {
    return planAndApply(ctx, 'destroy');
}
