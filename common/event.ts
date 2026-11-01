import { deserialize, serialize } from 'bun:jsc';
import type { ChangeSet } from '../remote/plan';

interface BaseEvent {
    type: string;
}

export const CURRENT_PROTOCOL = 1;

/**
 * Remote->local.
 */
interface Hello extends BaseEvent {
    type: 'hello';

    /**
     * Protocol version the remote wants to speak.
     * Local can reject
     */
    protocol: number;

    /**
     * Remote log level.
     */
    logLevel: number;
}

/**
 * Local->remote. Request change set from remote
 */
interface Plan extends BaseEvent {
    type: 'plan';

    /**
     * States of tasks from local.
     */
    incoming: Record<string, object>;
}

/**
 * Remote->local. Change set for planning.
 */
interface PlanResult extends BaseEvent {
    type: 'planResult';

    /**
     * Change set, as seen by sending remote.
     */
    changeSet: ChangeSet;

    /**
     * Entire old state from remote.
     */
    oldInputs: Record<string, unknown>;

    oldOutputs: Record<string, unknown>;
}

interface BaseApplyEvent extends BaseEvent {
    /**
     * Apply session id.
     */
    session: string;
}

/**
 * Local->remote. Opens a new apply session with given settings.
 */
interface OpenSession extends BaseApplyEvent {
    type: 'openSession';

    /**
     * Stack id. This affects state directory.
     */
    stack: string;

    /**
     * Number of tasks that can be applied concurrently.
     */
    concurrency: number;
}

/**
 * Local->remote. Instruct remote to load specified handlers.
 */
interface LoadHandlers extends BaseApplyEvent {
    type: 'loadHandlers';

    /**
     * Handler names (e.g. podman/pod) mapped to TS script
     * (e.g. podman/pod.ts content).
     */
    handlers: Record<string, string>;
}

/**
 * Remote->local. Remote is ready to run tasks.
 */
interface Ready extends BaseApplyEvent {
    type: 'ready';

    /**
     * Error if something failed while loading handlers or other setup.
     */
    error?: string;
}

/**
 * Local->remote. Order to execute a step in a task. Remote will reply with
 * Done once task has been executed (successfully or not).
 */
interface Run extends BaseApplyEvent {
    type: 'run';

    /**
     * Task type id.
     */
    task: string;

    /**
     * Id of THIS task instance.
     */
    id: string;

    /**
     * Index of step in handler's step list to run.
     */
    step: number;

    /**
     * State to pass to the step. If undefined, the task is cleaned up.
     * Otherwise, it is applied.
     */
    state: unknown;

    /**
     * Before doing anything with state, recursively substitute values that
     * are also keys in this record, with their corresponding values from this
     * record. For example:
     *
     * state: { a: 123, b: "foo" }
     * subs: { foo: { test: 1} }
     *
     * would become:
     * state: { a 123, b: { test: 1 } }
     */
    replacements: Record<string, unknown>;

    /**
     * If true, this will always be applied. Manual dependsOn can cause this.
     */
    force: boolean;
}

/**
 * Remote->local. Remote has completed a task step.
 * Local->remote. Local has completed the LAST step of a task.
 */
interface Done extends BaseApplyEvent {
    type: 'done';

    /**
     * Id of task that was run.
     */
    id: string;

    /**
     * How did the task step complete.
     * done: step was executed
     * error: error was thrown during step execution
     * unchanged: inputs might've had changed, but actually didn't,
     * hence nothing was executed
     */
    status: StepStatus;

    /**
     * Step result. If there are more steps, this is passed as state to the
     * next one.
     */
    output: unknown;
}

interface CloseSession extends BaseApplyEvent {
    type: 'closeSession';
}

/**
 * Apply-phase event (i.e. has a session, WRITES changes to remote).
 */
export type ApplyEvent =
    | OpenSession
    | LoadHandlers
    | Ready
    | Run
    | Done
    | CloseSession;

export type Event = Hello | Plan | PlanResult | ApplyEvent;

export type StepStatus = 'started' | 'done' | 'error' | 'unchanged';

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
