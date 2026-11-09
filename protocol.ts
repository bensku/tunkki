import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FileSink } from 'bun';

export interface Connector {
    /**
     * Uploads a file to remote from local disk.
     * This is used for bootstrapping remote,
     * return false if your connector does not support upload.
     */
    upload: (localPath: string, remotePath: string) => Promise<boolean>;

    /**
     * Connects to the remote agent.
     */
    connect(opts?: ConnectOptions): Promise<Connection>;
}

export interface ConnectOptions {
    /**
     * Receives what the transport itself prints, e.g. SSH errors, line by
     * line. Called until the connection is closed.
     */
    onMessage?: (line: string) => void;

    /**
     * Receives requests for the user to do something, e.g. to touch their
     * security key.
     */
    onPrompt?: (prompt: string) => void;
}

export interface Connection {
    in: FileSink; // TODO type agnostic from Bun subprocess API
    out: ReadableStream<Uint8Array>;

    close: () => Promise<void>;

    /**
     * Resolves once the transport has authenticated and the agent is
     * starting. Rejects if the transport fails before that. Without this,
     * the connection counts as authenticated as soon as it is made.
     *
     * Authentication may need the user, so it can take arbitrarily long.
     */
    authenticated?: Promise<void>;
}

export interface ProxyOptions {
    /**
     * Line the command prints to stderr once it has authenticated. Without
     * it, the connection counts as authenticated right away.
     */
    authMarker?: string;

    /**
     * Extra environment variables for the command.
     */
    env?: () => Record<string, string>;
}

/**
 * Prefix of lines that the askpass helper prints to stderr. The rest of the
 * line is the prompt.
 */
const PROMPT_PREFIX = 'tunkki-askpass: ';

/**
 * How many lines of stderr are kept for error messages.
 */
const KEPT_LINES = 10;

export function proxyCmd(
    cmd: string[],
    uploadCmd?: string[],
    options: ProxyOptions = {},
): Connector {
    return {
        upload: async (localPath, remotePath) => {
            if (uploadCmd) {
                const proc = Bun.spawn({
                    cmd: uploadCmd.map((part) =>
                        part
                            .replaceAll('$LOCAL_PATH', localPath)
                            .replaceAll('$REMOTE_PATH', remotePath),
                    ),
                });
                await proc.exited;
                if (proc.exitCode !== 0) {
                    throw new Error('upload failed');
                }
                return true;
            }
            return false;
        },
        connect: async (opts = {}) => {
            const extraEnv = options.env?.();
            const proc = Bun.spawn({
                cmd,
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
                env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
                // The subprocess won't stop otherwise???
                detached: true,
            });

            let closed = false;
            let authenticated = options.authMarker === undefined;
            const recent: string[] = [];
            let resolveAuth = () => {};
            let rejectAuth = (_: Error) => {};
            const authPromise = authenticated
                ? undefined
                : new Promise<void>((resolve, reject) => {
                      resolveAuth = resolve;
                      rejectAuth = reject;
                  });
            // Nobody might be waiting when the command fails
            authPromise?.catch(() => {});

            const drained = (async () => {
                for await (const line of readLines(proc.stderr)) {
                    if (!authenticated && line === options.authMarker) {
                        authenticated = true;
                        resolveAuth();
                    } else if (line.startsWith(PROMPT_PREFIX)) {
                        opts.onPrompt?.(line.slice(PROMPT_PREFIX.length));
                    } else if (line.trim() !== '') {
                        recent.push(line);
                        if (recent.length > KEPT_LINES) {
                            recent.shift();
                        }
                        if (!closed) {
                            opts.onMessage?.(line);
                        }
                    }
                }
            })().catch(() => {});
            proc.exited.then(async (code) => {
                if (authenticated) {
                    return;
                }
                // Something else, e.g. an SSH control master, might keep
                // stderr open after the process has exited
                await Promise.race([drained, Bun.sleep(200)]);
                rejectAuth(
                    new Error(
                        recent.length > 0
                            ? recent.join('\n')
                            : `${cmd[0]} exited with code ${code}`,
                    ),
                );
            });

            return {
                in: proc.stdin,
                out: proc.stdout,
                authenticated: authPromise,
                close: async () => {
                    closed = true;
                    proc.kill('SIGINT');
                    await proc.exited;
                },
            };
        },
    };
}

/**
 * Line that the remote shell prints once SSH has authenticated.
 */
const SSH_AUTH_MARKER = 'tunkki-authenticated';

export interface SshOptions {
    /**
     * Extra arguments for ssh, e.g. `['-p', '2222']`.
     */
    args?: string[];
}

export function ssh(address: string, opts: SshOptions = {}): Connector {
    const args = opts.args ?? [];
    return proxyCmd(
        [
            'ssh',
            ...args,
            address,
            // Run by the remote user's shell
            `echo ${SSH_AUTH_MARKER} >&2; exec /opt/tunkki/tunkki`,
        ],
        [
            'sh',
            '-c',
            // ssh flattens its arguments into a single string for the remote
            // shell to re-parse, so the remote command must be one quoted word
            `ssh ${args.map(shellQuote).join(' ')} ${address} 'mkdir -p "$(dirname "$REMOTE_PATH")" && tee "$REMOTE_PATH" >/dev/null && chmod +x "$REMOTE_PATH"' < "$LOCAL_PATH"`,
        ],
        { authMarker: SSH_AUTH_MARKER, env: askpassEnv },
    );
}

function shellQuote(arg: string): string {
    return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Askpass helper that reports notifications, such as OpenSSH asking the user
 * to touch their security key, back to proxyCmd on stderr. Other prompts,
 * e.g. for passphrases, go to the askpass program that would otherwise have
 * been used.
 *
 * OpenSSH only prints notifications itself when its stderr is a terminal,
 * which it isn't, because we capture it.
 */
const ASKPASS_SCRIPT = `#!/bin/sh
if [ "$SSH_ASKPASS_PROMPT" = none ]; then
    printf '${PROMPT_PREFIX}%s\\n' "$1" >&2
    exit 0
fi
if [ -n "$TUNKKI_ASKPASS" ]; then
    exec "$TUNKKI_ASKPASS" "$@"
fi
for p in /usr/libexec/ssh/ssh-askpass /usr/lib/ssh/ssh-askpass \\
    /usr/libexec/openssh/ssh-askpass /usr/bin/ssh-askpass \\
    /usr/X11R6/bin/ssh-askpass; do
    if [ -x "$p" ]; then
        exec "$p" "$@"
    fi
done
exit 1
`;

let askpassPath: string | null | undefined;

/**
 * Environment that makes ssh use the askpass helper.
 */
function askpassEnv(): Record<string, string> {
    if (process.env.SSH_ASKPASS_REQUIRE === 'never') {
        return {};
    }
    if (askpassPath === undefined) {
        askpassPath = installAskpass();
    }
    if (askpassPath === null) {
        return {};
    }
    const env: Record<string, string> = {
        SSH_ASKPASS: askpassPath,
        SSH_ASKPASS_REQUIRE: 'force',
    };
    if (process.env.SSH_ASKPASS) {
        env.TUNKKI_ASKPASS = process.env.SSH_ASKPASS;
    }
    return env;
}

function installAskpass(): string | null {
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunkki-'));
        const file = path.join(dir, 'askpass');
        fs.writeFileSync(file, ASKPASS_SCRIPT, { mode: 0o700 });
        process.on('exit', () => {
            fs.rmSync(dir, { recursive: true, force: true });
        });
        return file;
    } catch {
        // Without it, ssh just won't tell us about prompts
        return null;
    }
}

async function* readLines(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
            yield buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
        }
    }
    if (buffer !== '') {
        yield buffer;
    }
}
