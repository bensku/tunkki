import { describe, expect, test } from 'bun:test';
import { type Event, readEvents, writeEvent } from '../../common/event';

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Event[]> {
    const out: Event[] = [];
    for await (const ev of readEvents(stream)) out.push(ev);
    return out;
}

async function roundTrip(event: Event): Promise<Event> {
    const [decoded] = await collect(streamOf(writeEvent(event)));
    return decoded!;
}

describe('binary protocol round-trip', () => {
    test('hello', async () => {
        const ev: Event = { type: 'hello', protocol: 0 };
        expect(await roundTrip(ev)).toEqual(ev);
    });

    test('settings', async () => {
        const ev: Event = {
            type: 'settings',
            stack: 'prod',
            concurrency: 4,
            logLevel: 1,
        };
        expect(await roundTrip(ev)).toEqual(ev);
    });

    test('uploadHandlers preserves multi-line TS source verbatim', async () => {
        const ev: Event = {
            type: 'uploadHandlers',
            handlers: {
                'systemd.service': "import { $ } from 'bun';\n// comment\n",
                'podman.pod': 'export const apply = () => {};\n',
            },
        };
        expect(await roundTrip(ev)).toEqual(ev);
    });

    test('task with structured state and dependsOn', async () => {
        const ev: Event = {
            type: 'task',
            id: 'web.frontend',
            taskType: 'systemd.service',
            state: { name: 'frontend', exec: ['/bin/echo', 'hi'], port: 80 },
            dependsOn: ['db', 'cache'],
        };
        expect(await roundTrip(ev)).toEqual(ev);
    });

    test('task with undefined state survives the round-trip', async () => {
        // undefined-state means "delete this task" on the wire.
        const ev: Event = {
            type: 'task',
            id: 'gone',
            taskType: 'systemd.service',
            state: undefined,
        };
        expect(await roundTrip(ev)).toEqual(ev);
    });

    test('tasksSent', async () => {
        const ev: Event = { type: 'tasksSent' };
        expect(await roundTrip(ev)).toEqual(ev);
    });

    test('status with each variant', async () => {
        for (const status of [
            'created',
            'updated',
            'deleted',
            'unchanged',
        ] as const) {
            const ev: Event = {
                type: 'status',
                id: 'web.frontend',
                status,
                oldState: status === 'created' ? undefined : { name: 'old' },
            };
            expect(await roundTrip(ev)).toEqual(ev);
        }
    });

    test('ready', async () => {
        const ev: Event = { type: 'ready' };
        expect(await roundTrip(ev)).toEqual(ev);
    });

    test('run', async () => {
        const ev: Event = {
            type: 'run',
            id: 'web.frontend',
            step: 2,
            state: { intermediate: true },
        };
        expect(await roundTrip(ev)).toEqual(ev);
    });

    test('done with each status', async () => {
        for (const status of ['done', 'error', 'skipped'] as const) {
            const ev: Event = {
                type: 'done',
                id: 'x',
                status,
                result: status === 'error' ? 'boom' : { ok: true },
            };
            expect(await roundTrip(ev)).toEqual(ev);
        }
    });

    test('reset', async () => {
        const ev: Event = { type: 'reset' };
        expect(await roundTrip(ev)).toEqual(ev);
    });
});

describe('framing', () => {
    test('multiple frames in a single chunk are decoded as separate events', async () => {
        const a: Event = { type: 'hello', protocol: 0 };
        const b: Event = { type: 'tasksSent' };
        const c: Event = { type: 'ready' };

        const ba = writeEvent(a);
        const bb = writeEvent(b);
        const bc = writeEvent(c);
        const merged = new Uint8Array(
            ba.byteLength + bb.byteLength + bc.byteLength,
        );
        merged.set(ba, 0);
        merged.set(bb, ba.byteLength);
        merged.set(bc, ba.byteLength + bb.byteLength);

        expect(await collect(streamOf(merged))).toEqual([a, b, c]);
    });

    test('a frame split across multiple chunks reassembles correctly', async () => {
        // Stress the buffer-merge path: cut the same frame at every byte
        // offset and assert it still decodes to the original event.
        const ev: Event = {
            type: 'task',
            id: 'web.frontend',
            taskType: 'systemd.service',
            state: { description: 'split-me', n: 42 },
        };
        const buf = writeEvent(ev);

        for (let cut = 1; cut < buf.byteLength; cut++) {
            const head = buf.subarray(0, cut);
            const tail = buf.subarray(cut);
            // Subarrays share the backing buffer; copy to fresh allocations
            // so the stream consumer can't observe internal mutation.
            const decoded = await collect(
                streamOf(new Uint8Array(head), new Uint8Array(tail)),
            );
            expect(decoded).toEqual([ev]);
        }
    });

    test('a chunk that ends mid-length-prefix is buffered and resumes on the next chunk', async () => {
        const ev: Event = { type: 'ready' };
        const buf = writeEvent(ev);
        // Cut inside the 4-byte length header (after 2 bytes).
        const decoded = await collect(
            streamOf(
                new Uint8Array(buf.subarray(0, 2)),
                new Uint8Array(buf.subarray(2)),
            ),
        );
        expect(decoded).toEqual([ev]);
    });

    test('an empty stream yields no events', async () => {
        expect(await collect(streamOf())).toEqual([]);
    });

    test('writeEvent prefixes a 4-byte big-endian length', async () => {
        const buf = writeEvent({ type: 'ready' });
        const declared = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(
            0,
        );
        expect(declared).toBe(buf.byteLength - 4);
    });
});
