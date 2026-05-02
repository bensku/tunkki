export const log = {
    error: (...msg: unknown[]) => {
        logFn({ level: 2, msg });
    },
    info: (...msg: unknown[]) => {
        logFn({ level: 1, msg });
    },
    debug: (...msg: unknown[]) => {
        logFn({ level: 0, msg });
    },
};

function logFn(event: Message) {
    if (LOGGER && event.level >= LOG_LEVEL) {
        LOGGER(event);
    }
}

export interface Message {
    level: 0 | 1 | 2;
    msg: unknown[];
}

type Logger = (msg: Message) => void;
let LOGGER: Logger | undefined;
export let LOG_LEVEL = parseInt(process.env.TUNKKI_LOG_LEVEL ?? '2', 10);

export function setupLogger(logger: Logger, logLevel: number) {
    LOGGER = logger;
    LOG_LEVEL = logLevel;
}
