import { step } from '@bensku/tunkki/task';
import { $ } from 'bun';

interface BaseSecret {
    name: string;
    source: string;
}

export interface RandomString extends BaseSecret {
    source: 'random';
    format: 'hex' | 'base64';
    length: number;
}

export interface ReadFromEnv extends BaseSecret {
    source: 'env';
    localEnv: string;
    hash: string;
}

export type State = RandomString | ReadFromEnv;

interface CreateReq {
    name: string;
    value: string;
}

export const apply = [
    step<State, CreateReq>('local', async (state: State) => {
        let value: string;
        if (state.source === 'random') {
            const bytes = new Uint8Array(state.length);
            crypto.getRandomValues(bytes);
            value = state.format === 'hex' ? bytes.toHex() : bytes.toBase64();
        } else {
            const envValue = Bun.env[state.localEnv];
            if (envValue === undefined) {
                throw new Error(
                    `environment variable ${state.localEnv} is not set`,
                );
            }
            value = envValue;
        }

        return {
            name: state.name,
            value,
        };
    }),
    step<CreateReq>('remote', async (state: CreateReq) => {
        await $`printf %s ${state.value} | podman secret create --replace ${state.name} -`;
    }),
];

export const cleanup = async (state: State) => {
    await $`podman secret rm --ignore ${state.name}`;
};
