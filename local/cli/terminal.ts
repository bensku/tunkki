const ESC = '\x1b[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_DOWN = `${ESC}J`;
const RESET = `${ESC}0m`;
// Terminals that support synchronized output don't flicker while redrawing.
// Others ignore these.
const SYNC_START = `${ESC}?2026h`;
const SYNC_END = `${ESC}?2026l`;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;

/**
 * Draws a region of lines at the bottom of the terminal and redraws it
 * periodically. Everything printed while it is shown goes above it.
 */
class Terminal {
    #render: (() => string[]) | null = null;
    #lines = 0;
    #timer: Timer | null = null;
    #interrupt: (() => boolean) | null = null;
    #listening = false;

    constructor() {
        process.on('exit', () => this.stop());
    }

    /**
     * Handles Ctrl-C until the returned function is called.
     * @param handler Returns false to exit anyway.
     */
    onInterrupt(handler: () => boolean): () => void {
        this.#interrupt = handler;
        this.#syncSigint();
        return () => {
            if (this.#interrupt === handler) {
                this.#interrupt = null;
                this.#syncSigint();
            }
        };
    }

    #sigint = () => {
        if (this.#interrupt?.()) {
            return;
        }
        this.stop();
        process.exit(130);
    };

    /**
     * Listens for SIGINT when we must handle it. Otherwise, the default
     * handler exits, e.g. while the user is being asked for confirmation.
     */
    #syncSigint() {
        const listen = this.#render !== null || this.#interrupt !== null;
        if (listen && !this.#listening) {
            process.on('SIGINT', this.#sigint);
        } else if (!listen && this.#listening) {
            process.off('SIGINT', this.#sigint);
        }
        this.#listening = listen;
    }

    /**
     * Whether a live region can be drawn on stdout.
     */
    get interactive(): boolean {
        return (
            process.stdout.isTTY === true &&
            process.env.TERM !== 'dumb' &&
            process.env.CI === undefined
        );
    }

    /**
     * Current spinner frame.
     */
    get spinner(): string {
        return SPINNER[
            Math.floor(performance.now() / FRAME_MS) % SPINNER.length
        ] as string;
    }

    /**
     * Shows a live region, replacing the previous one.
     * @param render Returns lines of the region. Called on every redraw.
     */
    live(render: () => string[]) {
        if (!this.#render) {
            process.stdout.write(HIDE_CURSOR);
            this.#timer = setInterval(() => this.#redraw(), FRAME_MS);
            this.#timer.unref();
        }
        this.#render = render;
        this.#syncSigint();
        this.#redraw();
    }

    /**
     * Removes the live region.
     */
    stop() {
        if (!this.#render) {
            return;
        }
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = null;
        }
        process.stdout.write(this.#clear() + SHOW_CURSOR);
        this.#render = null;
        this.#syncSigint();
    }

    /**
     * Writes text above the live region.
     */
    write(stream: 'stdout' | 'stderr', text: string) {
        if (!this.#render) {
            process[stream].write(text);
            return;
        }
        process.stdout.write(SYNC_START + this.#clear());
        process[stream].write(text);
        process.stdout.write(this.#draw() + SYNC_END);
    }

    #redraw() {
        if (this.#render) {
            process.stdout.write(
                SYNC_START + this.#clear() + this.#draw() + SYNC_END,
            );
        }
    }

    #clear(): string {
        const lines = this.#lines;
        this.#lines = 0;
        return lines > 0 ? `${ESC}${lines}F${CLEAR_DOWN}` : CLEAR_DOWN;
    }

    #draw(): string {
        if (!this.#render) {
            return '';
        }
        const width = process.stdout.columns ?? 80;
        const height = process.stdout.rows ?? 24;
        let lines = this.#render();
        if (lines.length >= height) {
            lines = lines.slice(0, height - 1);
        }
        this.#lines = lines.length;
        return lines.map((line) => `${truncate(line, width)}\n`).join('');
    }
}

export const term = new Terminal();

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/y;

/**
 * Cuts a line to fit in a width, keeping ANSI escapes intact.
 */
export function truncate(line: string, width: number): string {
    if (Bun.stringWidth(line) <= width) {
        return line;
    }
    let out = '';
    let used = 0;
    let i = 0;
    while (i < line.length) {
        ANSI.lastIndex = i;
        const match = ANSI.exec(line);
        if (match) {
            out += match[0];
            i += match[0].length;
            continue;
        }
        const char = String.fromCodePoint(line.codePointAt(i) as number);
        const charWidth = Bun.stringWidth(char);
        if (used + charWidth > width - 1) {
            break;
        }
        out += char;
        used += charWidth;
        i += char.length;
    }
    return `${out}${RESET}…`;
}

/**
 * Formats a duration for humans.
 */
export function duration(ms: number): string {
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}
