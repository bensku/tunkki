import * as tunkkiTask from '@bensku/tunkki/task';
import * as taskUtil from '@bensku/tunkki/task/util';
import { readEvents, writeEvent } from '../common/event';
import { Runner } from './runner';

// Make @bensku/tunkki/task resolvable for dynamically imported handler files
Bun.plugin({
    name: 'tunkki-task',
    setup(build) {
        build.module('@bensku/tunkki/task', () => ({
            exports: tunkkiTask,
            loader: 'object',
        }));
        build.module('@bensku/tunkki/task/util', () => ({
            exports: taskUtil,
            loader: 'object',
        }));
    },
});

if (Bun.argv[2] === 'runner') {
    // We are subprocess of the SSH entrypoint. Our stdout is safe to print to, though discarded
    const runner = new Runner();
    for await (const event of readEvents(Bun.stdin.stream())) {
        try {
            await runner.handleEvent(event);
        } catch (e) {
            // Unhandler error. We're going to crash, but before that, tell local side why
            process.send!(writeEvent({ type: 'fatal', error: Bun.inspect(e) }));
        }
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
    try {
        for await (const chunk of Bun.stdin.stream()) {
            await runner.stdin.write(chunk);
        }
    } finally {
        // Cleanup must happen even if the loop throws (e.g. runner died early)
        await runner.stdin.end();
        await logDrain;
    }
}
