import { type Event, writeEvent } from '../common/event';
import { log } from '../common/log';

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

export function reply(event: Event) {
    log.debug('remote->local', 'event', event);
    process.send!(writeEvent(event));
}
