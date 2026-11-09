import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Event, StateFile } from '../../common/event';
import { serve } from '../../remote/runner';
import { hashState } from '../../remote/state';

declare global {
    var remoteTest: {
        calls: unknown[][];
        gate: Promise<void>;
    };
}

/**
 * Handler used by these tests: remote, local, remote. Records calls in
 * globalThis.remoteTest.calls.
 */
const HANDLER = `
export const apply = [
    {
        location: 'remote',
        handler: async (state, _, oldState) => {
            remoteTest.calls.push(['step0', state, oldState]);
            if (state.wait) await remoteTest.gate;
            if (state.fail) throw new Error('boom');
            return { value: state.value };
        },
    },
    { location: 'local', handler: async (state) => state },
    { location: 'remote', handler: async (state) => ({ final: state }) },
];
export const cleanup = async (state) => {
    remoteTest.calls.push(['cleanup', state]);
};
`;
const HANDLER_URL = `data:text/javascript;base64,${Buffer.from(HANDLER).toString('base64')}`;

/** An old-format state file, as written by 31b08fd. */
const OLD_STATE: StateFile = {
    'h1.file': { handler: 'test.handler', state: { value: 1 } },
    'h1.file-end': { handler: '$noop', state: {} },
};

let dir: string;
let stateFile: string;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-remote-'));
    stateFile = path.join(dir, 'prod', 'current.json');
    globalThis.remoteTest = { calls: [], gate: Promise.resolve() };
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true });
});

async function writeState(state: StateFile): Promise<string> {
    const text = JSON.stringify(state);
    await Bun.write(stateFile, text);
    return hashState(new TextEncoder().encode(text));
}

async function readState(): Promise<StateFile> {
    return Bun.file(stateFile).json();
}

/**
 * Runs serve() against in-memory streams.
 */
function startRemote() {
    const queue: Event[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    async function* events() {
        while (true) {
            while (queue.length > 0) yield queue.shift()!;
            if (ended) return;
            await new Promise<void>((resolve) => (wake = resolve));
        }
    }

    const replies: Event[] = [];
    const waiters: (() => void)[] = [];
    const served = serve(
        events(),
        (event) => {
            replies.push(event);
            for (const waiter of waiters.splice(0)) waiter();
        },
        (stack) => path.join(dir, stack),
    );

    return {
        replies,
        send(event: Event) {
            queue.push(event);
            wake?.();
        },
        async waitFor(match: (event: Event) => boolean): Promise<Event> {
            while (true) {
                const found = replies.find(match);
                if (found) return found;
                await new Promise<void>((resolve) => waiters.push(resolve));
            }
        },
        async end() {
            ended = true;
            wake?.();
            await served;
        },
    };
}

type Remote = ReturnType<typeof startRemote>;

async function open(remote: Remote, stateHash: string) {
    remote.send({
        type: 'openSession',
        session: 's',
        stack: 'prod',
        concurrency: 2,
        stateHash,
    });
    const opened = await remote.waitFor((e) => e.type === 'ready');
    expect(opened).toEqual({ type: 'ready', session: 's', error: undefined });
    remote.send({
        type: 'loadHandlers',
        session: 's',
        handlers: { 'test.handler': HANDLER_URL },
    });
    await remote.waitFor((e) => e.type === 'ready' && e !== opened);
}

function doneFor(remote: Remote, id: string) {
    return remote.replies.filter(
        (e) => e.type === 'done' && e.id === id,
    ) as Extract<Event, { type: 'done' }>[];
}

/**
 * Waits for the nth step of a task to finish.
 */
async function finished(remote: Remote, id: string, nth = 1) {
    await remote.waitFor(
        () =>
            doneFor(remote, id).filter((e) => e.status !== 'started').length >=
            nth,
    );
    return doneFor(remote, id).filter((e) => e.status !== 'started')[nth - 1]!;
}

describe('remote', () => {
    test('says hello first', async () => {
        const remote = startRemote();
        await remote.end();
        expect(remote.replies[0]).toEqual({ type: 'hello', protocol: 2 });
    });

    test('plans against missing state', async () => {
        const remote = startRemote();
        remote.send({ type: 'plan', stack: 'prod' });
        const result = await remote.waitFor((e) => e.type === 'planResult');
        await remote.end();
        expect(result).toEqual({
            type: 'planResult',
            stack: 'prod',
            tasks: {},
            stateHash: hashState(new Uint8Array(0)),
        });
    });

    test('plans against old-format state', async () => {
        const hash = await writeState(OLD_STATE);
        const remote = startRemote();
        remote.send({ type: 'plan', stack: 'prod' });
        const result = await remote.waitFor((e) => e.type === 'planResult');
        await remote.end();
        expect(result).toEqual({
            type: 'planResult',
            stack: 'prod',
            tasks: OLD_STATE,
            stateHash: hash,
        });
    });

    test('rejects a session with a stale hash', async () => {
        await writeState(OLD_STATE);
        const remote = startRemote();
        remote.send({
            type: 'openSession',
            session: 's',
            stack: 'prod',
            concurrency: 1,
            stateHash: hashState(new Uint8Array(0)),
        });
        const ready = await remote.waitFor((e) => e.type === 'ready');
        await remote.end();
        expect(ready).toMatchObject({ type: 'ready', session: 's' });
        expect((ready as { error?: string }).error).toContain(
            'state has changed',
        );
    });

    test('runs steps with old state and replies once per step', async () => {
        const remote = startRemote();
        await open(remote, await writeState(OLD_STATE));

        remote.send({
            type: 'run',
            session: 's',
            task: 'test.handler',
            id: 'h1.file',
            step: 0,
            state: { value: 2 },
        });
        await finished(remote, 'h1.file');
        remote.send({
            type: 'run',
            session: 's',
            task: 'test.handler',
            id: 'h1.file',
            step: 2,
            state: 'last',
        });
        const last = await finished(remote, 'h1.file', 2);
        await remote.end();

        expect(globalThis.remoteTest.calls).toEqual([
            ['step0', { value: 2 }, { value: 1 }],
        ]);
        expect(doneFor(remote, 'h1.file').map((e) => e.status)).toEqual([
            'started',
            'done',
            'started',
            'done',
        ]);
        expect(last.output).toEqual({ final: 'last' });
    });

    test('replies with exactly one error when a step fails', async () => {
        const remote = startRemote();
        await open(remote, await writeState({}));
        remote.send({
            type: 'run',
            session: 's',
            task: 'test.handler',
            id: 'h1.x',
            step: 0,
            state: { fail: true },
        });
        const result = await finished(remote, 'h1.x');
        remote.send({ type: 'closeSession', session: 's' });
        await remote.waitFor((e) => e.type === 'sessionClosed');
        await remote.end();

        expect(result.status).toBe('error');
        expect(result.output).toContain('boom');
        expect(doneFor(remote, 'h1.x').map((e) => e.status)).toEqual([
            'started',
            'error',
        ]);
    });

    test('rejects running a local step', async () => {
        const remote = startRemote();
        await open(remote, await writeState({}));
        remote.send({
            type: 'run',
            session: 's',
            task: 'test.handler',
            id: 'h1.x',
            step: 1,
            state: {},
        });
        const result = await finished(remote, 'h1.x');
        await remote.end();
        expect(result.status).toBe('error');
        expect(result.output).toContain('no remote step 1');
    });

    test('commits records next to old ones', async () => {
        const remote = startRemote();
        await open(remote, await writeState(OLD_STATE));
        remote.send({
            type: 'commit',
            session: 's',
            id: 'h1.new',
            record: {
                handler: 'test.handler',
                state: { value: 3 },
                output: { value: 3 },
                deps: ['h1.file'],
            },
        });
        remote.send({ type: 'closeSession', session: 's' });
        const closed = await remote.waitFor((e) => e.type === 'sessionClosed');
        await remote.end();

        expect(closed).toEqual({
            type: 'sessionClosed',
            session: 's',
            error: undefined,
        });
        expect(await readState()).toEqual({
            ...OLD_STATE,
            'h1.new': {
                handler: 'test.handler',
                state: { value: 3 },
                output: { value: 3 },
                deps: ['h1.file'],
            },
        });
    });

    test('cleans up with the stored state', async () => {
        const remote = startRemote();
        await open(remote, await writeState(OLD_STATE));
        remote.send({
            type: 'run',
            session: 's',
            task: 'test.handler',
            id: 'h1.file',
            step: 0,
            state: undefined,
        });
        const result = await finished(remote, 'h1.file');
        await remote.end();

        expect(result.status).toBe('done');
        expect(globalThis.remoteTest.calls).toEqual([
            ['cleanup', { value: 1 }],
        ]);
        expect(await readState()).toEqual({
            'h1.file-end': { handler: '$noop', state: {} },
        });
    });

    test('drops $noop records without a handler', async () => {
        const remote = startRemote();
        remote.send({
            type: 'openSession',
            session: 's',
            stack: 'prod',
            concurrency: 1,
            stateHash: await writeState(OLD_STATE),
        });
        await remote.waitFor((e) => e.type === 'ready');
        remote.send({
            type: 'run',
            session: 's',
            task: '$noop',
            id: 'h1.file-end',
            step: 0,
            state: undefined,
        });
        const result = await finished(remote, 'h1.file-end');
        await remote.end();

        expect(result.status).toBe('done');
        expect(await readState()).toEqual({ 'h1.file': OLD_STATE['h1.file']! });
    });

    test('runs steps concurrently up to the limit', async () => {
        let openGate!: () => void;
        globalThis.remoteTest.gate = new Promise((r) => (openGate = r));

        const remote = startRemote();
        await open(remote, await writeState({}));
        for (const id of ['a', 'b', 'c']) {
            remote.send({
                type: 'run',
                session: 's',
                task: 'test.handler',
                id,
                step: 0,
                state: { wait: true },
            });
        }
        while (globalThis.remoteTest.calls.length < 2) {
            await Bun.sleep(1);
        }
        await Bun.sleep(10);
        // Concurrency is 2, so the third must wait
        expect(globalThis.remoteTest.calls).toHaveLength(2);

        openGate();
        await Promise.all(['a', 'b', 'c'].map((id) => finished(remote, id)));
        await remote.end();
        expect(globalThis.remoteTest.calls).toHaveLength(3);
    });
});
