import { describe, expect, test } from 'bun:test';
import type { FileSink } from 'bun';
import { type ConnectionEvent, connect, type Host } from '../..';
import { CURRENT_PROTOCOL, type Event, writeEvent } from '../../common/event';
import type { Connector } from '../../protocol';

/**
 * Connector to an agent that only says hello.
 */
function successfulConnector(
    hello: Event = { type: 'hello', protocol: CURRENT_PROTOCOL },
): Connector {
    return {
        upload: async () => false,
        connect: async () => ({
            in: { write: () => 0 } as unknown as FileSink,
            out: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(writeEvent(hello));
                    controller.close();
                },
            }),
            close: async () => {},
        }),
    };
}

describe('connection events', () => {
    test('reports each host as its connection starts and completes', async () => {
        const alpha: Host = { id: 'alpha', conn: successfulConnector() };
        const beta: Host = { id: 'beta', conn: successfulConnector() };
        const hosts = [alpha, beta];
        const events: ConnectionEvent[] = [];

        const pool = await connect(hosts, (event) => events.push(event));
        await pool.close();

        expect(events).toEqual([
            { host: alpha, type: 'started' },
            { host: beta, type: 'started' },
            { host: alpha, type: 'completed', status: 'done' },
            { host: beta, type: 'completed', status: 'done' },
            { type: 'ready' },
        ]);
    });

    test('reports the host and error when a connection fails', async () => {
        const error = new Error('unreachable');
        const host: Host = {
            id: 'broken',
            conn: {
                upload: async () => false,
                connect: async () => {
                    throw error;
                },
            },
        };
        const events: ConnectionEvent[] = [];

        await expect(
            connect([host], (event) => events.push(event)),
        ).rejects.toThrow('connecting to hosts failed');
        expect(events).toEqual([
            { host, type: 'started' },
            { host, type: 'completed', status: 'error', error },
        ]);
    });

    test('rejects agents that speak another protocol', async () => {
        const host: Host = {
            id: 'old',
            conn: successfulConnector({ type: 'hello', protocol: 0 }),
        };
        const failure = await connect([host]).catch((e) => e);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors[0].message).toContain(
            'incompatible agent on old, run install-agent',
        );
        expect(failure.errors[0].cause.message).toContain(
            'agent uses protocol v0, but v2 is required',
        );
    });
});
