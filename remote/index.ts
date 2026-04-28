import * as tunkkiTask from '@bensku/tunkki/task';
import { readEvents } from '../common/event';
import { Runner } from './runner';

// Make @bensku/tunkki/task resolvable for dynamically imported handler files
Bun.plugin({
    name: 'tunkki-task',
    setup(build) {
        build.module('@bensku/tunkki/task', () => ({
            exports: tunkkiTask,
            loader: 'object',
        }));
    },
});

if (Bun.argv[2] === 'runner') {
    // We are subprocess of the SSH entrypoint. Our stdout is safe to print to, though discarded
    const runner = new Runner(
        '/opt/tunkki',
        4,
        process.env.TUNKKI_DEBUG === 'true',
    );
    await runner.loadState();
    for await (const event of readEvents(Bun.stdin.stream())) {
        await runner.handleEvent(event);
    }
    // Sever the IPC channel; otherwise it keeps the event loop ref'd
    // and the runner hangs around until the parent SIGTERMs it.
    process.disconnect?.();
} else {
    // We are the SSH entrypoint
    // Run tasks in subprocess, because they might produce stdout/stderr
    // that must not enter our communication channel (that likewise uses stdout/stdin)
    const runner = Bun.spawn(['/opt/tunkki/tunkki', 'runner'], {
        ipc: (event) => {
            // Tasks send us entire events, forward them to local over stdout
            Bun.stdout.write(event);
        },
        stdout: 'ignore',
        stderr: 'pipe',
        stdin: 'pipe',
        env: {
            TUNKKI_DEBUG: Bun.argv[2] === '--debug' ? 'true' : undefined,
        },
    });
    // Stream stderr to log file in background
    const logFile = Bun.file('/var/log/tunkki.log').writer();
    const logDrain = (async () => {
        for await (const chunk of runner.stderr) {
            logFile.write(chunk);
            logFile.flush();
        }
        await logFile.end();
    })();

    // We send tasks raw stdin stream to avoid paying for deserialization twice.
    // Cleanup must happen even if the loop throws (e.g. runner died early),
    // otherwise the runner subprocess refs the event loop and the entrypoint
    // hangs around forever.
    try {
        for await (const chunk of Bun.stdin.stream()) {
            await runner.stdin.write(chunk);
        }
    } finally {
        await runner.stdin.end();
        await logDrain;
    }
}
