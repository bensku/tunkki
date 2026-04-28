import { step } from '@bensku/tunkki/task';
import { $ } from 'bun';

export type State = {};

export const apply = [
    step('remote', async (state: State) => {}),
    step('local', async (state: { nebulaPublicKey: string }) => {}),
    step('remote', async (state: { nebulaCert: string }) => {}),
];

export const cleanup = async (state: State) => {
    await $`ls`;
};
