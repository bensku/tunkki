import type { Barrier, Plan } from './plan';

export type TaskResult = 'done' | 'unchanged' | 'error' | 'skipped';

export interface SchedulerCallbacks {
    /**
     * Starts a task. The caller reports its result with finish().
     * @param depApplied Whether a task in its deps finished as done.
     */
    run(id: string, depApplied: boolean): void;

    /**
     * Reports that a task was skipped because something before it failed.
     */
    skipped(id: string): void;
}

/**
 * Starts tasks of a plan once tasks before them have finished.
 */
export class Scheduler {
    #plan: Plan;
    #callbacks: SchedulerCallbacks;
    #results = new Map<string, TaskResult>();
    #started = new Set<string>();
    #byWait = new Map<string, Barrier[]>();
    #byBlocked = new Map<string, Barrier[]>();
    #remaining: number;
    #cancelled = false;
    #finished: Promise<void>;
    #resolve!: () => void;

    constructor(plan: Plan, callbacks: SchedulerCallbacks) {
        this.#plan = plan;
        this.#callbacks = callbacks;
        for (const id of plan.unchanged) {
            this.#results.set(id, 'unchanged');
        }
        for (const barrier of plan.barriers) {
            for (const id of barrier.wait) addTo(this.#byWait, id, barrier);
            for (const id of barrier.blocked)
                addTo(this.#byBlocked, id, barrier);
        }
        this.#remaining =
            Object.keys(plan.nodes).length - plan.unchanged.length;
        this.#finished = new Promise((resolve) => (this.#resolve = resolve));
    }

    /**
     * Starts tasks that are ready.
     * @returns Promise that resolves when all tasks have finished.
     */
    start(): Promise<void> {
        if (this.#remaining === 0) {
            this.#resolve();
        }
        for (const id of Object.keys(this.#plan.nodes)) {
            this.#tryStart(id);
        }
        return this.#finished;
    }

    /**
     * Skips tasks that haven't started yet. Running tasks are left to finish.
     */
    cancel() {
        this.#cancelled = true;
        for (const id of Object.keys(this.#plan.nodes)) {
            if (!this.#results.has(id) && !this.#started.has(id)) {
                this.#setResult(id, 'skipped');
                this.#callbacks.skipped(id);
            }
        }
    }

    finish(id: string, result: 'done' | 'unchanged' | 'error') {
        this.#setResult(id, result);
        if (result === 'error') {
            this.#fail(id);
        } else {
            for (const next of this.#next(id)) {
                this.#tryStart(next);
            }
        }
    }

    #setResult(id: string, result: TaskResult) {
        this.#results.set(id, result);
        this.#remaining--;
        if (this.#remaining === 0) {
            this.#resolve();
        }
    }

    #fail(id: string) {
        for (const next of this.#next(id)) {
            if (!this.#results.has(next)) {
                this.#setResult(next, 'skipped');
                this.#callbacks.skipped(next);
                this.#fail(next);
            }
        }
    }

    /**
     * Tasks that may wait for the given task.
     */
    #next(id: string): string[] {
        const barriers = this.#byWait.get(id) ?? [];
        return [
            ...(this.#plan.nodes[id]?.dependents ?? []),
            ...barriers.flatMap((barrier) => barrier.blocked),
        ];
    }

    #tryStart(id: string) {
        if (this.#cancelled || this.#results.has(id) || this.#started.has(id)) {
            return;
        }
        const node = this.#plan.nodes[id];
        const barriers = this.#byBlocked.get(id) ?? [];
        const waitsFor = [
            ...(node?.after ?? []),
            ...barriers.flatMap((barrier) => barrier.wait),
        ];
        if (waitsFor.every((dep) => this.#succeeded(dep))) {
            this.#started.add(id);
            const depApplied =
                node?.task.deps.some(
                    (dep) => this.#results.get(dep) === 'done',
                ) ?? false;
            this.#callbacks.run(id, depApplied);
        }
    }

    #succeeded(id: string): boolean {
        const result = this.#results.get(id);
        return result === 'done' || result === 'unchanged';
    }
}

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
    map.set(key, [...(map.get(key) ?? []), value]);
}
