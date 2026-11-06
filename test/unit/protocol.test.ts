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
    const events: Event[] = [
        { type: 'hello', protocol: 1 },
        { type: 'settings', logLevel: 1 },
        { type: 'plan', stack: 'prod' },
        {
            type: 'planResult',
            stack: 'prod',
            tasks: {
                'h1.svc': {
                    handler: 'systemd.service',
                    state: { name: 'svc', exec: ['/bin/echo', 'hi'] },
                    output: { pid: 1 },
                    deps: ['h1.file'],
                },
            },
            stateHash: 'abc',
        },
        {
            type: 'openSession',
            session: 's',
            stack: 'prod',
            concurrency: 4,
            stateHash: 'abc',
        },
        {
            type: 'loadHandlers',
            session: 's',
            handlers: { 'podman.pod': 'data:text/javascript;base64,AAAA' },
        },
        { type: 'ready', session: 's', error: 'oops' },
        {
            type: 'run',
            session: 's',
            task: 'files.put',
            id: 'h1.file',
            step: 1,
            state: { data: new Uint8Array([1, 2, 3]) },
        },
        {
            type: 'run',
            session: 's',
            task: 'files.put',
            id: 'h1.file',
            step: 0,
            state: undefined,
        },
        {
            type: 'done',
            session: 's',
            id: 'h1.file',
            status: 'done',
            output: 1,
        },
        {
            type: 'commit',
            session: 's',
            id: 'h1.file',
            record: { handler: 'files.put', state: {}, deps: [] },
        },
        { type: 'closeSession', session: 's' },
        { type: 'sessionClosed', session: 's' },
    ];
    for (const event of events) {
        test(event.type, async () => {
            expect(await roundTrip(event)).toEqual(event);
        });
    }

    test('undefined run state stays undefined', async () => {
        const decoded = await roundTrip({
            type: 'run',
            session: 's',
            task: 't',
            id: 'x',
            step: 0,
            state: undefined,
        });
        expect(decoded).toHaveProperty('state', undefined);
    });
});

describe('framing', () => {
    test('multiple frames in a single chunk are decoded as separate events', async () => {
        const a: Event = { type: 'hello', protocol: 1 };
        const b: Event = { type: 'plan', stack: 'prod' };
        const c: Event = { type: 'closeSession', session: 's' };

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
            type: 'commit',
            session: 's',
            id: 'web.frontend',
            record: { handler: 'systemd.service', state: { n: 42 } },
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
        const ev: Event = { type: 'ready', session: 's' };
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
        const buf = writeEvent({ type: 'ready', session: 's' });
        const declared = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(
            0,
        );
        expect(declared).toBe(buf.byteLength - 4);
    });
});
