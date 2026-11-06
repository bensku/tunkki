import * as path from 'node:path';
import type { FileSink } from 'bun';
import type { Host } from '../..';
import {
    type Event,
    readEvents,
    type StateFile,
    writeEvent,
} from '../../common/event';
import { serve } from '../../remote/runner';

/**
 * A host whose agent runs in this process, keeping state under a directory.
 */
export function fakeHost(id: string, dir: string): Host {
    return {
        id,
        conn: {
            upload: async () => false,
            connect: async () => {
                const toRemote = new TransformStream<Uint8Array, Uint8Array>();
                const toLocal = new TransformStream<Uint8Array, Uint8Array>();
                const remoteWriter = toLocal.writable.getWriter();
                const served = serve(
                    silenced(readEvents(toRemote.readable)),
                    (event) => remoteWriter.write(writeEvent(event)),
                    (stack) => path.join(dir, id, stack),
                ).finally(() => remoteWriter.close());

                const localWriter = toRemote.writable.getWriter();
                const sink = {
                    write: (data: Uint8Array) => {
                        localWriter.write(new Uint8Array(data));
                        return data.byteLength;
                    },
                } as unknown as FileSink;
                return {
                    in: sink,
                    out: toLocal.readable,
                    close: async () => {
                        await localWriter.close();
                        await served;
                    },
                };
            },
        },
    };
}

/**
 * Keeps logs of the remote out of test output. They would go to stderr, since
 * it shares the logger with local.
 */
async function* silenced(events: AsyncIterable<Event>) {
    for await (const event of events) {
        yield event.type === 'settings' ? { ...event, logLevel: 3 } : event;
    }
}

export function stateFile(dir: string, host: string, stack: string): string {
    return path.join(dir, host, stack, 'current.json');
}

export async function readState(
    dir: string,
    host: string,
    stack: string,
): Promise<StateFile> {
    const file = Bun.file(stateFile(dir, host, stack));
    return (await file.exists()) ? file.json() : {};
}

export async function writeState(
    dir: string,
    host: string,
    stack: string,
    state: StateFile,
) {
    await Bun.write(stateFile(dir, host, stack), JSON.stringify(state));
}
