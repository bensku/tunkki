import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeColor } from '../colors';
import { err, out, printJson } from '../output';
import type { CliContext } from './plan';

/**
 * Locate the bundled agent binary. Resolved against the package's own
 * `package.json` so it works when this code is consumed as a library
 * (`node_modules/@bensku/tunkki/tunkki`) and survives bundling — neither of
 * which a `${import.meta.dir}/../../../tunkki` style path tolerates.
 */
function resolveAgentPath(): string {
    const pkgUrl = import.meta.resolve('@bensku/tunkki/package.json');
    const pkgRoot = dirname(fileURLToPath(pkgUrl));
    return join(pkgRoot, 'tunkki');
}

export async function run(ctx: CliContext): Promise<number> {
    if (ctx.hosts.length === 0) {
        err('no hosts match --target');
        return 2;
    }

    const localPath = resolveAgentPath();
    const remotePath = '/opt/tunkki/tunkki';

    const flags = ctx.cli.flags;
    const c = makeColor(flags.color);
    const results: { host: string; ok: boolean; error?: string }[] = [];

    for (const host of ctx.hosts) {
        try {
            const ok = await host.conn.upload(localPath, remotePath);
            if (ok) {
                results.push({ host: host.id, ok: true });
                if (!flags.json) {
                    out(
                        `${c.dim(`[${host.id}]`)} ${c.green('✓')} installed agent at ${remotePath}`,
                    );
                }
            } else {
                const msg = 'transport does not support upload';
                results.push({ host: host.id, ok: false, error: msg });
                if (!flags.json) {
                    out(
                        `${c.dim(`[${host.id}]`)} ${c.red('✗')} FAILED: ${msg}`,
                    );
                }
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            results.push({ host: host.id, ok: false, error: msg });
            if (!flags.json) {
                out(`${c.dim(`[${host.id}]`)} ${c.red('✗')} FAILED: ${msg}`);
            }
        }
    }

    if (flags.json) {
        printJson({ results });
    }

    return results.every((r) => r.ok) ? 0 : 1;
}
