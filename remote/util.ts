export class Semaphore {
    #permits: number;
    #queue: Array<() => void> = [];

    constructor(permits: number) {
        this.#permits = permits;
    }

    async acquire(): Promise<() => void> {
        if (this.#permits > 0) {
            this.#permits--;
        } else {
            await new Promise<void>((resolve) => this.#queue.push(resolve));
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = this.#queue.shift();
            if (next) {
                next();
            } else {
                this.#permits++;
            }
        };
    }
}
