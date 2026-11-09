import { formatError } from '../common/error';
import { CURRENT_PROTOCOL, type Event } from '../common/event';
import { log, setupLogger } from '../common/log';
import { openSession, type Session } from './session';
import { stateDir as defaultStateDir, loadState } from './state';
import type { Reply } from './util';

/**
 * Serves local until the event stream ends.
 * @param events Events from local.
 * @param reply Sends an event to local.
 * @param stateDir State directory of a stack.
 */
export async function serve(
    events: AsyncIterable<Event>,
    reply: Reply,
    stateDir: (stack: string) => string = defaultStateDir,
) {
    reply({ type: 'hello', protocol: CURRENT_PROTOCOL });

    const sessions = new Map<string, Session>();
    const pending = new Set<Promise<void>>();

    const handle = async (event: Event) => {
        switch (event.type) {
            case 'settings':
                setupLogger((msg) => console.error(...msg.msg), event.logLevel);
                break;
            case 'plan':
                reply(await planResult(event.stack, stateDir(event.stack)));
                break;
            case 'openSession': {
                let error: string | undefined;
                try {
                    const session = await openSession(
                        {
                            id: event.session,
                            stateDir: stateDir(event.stack),
                            concurrency: event.concurrency,
                            reply,
                        },
                        event.stateHash,
                    );
                    sessions.set(event.session, session);
                    log.info('opened session', 'stack', event.stack);
                } catch (e) {
                    error = formatError(e);
                }
                reply({ type: 'ready', session: event.session, error });
                break;
            }
            case 'loadHandlers':
                await sessionOf(event.session).loadHandlers(event.handlers);
                break;
            case 'run':
                sessionOf(event.session).run(event);
                break;
            case 'commit':
                sessionOf(event.session).commit(event.id, event.record);
                break;
            case 'closeSession':
                await sessionOf(event.session).close();
                sessions.delete(event.session);
                break;
            default:
                throw new Error(`unexpected event ${event.type}`);
        }
    };

    const sessionOf = (id: string) => {
        const session = sessions.get(id);
        if (!session) {
            throw new Error(`unknown session ${id}`);
        }
        return session;
    };

    // Don't await handlers here; runs must proceed concurrently
    for await (const event of events) {
        log.debug('local->remote', 'event', event);
        const promise = handle(event)
            .catch((e) => log.error('failed to handle event', event.type, e))
            .finally(() => pending.delete(promise));
        pending.add(promise);
    }
    await Promise.all(pending);
}

async function planResult(
    stack: string,
    dir: string,
): Promise<Extract<Event, { type: 'planResult' }>> {
    try {
        const state = await loadState(dir);
        return {
            type: 'planResult',
            stack,
            tasks: state.records,
            stateHash: state.hash,
        };
    } catch (e) {
        return {
            type: 'planResult',
            stack,
            tasks: {},
            stateHash: '',
            error: formatError(e),
        };
    }
}
