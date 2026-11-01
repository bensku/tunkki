import type { State } from './state';

export interface ChangeSet {
    changed: string[];
    created: string[];
    deleted: string[];
}

/**
 * Compare current (remote) state to incoming (local) state, producing a change
 * set. Note that this change set is INCOMPLETE, as it will be missing
 * cascading changes due to dependencies!
 * @param state State on this remote.
 * @param incoming Incoming state, sent to us.
 * @returns A change set.
 */
export function newChangeSet(
    state: State,
    incoming: Record<string, string>,
): ChangeSet {
    const current = state.getState();

    const changed = [];
    const created = [];
    const deleted = [];

    // Find changed and new tasks
    for (const [id, newState] of Object.entries(incoming)) {
        const oldState = current[id];
        if (oldState === undefined) {
            created.push(id);
        } else if (Bun.deepEquals(newState, oldState)) {
            changed.push(id);
        }
    }

    // Find deleted, i.e. absent from incoming set
    for (const id of Object.keys(current)) {
        const newState = incoming[id];
        if (newState === undefined) {
            deleted.push(id);
        }
    }

    return {
        changed,
        created,
        deleted,
    };
}
