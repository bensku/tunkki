import { deserialize, serialize } from 'bun:jsc';

interface BaseEvent {
    type: string;
}

/**
 * Remote->local.
 */
interface Hello extends BaseEvent {
    type: 'hello';

    /**
     * Protocol version the remote wants to speak.
     */
    protocol: number;
}

/**
 * Local->remote. Handler code package for remote to use.
 */
interface UploadHandlers extends BaseEvent {
    type: 'uploadHandlers';

    /**
     * Handler names (e.g. podman/pod) mapped to base64-encoded
     * TS file contents (e.g. podman/pod.ts content).
     */
    handlers: Record<string, string>;
}

/**
 * Local->remote. Task and its state for remote to compare against previous
 * state. Remote will reply with Status.
 */
interface Task extends BaseEvent {
    type: 'task';

    /**
     * Unique task id.
     */
    id: string;

    /**
     * Task type. A handler for this must have been previously uploaded.
     */
    taskType: string;

    /**
     * State for first step of the task. This is compared to previous state on
     * remote to figure out if the task needs to be executed.
     */
    state: unknown;

    /**
     * If this task must be executed after another task, ids of those tasks.
     */
    dependsOn?: string[];
}

/**
 * Local->remote. Indicator that all tasks have been sent. The remote will reply
 * with Status events for tasks that would be deleted.
 */
interface TasksSent extends BaseEvent {
    type: 'tasksSent';
}

/**
 * Remote->local. Task status in plan. Local uses this information to presents
 * diff to user and, if approved, to send appropriate Run events.
 */
interface Status extends BaseEvent {
    type: 'status';

    /**
     * Task id, in reference to previous task event.
     */
    id: string;

    /**
     * What would executing the task cause?
     */
    status: 'created' | 'updated' | 'deleted' | 'unchanged';

    /**
     * Old state for client-side diff generation.
     * Only present if status is update or delete.
     */
    oldState: unknown;
}

/**
 * Remote->local. Remote is ready with plan phase. Local can now present the
 * diff to user and, if desired, begin sending Run events.
 */
interface Ready extends BaseEvent {
    type: 'ready';
}

/**
 * Local->remote. Order to execute a step in a task. Remote will take care
 * of respecting dependencies described in Task events. Remote will reply
 * with Done once the task has been completed (successfully or not).
 */
interface Run extends BaseEvent {
    type: 'run';

    /**
     * Reference to task that was hopefully sent earlier.
     */
    id: string;

    /**
     * Index of step in handler's step list to run.
     */
    step: number;

    /**
     * State to pass to the step. If this is step 0,
     * this should be undefined; the remote will fetch the effective state
     * from its own cache.
     *
     * If the effective state is undefined, the task is cleaned up. otheriwse,
     * it is applied.
     */
    state: unknown;
}

/**
 * Remote->local. Remote has completed a task step.
 */
interface Done extends BaseEvent {
    type: 'done';

    /**
     * Id of task that was run.
     */
    id: string;

    /**
     * How did the task step complete.
     * done: step was executed
     * error: error was thrown during step execution
     * skipped: a dependency error prevented execution of this task (only for step 0)
     */
    status: StepStatus;

    /**
     * Step result. If there are more steps, this is passed as state to the
     * next one.
     */
    result: unknown;
}

interface Reset extends BaseEvent {
    type: 'reset';
}

export type Event =
    | UploadHandlers
    | Task
    | TasksSent
    | Status
    | Ready
    | Run
    | Done
    | Reset;
export type StepStatus = 'done' | 'error' | 'skipped';

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
