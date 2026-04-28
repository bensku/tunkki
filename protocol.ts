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
                            .replace('$LOCAL_PATH', localPath)
                            .replace('$REMOTE_PATH', remotePath),
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

// TODO ssh etc.
