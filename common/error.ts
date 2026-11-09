/**
 * Max number of lines of command stderr to include in error messages.
 */
const STDERR_LINES = 20;

/**
 * Formats an error for humans: messages of it and its causes, and stderr of
 * failed shell commands. Stack traces are left out; log the error itself
 * if you need them.
 */
export function formatError(e: unknown): string {
    if (!(e instanceof Error)) {
        return typeof e === 'string' ? e : Bun.inspect(e);
    }
    let msg = e.message;
    if (isShellError(e)) {
        msg = `command failed with exit code ${e.exitCode}`;
        const stderr = tail(e.stderr.toString().trim(), STDERR_LINES);
        if (stderr) {
            msg += `:\n${stderr}`;
        }
    } else if (e.name !== 'Error' && !msg.startsWith(e.name)) {
        msg = `${e.name}: ${msg}`;
    }
    if (e instanceof AggregateError) {
        for (const inner of e.errors) {
            msg += `\n- ${indent(formatError(inner), 2).trimStart()}`;
        }
    }
    if (e.cause !== undefined) {
        msg += `\ncaused by: ${formatError(e.cause)}`;
    }
    return msg;
}

function isShellError(
    e: Error,
): e is Error & { exitCode: number; stderr: Buffer } {
    return (
        e.name === 'ShellError' &&
        'exitCode' in e &&
        'stderr' in e &&
        e.stderr instanceof Buffer
    );
}

function tail(text: string, lines: number): string {
    const all = text.split('\n');
    if (all.length <= lines) {
        return text;
    }
    return [`(${all.length - lines} lines omitted)`, ...all.slice(-lines)].join(
        '\n',
    );
}

function indent(text: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    return text
        .split('\n')
        .map((line) => pad + line)
        .join('\n');
}
