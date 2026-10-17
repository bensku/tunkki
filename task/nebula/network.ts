import { step } from '@bensku/tunkki/task';
import { nebula } from '@bensku/tunkki/task/util';

interface ConfigureReq {
    id: string;
    config: unknown;
}

export const apply = [
    step<nebula.Network, ConfigureReq>('local', async (state) => {
        return {
            id: state.id,
            config: await nebula.networkToConfig(state)
        }
    }),
    step<ConfigureReq>('remote', async (state) => {
        await Bun.write(
            `/etc/containers/nebula/network/${state.id}.yml`,
            JSON.stringify(state.config),
        );
    }),
];
