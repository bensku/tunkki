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
    connect(): Promise<Connection>;
}
// export type Connector = () => Connection;

export interface Connection {
    in: FileSink; // TODO type agnostic from Bun subprocess API
    out: ReadableStream<Uint8Array>;

    close: () => Promise<void>;
}

export function proxyCmd(cmd: string[], uploadCmd?: string[]): Connector {
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
        connect: async () => {
            const proc = Bun.spawn({
                cmd,
                stdin: 'pipe',
                stdout: 'pipe',
                // The subprocess won't stop otherwise???
                detached: true,
            });
            return {
                in: proc.stdin,
                out: proc.stdout,
                close: async () => {
                    proc.kill('SIGINT');
                    await proc.exited;
                },
            };
        },
    };
}

export function ssh(address: string): Connector {
    return proxyCmd(['ssh', address, '/opt/tunkki/tunkki'], [
        'sh',
        '-c',
        // ssh flattens its arguments into a single string for the remote
        // shell to re-parse, so the remote command must be one quoted word
        `ssh ${address} 'mkdir -p "$(dirname "$REMOTE_PATH")" && tee "$REMOTE_PATH" >/dev/null && chmod +x "$REMOTE_PATH"' < "$LOCAL_PATH"`,
    ]);
}
