import type { Host, protocols } from '@bensku/tunkki';
import type { FileSink } from 'bun';
import {
    CURRENT_PROTOCOL,
    type Event,
    readEvents,
    writeEvent,
} from '../common/event';
import { LOG_LEVEL, log } from '../common/log';

/**
 * How long to wait for the remote agent to send Hello.
 * This SHOULD not take anywhere near 10 seconds if all is well.
 */
const HELLO_TIMEOUT = 10_000;

export class Connection {
    #in: FileSink;
    #queue: Event[] = [];
    #notify: (() => void) | null = null;
    #closed = false;
    #error: unknown;

    close: () => Promise<void>;
    host: Host;

    constructor(proto: protocols.Connection, host: Host) {
        this.#in = proto.in;
        this.close = proto.close;
        this.host = host;
        this.#pump(proto.out);
    }

    async #pump(out: ReadableStream<Uint8Array>) {
        try {
            for await (const event of readEvents(out)) {
                log.debug(
                    'remote->local',
                    'host',
                    this.host.id,
                    'event',
                    event,
                );
                this.#queue.push(event);
                this.#wake();
            }
        } catch (e) {
            this.#error = e;
        } finally {
            this.#closed = true;
            this.#wake();
        }
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

    /**
     * Receives the next event. Only one caller may wait at a time.
     * @throws If the connection has closed.
     */
    async next(): Promise<Event> {
        while (this.#queue.length === 0) {
            if (this.#closed) {
                throw new Error(`connection to ${this.host.id} closed`, {
                    cause: this.#error,
                });
            }
            await new Promise<void>((resolve) => {
                this.#notify = resolve;
            });
        }
        return this.#queue.shift() as Event;
    }

    /**
     * Waits for the agent's hello and configures it.
     */
    async handshake() {
        let timer: Timer | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('agent did not initialize connection (missing Hello)')),
                HELLO_TIMEOUT,
            );
        });
        try {
            const hello = await Promise.race([this.next(), timeout]);
            if (hello.type !== 'hello' || hello.protocol !== CURRENT_PROTOCOL) {
                throw new Error(
                    `agent uses ${hello.type === 'hello' ? `protocol v${hello.protocol}` : 'an unknown protocol'}, but v${CURRENT_PROTOCOL} is required`,
                );
            }
        } catch (e) {
            throw new Error(
                `incompatible agent on ${this.host.id}, run install-agent to update it`,
                { cause: e },
            );
        } finally {
            clearTimeout(timer);
        }
        await this.send({ type: 'settings', logLevel: LOG_LEVEL });
    }
}
