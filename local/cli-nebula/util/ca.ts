import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { $ } from 'bun';
import type { CA } from '../../../task/util/nebula';
import { CliExitError } from '../parse';

export interface GenerateCAOpts {
    /** Directory containing the network.json file (CA paths are stored relative to this). */
    networkDir: string;
    /** File stem of the CA, e.g. "signing-2026-05-23". */
    name: string;
    /** Duration string accepted by nebula-cert (units: s/m/h). */
    duration: string;
}

const CAS_SUBDIR = 'cas';

export async function generateCA(opts: GenerateCAOpts): Promise<CA> {
    const casDir = path.join(opts.networkDir, CAS_SUBDIR);
    await fs.mkdir(casDir, { recursive: true });

    const crtRel = path.join(CAS_SUBDIR, `${opts.name}.crt`);
    const keyRel = path.join(CAS_SUBDIR, `${opts.name}.key`);
    const crtAbs = path.join(opts.networkDir, crtRel);
    const keyAbs = path.join(opts.networkDir, keyRel);

    for (const p of [crtAbs, keyAbs]) {
        if (await Bun.file(p).exists()) {
            throw new CliExitError(
                1,
                `CA file already exists: ${p} (pick a different --ca-name)`,
            );
        }
    }

    try {
        await $`nebula-cert ca -name ${opts.name} -duration ${opts.duration} -out-crt ${crtAbs} -out-key ${keyAbs}`.quiet();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new CliExitError(1, `nebula-cert ca failed: ${msg}`);
    }

    return { cert: crtRel, key: keyRel };
}

export interface CertInfo {
    name: string;
    notAfter: Date;
}

export async function certInfo(
    networkDir: string,
    certRelPath: string,
): Promise<CertInfo> {
    const abs = path.resolve(networkDir, certRelPath);
    let out: string;
    try {
        out = (
            await $`nebula-cert print -json -path ${abs}`.quiet()
        ).stdout.toString();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new CliExitError(
            1,
            `nebula-cert print failed for ${certRelPath}: ${msg}`,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(out);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new CliExitError(
            1,
            `cannot parse nebula-cert output for ${certRelPath}: ${msg}`,
        );
    }
    // `nebula-cert print -json` returns a one-element array (for a chain of one).
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!entry || typeof entry !== 'object') {
        throw new CliExitError(
            1,
            `unexpected nebula-cert output for ${certRelPath}`,
        );
    }
    const details = (entry as { details?: unknown }).details;
    if (!details || typeof details !== 'object') {
        throw new CliExitError(
            1,
            `no details in nebula-cert output for ${certRelPath}`,
        );
    }
    const d = details as { name?: unknown; notAfter?: unknown };
    if (typeof d.name !== 'string' || typeof d.notAfter !== 'string') {
        throw new CliExitError(
            1,
            `missing name/notAfter in cert ${certRelPath}`,
        );
    }
    return { name: d.name, notAfter: new Date(d.notAfter) };
}

export function caStem(ca: CA): string {
    return path.basename(ca.cert, path.extname(ca.cert));
}

export function sameCA(a: CA, b: CA): boolean {
    return a.cert === b.cert && a.key === b.key;
}

export const DEFAULT_CA_DURATION = '876000h';

/**
 * Picks `signing-<YYYY-MM-DD>` if no CA with that name already exists in
 * `<networkDir>/cas/`, otherwise `signing-<YYYY-MM-DD>-2`, `-3`, ... so
 * `new-ca` can be run multiple times per day without manual --ca-name.
 */
export async function defaultCaName(networkDir: string): Promise<string> {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const base = `signing-${y}-${m}-${d}`;
    if (!(await caNameTaken(networkDir, base))) return base;
    for (let n = 2; n < 1000; n++) {
        const candidate = `${base}-${n}`;
        if (!(await caNameTaken(networkDir, candidate))) return candidate;
    }
    throw new Error(`could not pick an unused CA name starting with ${base}`);
}

async function caNameTaken(networkDir: string, name: string): Promise<boolean> {
    const crt = path.join(networkDir, 'cas', `${name}.crt`);
    const key = path.join(networkDir, 'cas', `${name}.key`);
    return (await Bun.file(crt).exists()) || (await Bun.file(key).exists());
}
