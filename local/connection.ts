import type { Host, protocols } from '@bensku/tunkki';
import type { FileSink } from 'bun';
import { type Event, readEvents, writeEvent } from '../common/event';
import { log } from '../common/log';

export class Connection {
    #in: FileSink;
    #out: ReadableStream<Uint8Array>;
    #queue: Event[] = [];
    #notify: (() => void) | null = null;
    #stdoutDone = false;
    #error: unknown = undefined;

    close: () => void;
    host: Host;

    constructor(proto: protocols.Connection, host: Host) {
        this.#in = proto.in;
        this.#out = proto.out;
        this.close = proto.close;
        this.host = host;
        this.#pump();
    }

    async #pump() {
        try {
            for await (const event of readEvents(this.#out)) {
                this.#enqueue(event);
            }
        } catch (e) {
            this.#error = e;
        } finally {
            this.#stdoutDone = true;
            this.#wake();
        }
    }

    #enqueue(event: Event) {
        this.#queue.push(event);
        this.#wake();
    }

    #wake() {
        const notify = this.#notify;
        this.#notify = null;
        notify?.();
    }

    async send(event: Event) {
        log.debug('local->remote', 'host', this.host.id, 'event', event);
        await this.#in.write(writeEvent(event));
    }

    sendToSelf(event: Event) {
        this.#enqueue(event);
    }

    async *listen(): AsyncGenerator<Event> {
        while (true) {
            while (this.#queue.length > 0) {
                // biome-ignore lint/style/noNonNullAssertion: see length check above
                yield this.#queue.shift()!;
            }
            if (this.#stdoutDone) {
                if (this.#error !== undefined) throw this.#error;
                return;
            }
            await new Promise<void>((resolve) => {
                this.#notify = resolve;
            });
        }
    }
}
