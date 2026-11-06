import { deserialize, serialize } from 'bun:jsc';

export const CURRENT_PROTOCOL = 1;

/**
 * Contents of a stack's state file on a remote: task ids mapped to records.
 *
 * Old versions treat every top-level key as a task, so this must never
 * contain anything else. New data goes inside records instead.
 */
export type StateFile = Record<string, TaskRecord>;

export interface TaskRecord {
    /**
     * Task type.
     */
    handler: string;

    /**
     * Resolved input of the task when it was last applied.
     */
    state: unknown;

    /**
     * Return value of the task's last step.
     */
    output?: unknown;

    /**
     * Ids of tasks this task depended on.
     */
    deps?: string[];
}

/**
 * Remote->local. First event the remote sends after starting.
 */
interface Hello {
    type: 'hello';
    protocol: number;
}

/**
 * Local->remote. Sent once after hello.
 */
interface Settings {
    type: 'settings';
    logLevel: number;
}

/**
 * Local->remote. Requests the state of a stack.
 */
interface Plan {
    type: 'plan';
    stack: string;
}

/**
 * Remote->local. Reply to Plan.
 */
interface PlanResult {
    type: 'planResult';
    stack: string;
    tasks: StateFile;
    stateHash: string;
    error?: string;
}

interface SessionEvent {
    session: string;
}

/**
 * Local->remote. Opens an apply session. Fails unless the state file still
 * has the given hash. This prevents dangerous application of stale plans
 */
interface OpenSession extends SessionEvent {
    type: 'openSession';

    /**
     * Stack name. Distinct stacks have distinct state, though they all operate
     * on same shared Linux machine.
     */
    stack: string;

    /**
     * How many operations the remote should execute concurrently.
     */
    concurrency: number;

    /**
     * State hash from PlanResult message. Remote will reject session if this
     * does not equal to hash of file on disk.
     */
    stateHash: string;
}

/**
 * Local->remote. Handler bundles as base64 data URLs, by task type.
 */
interface LoadHandlers extends SessionEvent {
    type: 'loadHandlers';

    /**
     * Task type ids to handler bundles (executable Javascript).
     */
    handlers: Record<string, string>;
}

/**
 * Remote->local. Reply to OpenSession and LoadHandlers.
 */
interface Ready extends SessionEvent {
    type: 'ready';
    error?: string;
}

/**
 * Local->remote. Runs one remote step of a task, or cleans the task up if
 * state is undefined. In cleanup, task is the type of the stored record.
 */
interface Run extends SessionEvent {
    type: 'run';
    task: string;
    id: string;
    step: number;
    state: unknown;
}

/**
 * Remote->local. Progress of a Run. Each Run gets at most one 'started' and
 * then exactly one 'done' or 'error'.
 */
interface Done extends SessionEvent {
    type: 'done';
    id: string;
    status: StepStatus;

    /**
     * Step's return value, or error message.
     */
    output: unknown;
}

/**
 * Local->remote. Writes a task's record to the state file.
 * The last step of task might be local, hence remote cannot always save stack
 * output by itself. Easier to always have local re-send it alongside other
 * data.
 */
interface Commit extends SessionEvent {
    type: 'commit';
    id: string;
    record: TaskRecord;
}

/**
 * Local->remote. Ends the session once pending commits have been written.
 */
interface CloseSession extends SessionEvent {
    type: 'closeSession';
}

/**
 * Remote->local. Reply to CloseSession. Error lists failed commits, if any.
 */
interface SessionClosed extends SessionEvent {
    type: 'sessionClosed';
    error?: string;
}

export type StepStatus = 'started' | 'done' | 'error';

export type SessionRequest =
    | OpenSession
    | LoadHandlers
    | Run
    | Commit
    | CloseSession;

export type Event =
    | Hello
    | Settings
    | Plan
    | PlanResult
    | SessionRequest
    | Ready
    | Done
    | SessionClosed;

export async function* readEvents(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Event> {
    let buffer = new Uint8Array(0);

    for await (const chunk of stream) {
        const merged = new Uint8Array(buffer.byteLength + chunk.byteLength);
        merged.set(buffer, 0);
        merged.set(chunk, buffer.byteLength);
        buffer = merged;

        while (buffer.byteLength >= 4) {
            const length = new DataView(
                buffer.buffer,
                buffer.byteOffset,
                4,
            ).getUint32(0);
            if (buffer.byteLength < 4 + length) {
                break;
            }
            const payload = buffer.subarray(4, 4 + length);
            yield deserialize(payload) as Event;
            buffer = buffer.subarray(4 + length);
        }
    }
}

export function writeEvent(event: Event): Uint8Array {
    const data = new Uint8Array(serialize(event));
    const result = new Uint8Array(4 + data.byteLength);
    new DataView(result.buffer).setUint32(0, data.byteLength);
    result.set(data, 4);
    return result;
}
