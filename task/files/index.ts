import * as fs from 'node:fs';
import { type Output, type TaskType, taskType } from '@bensku/tunkki/task';
import type { State as PutState } from './put';

const putImpl = taskType<PutState, Output>(
    'files.put',
    import.meta.resolve('./put'),
);

interface PutInputBase {
    /**
     * Remote path where the upload should be placed to.
     */
    remotePath: string;

    /**
     * Mode for the remote file, e.g. 0o700.
     */
    mode?: number;

    /**
     * User who should own the remote file.
     */
    user?: string | number;

    /**
     * Group who should own the remote file.
     */
    group?: string | number;
}

interface UploadLocalFile extends PutInputBase {
    /**
     * Local path the uploaded file should be read from.
     */
    localPath: string;

    content?: never;
}

interface WriteData extends PutInputBase {
    /**
     * Data to write to remote. If string, it is encoded as utf-8. If it is
     * object, it is encoded as JSON that is encoded as utf-8.
     */
    content: string | Uint8Array | object;

    localPath?: never;
}

export type PutInput = UploadLocalFile | WriteData;

export const put: TaskType<PutInput, Output> = (id, input, opts) => {
    // Hash the local file so that remote can check if it changed BEFORE we upload it
    // TODO streaming hash, don't read entire file in memory
    const hasher = new Bun.CryptoHasher('sha256');
    if (input.localPath) {
        hasher.update(fs.readFileSync(input.localPath)); // TODO make this async somehow
    } else if (typeof input.content === 'string') {
        hasher.update(input.content);
    }
    const checksum = hasher.digest('hex');

    // Return task type that actually handles the uploading
    return putImpl(
        id,
        {
            // FIXME if content is provided instead of local path, we're always uploading it during plan
            // Fine for small files, not fine for anything larger
            ...input,
            checksum,
        },
        opts,
    );
};
