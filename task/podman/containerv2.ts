import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isKnown, step } from '@bensku/tunkki/task';
import { podman, systemd } from '@bensku/tunkki/task/util';
import { $ } from 'bun';
import type { SecretRef } from './secretv2';

interface VolumeSourceBase {
    type: string;

    /**
     * Mount read-only. Ignored for secrets, which are always read-only.
     */
    readonly?: boolean;

    /**
     * Relabel the mounted content so that SELinux lets the container access
     * it. Defaults to false, because this is unsafe for system directories
     * such as /etc, /var/run, /home/$USER, etc.
     *
     * Unsupported for secrets.
     */
    selinuxRelabel?: boolean;
}

interface VolumeHostPath extends VolumeSourceBase {
    type: 'hostPath';

    /**
     * Path on host.
     */
    path: string;

    /**
     * If true, create directory if the host path does not exist.
     */
    createDir?: boolean;
}

export interface VolumeUploadFile extends VolumeSourceBase {
    type: 'uploadFile';

    /**
     * Local path to read from.
     */
    localPath: string;

    /**
     * Hash of file content BEFORE applying template to it.
     * Filled by wrapper before calls ever reach us!
     */
    hash: string;

    /**
     * envsubst-style replacements for the local file content. Both `$KEY`
     * and `${KEY}` are replaced; variables not listed here are left as-is.
     */
    template?: Record<string, string>;
}

interface VolumeWriteFile extends VolumeSourceBase {
    type: 'writeFile';

    /**
     * Text to write as UTF-8.
     */
    data: string;
}

interface VolumeSecret extends VolumeSourceBase {
    type: 'secret';

    /**
     * Reference to a Podman secret. See podman.secretv2().
     */
    ref: SecretRef;
}

export type VolumeSource =
    | VolumeHostPath
    | VolumeUploadFile
    | VolumeWriteFile
    | VolumeSecret;

export interface Port {
    /**
     * Host IP address to bind to. Defaults to all addresses.
     */
    host?: string;
    hostPort: number;
    containerPort: number;
    protocol?: 'tcp' | 'udp';
}

export type HealthCheck = (
    | {
          /**
           * Send HTTP GET to the container, and consider 2xx and 3xx
           * responses healthy.
           */
          type: 'http';

          /**
           * Port the server listens on inside the container. The probe
           * connects to 127.0.0.1, or ::1 if nothing listens on IPv4.
           */
          port: number;

          /**
           * Path to request. Defaults to `/`.
           */
          path?: string;
      }
    | {
          /**
           * Run a command inside the container. Exit code 0 means healthy.
           */
          type: 'cmd';

          /**
           * Command to run. It is executed directly, not through a shell.
           */
          cmd: string[];
      }
) & {
    /**
     * How often the health check will run once the container is up, in
     * seconds. Defaults to 30.
     */
    interval?: number;

    /**
     * How long the container may take to become healthy after it starts,
     * in seconds. Until then, the health check runs every second. Starting
     * or deploying the container fails if it is not healthy by then.
     * Defaults to 120.
     */
    startPeriod?: number;

    /**
     * How many times in a row the health check may fail before the container
     * is killed and restarted. Defaults to 3.
     */
    retries?: number;

    /**
     * Timeout for each health check, in seconds. Defaults to 5.
     */
    timeout?: number;
};

export interface Input {
    /**
     * Name of the Podman container. Must be unique within host.
     * This is also name of the Quadlet systemd service.
     */
    name: string;

    /**
     * Image to run, including its tag. Podman will not re-pull
     * if the image behind the same tag changes.
     */
    image: string;

    /**
     * Override CMD of the container.
     */
    cmd?: string[];

    /**
     * Override ENTRYPOINT of the container.
     */
    entrypoint?: string[];

    /**
     * Environment variables for the container.
     */
    env?: Record<string, string>;

    /**
     * Secrets to add as environment variables to the container.
     */
    secrets?: Record<string, SecretRef>;

    /**
     * Volume mounts for the container. Target->source.
     */
    volumes?: Record<string, VolumeSource>;

    /**
     * User name or id to run the container as.
     */
    user?: string | number;

    /**
     * Group name or id to run the container as.
     */
    group?: string | number;

    /**
     * Override for container's hostname. Without this, Podman generates it.
     */
    hostname?: string;

    /**
     * Podman networks to join.
     */
    networks?: string[];

    /**
     * Ports to expose to bridge networks. Note that Nebula is not a bridge!
     */
    ports?: Port[];

    /**
     * Container runtime id, such as runc, krun, crun-vm, etc.
     */
    runtime?: string;

    /**
     * Additional Podman arguments, in case containerv2 does not support
     * something you need.
     */
    podmanArgs?: string[];

    /**
     * Healthcheck for the container. When set, starting the container
     * (and thus deploying it) waits until it is healthy.
     */
    healthCheck?: HealthCheck;
}

/**
 * Where Quadlet looks for units of system services.
 */
const UNIT_DIR = '/etc/containers/systemd';

/**
 * Files tunkki writes for containers, one directory per container.
 */
const DATA_DIR = '/var/lib/tunkki/containers';

/**
 * Where install-agent puts the HTTP health probe on host.
 */
export const PROBE_HOST_PATH = '/opt/tunkki/healthprobe';

/**
 * Where the HTTP health probe is mounted in containers.
 */
const PROBE_CONTAINER_PATH = '/run/tunkki-healthprobe';

/**
 * Start-up health checks run this often, so that deploys need not wait for
 * the full interval when the container is not healthy on the first try.
 */
const STARTUP_INTERVAL = 1;

const HEALTH_DEFAULTS = {
    interval: 30,
    startPeriod: 120,
    retries: 3,
    timeout: 5,
};

function unitPath(name: string): string {
    return path.join(UNIT_DIR, `${name}.container`);
}

function dataDir(name: string): string {
    return path.join(DATA_DIR, name);
}

/**
 * Host path of a file that tunkki writes for a container. It must not
 * contain `%`, which systemd would treat as a specifier.
 */
export function hostFilePath(name: string, target: string): string {
    const hash = Bun.CryptoHasher.hash('sha256', target, 'hex').slice(0, 16);
    const base = path.basename(target).replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(dataDir(name), 'files', `${hash}-${base}`);
}

/**
 * Applies envsubst-style replacements to text. Only variables in vars are
 * replaced.
 */
export function applyTemplate(
    text: string,
    vars: Record<string, string>,
): string {
    const names = Object.keys(vars);
    if (names.length === 0) {
        return text;
    }
    const alternatives = names
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const pattern = new RegExp(
        `\\$\\{(${alternatives})\\}|\\$(${alternatives})(?![A-Za-z0-9_])`,
        'g',
    );
    return text.replace(
        pattern,
        (_, braced: string | undefined, bare: string | undefined) =>
            vars[(braced ?? bare) as string] as string,
    );
}

function checkPath(what: string, value: string) {
    if (!isKnown(value)) {
        return;
    }
    if (!value.startsWith('/')) {
        throw new Error(`${what} must be an absolute path, got ${value}`);
    }
    if (/[:,\n]/.test(value)) {
        throw new Error(`${what} must not contain ':', ',' or newlines`);
    }
}

function checkPort(what: string, value: number) {
    if (
        isKnown(value) &&
        !(Number.isInteger(value) && value > 0 && value < 65536)
    ) {
        throw new Error(`${what} must be a port number, got ${value}`);
    }
}

/**
 * Checks input for mistakes that would otherwise only show up when the
 * container fails to start. Values that come from outputs of other tasks are
 * skipped when they are not yet known.
 */
export function validate(input: Input) {
    const name = input.name;
    if (isKnown(name) && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
        throw new Error(
            `invalid container name ${name}; use letters, numbers, '_', '.' and '-'`,
        );
    }
    if (input.group !== undefined && input.user === undefined) {
        throw new Error('group requires user to be set, too');
    }
    for (const key of Object.keys(input.secrets ?? {})) {
        if (input.env && key in input.env) {
            throw new Error(
                `${key} is set both as environment variable and as secret`,
            );
        }
    }
    for (const key of [
        ...Object.keys(input.env ?? {}),
        ...Object.keys(input.secrets ?? {}),
    ]) {
        if (key === '' || key.includes('=')) {
            throw new Error(`invalid environment variable name '${key}'`);
        }
    }
    for (const [target, source] of Object.entries(input.volumes ?? {})) {
        checkPath('volume target', target);
        if (source.type === 'hostPath') {
            checkPath(`host path of volume ${target}`, source.path);
        }
    }
    for (const port of input.ports ?? []) {
        checkPort('hostPort', port.hostPort);
        checkPort('containerPort', port.containerPort);
    }
    const health = input.healthCheck;
    if (health?.type === 'http') {
        checkPort('health check port', health.port);
        const p = health.path;
        if (
            p !== undefined &&
            isKnown(p) &&
            (!p.startsWith('/') || /\s/.test(p))
        ) {
            throw new Error(
                `health check path must start with '/' and have no whitespace, got ${p}`,
            );
        }
    }
}

function renderPort(port: Port): string {
    const host = port.host?.includes(':') ? `[${port.host}]` : port.host;
    const spec = `${port.hostPort}:${port.containerPort}`;
    const withHost = host ? `${host}:${spec}` : spec;
    return port.protocol ? `${withHost}/${port.protocol}` : withHost;
}

function renderVolume(
    name: string,
    target: string,
    source: Exclude<VolumeSource, VolumeSecret>,
): string {
    const relabel = source.selinuxRelabel ?? false;
    const options: string[] = [];
    if (source.readonly) {
        options.push('ro');
    }
    let hostPath: string;
    if (source.type === 'hostPath') {
        hostPath = source.path;
        if (relabel) {
            options.push('z');
        }
    } else {
        hostPath = hostFilePath(name, target);
        if (relabel) {
            options.push('Z');
        }
    }
    const spec = `${hostPath}:${target}`;
    return systemd.escapeValue(
        options.length > 0 ? `${spec}:${options.join(',')}` : spec,
    );
}

/**
 * Renders the Quadlet unit of a container.
 */
export function toUnitFile(input: Input): systemd.UnitFile {
    const environment: string[] = Object.entries(input.env ?? {}).map(
        ([key, value]) =>
            systemd.quoteWord(systemd.escapeValue(`${key}=${value}`)),
    );
    const secrets: string[] = Object.entries(input.secrets ?? {}).map(
        ([key, ref]) => `${ref.podmanId},type=env,target=${key}`,
    );
    const volumes: string[] = [];
    for (const [target, source] of Object.entries(input.volumes ?? {})) {
        if (source.type === 'secret') {
            secrets.push(
                `${source.ref.podmanId},type=mount,target=${systemd.escapeValue(target)}`,
            );
        } else {
            volumes.push(renderVolume(input.name, target, source));
        }
    }

    const podmanArgs = [...(input.podmanArgs ?? [])];
    if (input.runtime) {
        podmanArgs.unshift(`--runtime=${input.runtime}`);
    }

    const container: Record<string, systemd.UnitValue> = {
        ContainerName: input.name,
        Image: systemd.escapeValue(input.image),
        Exec: input.cmd ? systemd.renderWords(input.cmd) : undefined,
        Entrypoint: input.entrypoint
            ? podman.execForm(input.entrypoint)
            : undefined,
        Environment: environment,
        Secret: secrets,
        Volume: volumes,
        User:
            input.user !== undefined
                ? systemd.escapeValue(input.user)
                : undefined,
        Group:
            input.group !== undefined
                ? systemd.escapeValue(input.group)
                : undefined,
        HostName:
            input.hostname !== undefined
                ? systemd.escapeValue(input.hostname)
                : undefined,
        Network: input.networks?.map(systemd.escapeValue),
        PublishPort: input.ports?.map(renderPort),
        PodmanArgs:
            podmanArgs.length > 0 ? systemd.renderWords(podmanArgs) : undefined,
    };
    const service: Record<string, systemd.UnitValue> = {
        ...podman.SERVICE_DEFAULTS,
    };

    const health = input.healthCheck;
    if (health) {
        const h = { ...HEALTH_DEFAULTS, ...definedOnly(health) };
        let cmd: string[];
        if (health.type === 'http') {
            cmd = [
                PROBE_CONTAINER_PATH,
                String(health.port),
                health.path ?? '/',
            ];
            volumes.push(`${PROBE_HOST_PATH}:${PROBE_CONTAINER_PATH}:ro,z`);
        } else {
            cmd = health.cmd;
        }
        Object.assign(container, {
            HealthCmd: podman.execForm(cmd),
            HealthInterval: `${h.interval}s`,
            HealthTimeout: `${h.timeout}s`,
            HealthRetries: h.retries,
            HealthOnFailure: 'kill',
            // Podman runs the regular check only once per interval. Startup
            // check runs often until it first succeeds, so that the container
            // becomes healthy soon after it is ready.
            HealthStartupCmd: podman.execForm(cmd),
            HealthStartupInterval: `${STARTUP_INTERVAL}s`,
            HealthStartupTimeout: `${h.timeout}s`,
            // Systemd waits for container to become healthy before it
            // considers it started
            Notify: 'healthy',
        });
        // ... but not forever. When this expires, systemd stops the container
        // and restarts it later. The image is pulled before the start, so
        // that does not count towards this.
        service.TimeoutStartSec = h.startPeriod;
    }

    const unit: Record<string, systemd.UnitValue> = {
        ...podman.UNIT_DEFAULTS,
    };
    if (input.networks?.includes('nebula')) {
        // nebula-netavark plugin needs its daemon
        unit.Wants = 'nebula-netavarkd.service';
        unit.After = 'nebula-netavarkd.service';
    }

    return {
        Unit: unit,
        Container: container,
        Service: service,
        Install: { WantedBy: 'multi-user.target' },
    };
}

function definedOnly<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== undefined),
    ) as Partial<T>;
}

interface RemoteState {
    input: Input;

    /**
     * Contents of files tunkki writes for the container, by volume target.
     */
    files: Record<string, Uint8Array>;

    /**
     * If the container was renamed, its old name. The old container is
     * removed before the new one starts, since they might e.g. use the same
     * ports.
     */
    oldName?: string;
}

/**
 * Stops a container and removes everything tunkki created for it.
 */
async function remove(name: string) {
    // Not loaded at all if e.g. the unit was removed outside tunkki
    await $`systemctl stop ${`${name}.service`}`.nothrow().quiet();
    await fs.rm(unitPath(name), { force: true });
    await $`systemctl daemon-reload`.quiet();
    await fs.rm(dataDir(name), { recursive: true, force: true });
}

const QUADLET_PATHS = [
    '/usr/libexec/podman/quadlet',
    '/usr/lib/podman/quadlet',
];

/**
 * Checks that Quadlet can convert a unit. Otherwise, systemd would only
 * report that the service does not exist.
 */
async function checkUnit(name: string, unit: string) {
    let quadlet: string | undefined;
    for (const candidate of QUADLET_PATHS) {
        if (await Bun.file(candidate).exists()) {
            quadlet = candidate;
            break;
        }
    }
    if (!quadlet) {
        return; // Can't check, systemd will complain later
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunkki-quadlet-'));
    try {
        await Bun.write(path.join(dir, `${name}.container`), unit);
        const result = await $`${quadlet} -dryrun`
            .env({ ...process.env, QUADLET_UNIT_DIRS: dir })
            .nothrow()
            .quiet();
        if (result.exitCode !== 0) {
            const errors = result.stderr
                .toString()
                .split('\n')
                .map((line) => line.replace(/^quadlet-generator\[\d+\]: /, ''))
                .filter((line) => line && !line.startsWith('Loading source'));
            throw new Error(
                `Quadlet rejected container ${name}: ${errors.join('; ')}`,
            );
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

/**
 * Writes files of the container, and removes ones that are no longer used.
 */
async function writeFiles(name: string, files: Record<string, Uint8Array>) {
    const dir = path.join(dataDir(name), 'files');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Content may be private, but containers access it through bind mounts
    await fs.chmod(dataDir(name), 0o700);

    const wanted = new Set<string>();
    for (const [target, data] of Object.entries(files)) {
        const file = hostFilePath(name, target);
        wanted.add(path.basename(file));
        // Atomic replace; the container is restarted anyway to see it
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, data, { mode: 0o644 });
        await fs.chmod(tmp, 0o644);
        await fs.rename(tmp, file);
    }
    for (const entry of await fs.readdir(dir)) {
        if (!wanted.has(entry)) {
            await fs.rm(path.join(dir, entry), { force: true });
        }
    }
}

export const apply = [
    step<Input, RemoteState>('local', async (input, _, oldState) => {
        validate(input);
        const files: Record<string, Uint8Array> = {};
        for (const [target, source] of Object.entries(input.volumes ?? {})) {
            if (source.type === 'uploadFile') {
                const data = await Bun.file(source.localPath).bytes();
                files[target] = source.template
                    ? new TextEncoder().encode(
                          applyTemplate(
                              new TextDecoder().decode(data),
                              source.template,
                          ),
                      )
                    : data;
            } else if (source.type === 'writeFile') {
                files[target] = new TextEncoder().encode(source.data);
            }
        }
        return {
            input,
            files,
            oldName:
                oldState && oldState.name !== input.name
                    ? oldState.name
                    : undefined,
        };
    }),
    step<RemoteState>('remote', async ({ input, files, oldName }) => {
        if (
            input.healthCheck?.type === 'http' &&
            !(await Bun.file(PROBE_HOST_PATH).exists())
        ) {
            throw new Error(
                `HTTP health probe is missing from ${PROBE_HOST_PATH}, run install-agent to install it`,
            );
        }
        // Check before touching anything, so that the old container keeps
        // running if this fails
        const unit = systemd.serializeUnitFile(toUnitFile(input));
        await checkUnit(input.name, unit);

        // Pull before starting, so that a slow pull does not count towards
        // start timeout. Images that exist are not checked for updates, like
        // Podman does by default.
        const exists = await $`podman image exists ${input.image}`
            .nothrow()
            .quiet();
        if (exists.exitCode !== 0) {
            await $`podman pull ${input.image}`.quiet();
        }

        if (oldName) {
            await remove(oldName);
        }
        for (const source of Object.values(input.volumes ?? {})) {
            if (source.type === 'hostPath' && source.createDir) {
                await fs.mkdir(source.path, { recursive: true });
            }
        }
        await writeFiles(input.name, files);

        await fs.mkdir(UNIT_DIR, { recursive: true });
        await Bun.write(unitPath(input.name), unit);
        await $`systemctl daemon-reload`.quiet();
        await $`systemctl restart ${`${input.name}.service`}`.quiet();
    }),
];

export const cleanup = async (input: Input) => {
    await remove(input.name);
};
