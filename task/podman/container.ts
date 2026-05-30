import { step } from '@bensku/tunkki/task';
import { podman, systemd } from '@bensku/tunkki/task/util';
import { $ } from 'bun';

/** Structured `Tmpfs=` entry. */
export type TmpfsEntry = {
    /** Mount target inside the container. */
    target: string;
    /** Mount options such as `size=64m`, `mode=0700`. Joined with commas. */
    options?: string[];
};

export type TmpfsSpec = string | TmpfsEntry | (string | TmpfsEntry)[];

function renderTmpfsOne(t: string | TmpfsEntry): string {
    if (typeof t === 'string') return t;
    return t.options && t.options.length > 0
        ? `${t.target}:${t.options.join(',')}`
        : t.target;
}

export function renderTmpfs(
    input: TmpfsSpec | undefined,
): string[] | undefined {
    if (input === undefined) return undefined;
    const entries = Array.isArray(input) ? input : [input];
    return entries.map(renderTmpfsOne);
}

/** Structured `AddDevice=` entry. */
export type AddDeviceEntry = {
    /** Host device path, e.g. `/dev/kvm`. */
    host: string;
    /** Path inside the container. Defaults to {@link host}. */
    container?: string;
    /** Cgroup permissions: any combination of `r`, `w`, `m`. */
    permissions?: string;
};

export type AddDeviceSpec =
    | string
    | AddDeviceEntry
    | (string | AddDeviceEntry)[];

function renderAddDeviceOne(d: string | AddDeviceEntry): string {
    if (typeof d === 'string') return d;
    let s = d.host;
    if (d.container !== undefined || d.permissions !== undefined) {
        s += `:${d.container ?? d.host}`;
    }
    if (d.permissions !== undefined) s += `:${d.permissions}`;
    return s;
}

export function renderAddDevice(
    input: AddDeviceSpec | undefined,
): string[] | undefined {
    if (input === undefined) return undefined;
    const entries = Array.isArray(input) ? input : [input];
    return entries.map(renderAddDeviceOne);
}

/**
 * Healthcheck configuration for a container, mapped to the `Health*=`
 * directives of the `[Container]` section in podman-systemd.unit(5).
 *
 * If the container image already declares a `HEALTHCHECK`, only the fields you
 * set here override it; otherwise no healthcheck runs unless {@link cmd} is
 * provided.
 */
export type ContainerHealth = {
    /**
     * `HealthCmd=` — command run inside the container to determine health.
     * An exit code of 0 means healthy, 1 means unhealthy. Set to an empty
     * string to disable an inherited image healthcheck. Pass a `string[]` to
     * supply argv directly without worrying about shell quoting.
     */
    cmd?: systemd.CommandSpec;
    /** `HealthInterval=` — interval between healthcheck runs (e.g. `30s`, `1m`). */
    interval?: string;
    /** `HealthRetries=` — consecutive failed runs required before the container is marked unhealthy. */
    retries?: number;
    /** `HealthStartPeriod=` — initial grace period during which failures do not count toward {@link retries}. */
    startPeriod?: string;
    /** `HealthTimeout=` — maximum duration of a single healthcheck run before it is considered failed. */
    timeout?: string;
    /**
     * `HealthOnFailure=` — action Podman takes once the container becomes
     * unhealthy. Typical values: `none`, `kill`, `restart`, `stop`.
     */
    onFailure?: 'none' | 'kill' | 'restart' | 'stop';
};

/**
 * Specification for a Quadlet `.container` unit, describing a single Podman
 * container managed by systemd.
 *
 * Fields map 1:1 to directives of the `[Container]` section documented in
 * podman-systemd.unit(5). Anything not exposed as a named field can be passed
 * via {@link extraDirectives}, and the surrounding `[Unit]`, `[Install]` and
 * `[Service]` sections can be customised via {@link unit}, {@link install} and
 * {@link service} respectively.
 */
export type State = {
    /** `Image=` — fully qualified image reference (e.g. `docker.io/library/nginx:1.27`) or the name of an `.image` Quadlet. */
    image: string;
    /** `ContainerName=` — name of the container as seen by Podman. Must be unique on the host. */
    name: string;
    /**
     * `Pod=` — name (or `<name>.pod`) of a Quadlet pod this container should
     * join. The container then shares network and IPC with the pod.
     */
    pod?: string;
    /**
     * `StartWithPod=` — whether the container is started together with its
     * pod. Defaults to `true`; set to `false` to start the container manually.
     */
    startWithPod?: boolean;

    /**
     * `Exec=` — command line to run as the container's main process,
     * overriding the image's `CMD`. Pass a `string[]` to supply argv directly
     * without worrying about shell quoting.
     */
    exec?: systemd.CommandSpec;
    /**
     * `Entrypoint=` — overrides the image's `ENTRYPOINT`. Same shape rules as
     * {@link exec}.
     */
    entrypoint?: systemd.CommandSpec;

    /** `Environment=` — environment variables set inside the container. Each entry is emitted as `Environment=KEY=VALUE`. */
    environment?: Record<string, string>;
    /** `EnvironmentFile=` — path(s) on the host to env files loaded into the container. Prefix with `-` to make a missing file non-fatal. */
    environmentFile?: string | string[];
    /** `EnvironmentHost=` — if true, the host's environment is passed through to the container. */
    environmentHost?: boolean;

    /** `User=` — UID or username the container's main process runs as. */
    user?: string | number;
    /** `Group=` — primary GID or group name for the container's main process. */
    group?: string | number;
    /**
     * `UserNS=` — user namespace mode, e.g. `auto`, `keep-id`, `nomap`,
     * `host`, or `auto:size=...`. See `podman-run(1)`.
     */
    userNS?: string;

    /** `HostName=` — hostname seen inside the container. Ignored when the container is part of a pod. */
    hostname?: string;

    /**
     * `Network=` — network(s) the container is attached to. Accepts a Podman
     * network name, the path/name of a `.network` Quadlet, or special values
     * such as `host`, `none`, `container:<id>`. Ignored when the container is
     * part of a pod.
     */
    network?: string | string[];
    /** `NetworkAlias=` — additional DNS aliases for the container on its networks. */
    networkAlias?: string | string[];
    /**
     * `PublishPort=` — publish a container port to the host. Accepts a raw
     * `[host:][hostPort:]containerPort[/proto]` string, a structured
     * {@link PublishPortEntry}, or a mixed array of either. Ignored when the
     * container is part of a pod (publish on the pod instead).
     */
    publishPort?: podman.PublishPortSpec;
    /**
     * `AddHost=` — extra entries added to `/etc/hosts` inside the container.
     * Accepts the raw `host:ip` string form or a `Record<host, ip>`
     * shorthand (one entry per line).
     */
    addHost?: podman.AddHostSpec;
    /** `DNS=` — DNS server(s) to configure inside the container, overriding the host's resolver. */
    dns?: string | string[];

    /**
     * `Volume=` — bind mounts and named volumes attached to the container.
     * Accepts array of {@link VolumeEntry}, use mount if you need more options.
     */
    volume?: podman.VolumeSpec;
    /**
     * `Mount=` — mounts in the more expressive `type=bind,source=...,target=...`
     * syntax of `podman run --mount`.
     */
    mount?: string | string[];
    /**
     * `Tmpfs=` — tmpfs filesystem(s) mounted inside the container. Accepts
     * the raw `target[:options]` string or a structured {@link TmpfsEntry}.
     */
    tmpfs?: TmpfsSpec;
    /** `WorkingDir=` — working directory of the container's main process, overriding the image's `WORKDIR`. */
    workingDir?: string;
    /** `ReadOnly=` — mount the container's root filesystem read-only. */
    readOnly?: boolean;

    /**
     * Config mounts.
     */
    configFiles?: [string, string][];

    /** `Memory=` — hard memory limit (e.g. `512m`, `2g`). */
    memory?: string;
    /** `PidsLimit=` — maximum number of processes the container may create. */
    pidsLimit?: number;
    /** `ShmSize=` — size of `/dev/shm` (e.g. `64m`, `1g`). Ignored when part of a pod. */
    shmSize?: string;

    /** `AddCapability=` — Linux capabilities to add to the container, e.g. `CAP_NET_ADMIN`. */
    addCapability?: string | string[];
    /** `DropCapability=` — Linux capabilities to remove. Use `all` to start from an empty set. */
    dropCapability?: string | string[];
    /** `NoNewPrivileges=` — set the no-new-privs bit, preventing the process from gaining new privileges via execve. */
    noNewPrivileges?: boolean;
    /**
     * `AddDevice=` — host device(s) exposed to the container. Accepts the raw
     * `host[:container[:permissions]]` string or a structured
     * {@link AddDeviceEntry}.
     */
    addDevice?: AddDeviceSpec;

    /** `Label=` — OCI labels applied to the container. Each entry is emitted as `Label=key=value`. */
    label?: Record<string, string>;
    /** `Annotation=` — OCI annotations applied to the container. Each entry is emitted as `Annotation=key=value`. */
    annotation?: Record<string, string>;

    /**
     * `AutoUpdate=` — enables `podman auto-update` for this container.
     * `registry` polls the registry for newer tags; `local` only updates from
     * locally-pulled images.
     */
    autoUpdate?: 'registry' | 'local';
    /** `RunInit=` — run an init process (PID 1) inside the container that reaps zombies and forwards signals. */
    runInit?: boolean;
    /** `StopSignal=` — signal sent to the main process to request a graceful stop, e.g. `SIGTERM` or `SIGINT`. */
    stopSignal?: string;
    /** `StopTimeout=` — seconds to wait for the container to exit after {@link stopSignal} before sending SIGKILL. */
    stopTimeout?: number;
    /**
     * `Notify=` — sd_notify integration. `true` proxies the container's
     * notifications to systemd; `healthy` waits until the healthcheck reports
     * healthy before signalling readiness.
     */
    notify?: boolean | 'healthy';
    /**
     * `Pull=` — image pull policy.
     * - `always` — always pull before starting;
     * - `missing` — pull only if not present locally (default);
     * - `never` — never pull, fail if missing;
     * - `newer` — pull if the registry has a newer image.
     */
    pull?: 'always' | 'missing' | 'never' | 'newer';
    /** `Timezone=` — timezone name configured inside the container (e.g. `Europe/Helsinki`, `local` to inherit the host). */
    timezone?: string;

    /** Healthcheck configuration; emitted as the `Health*=` directives. See {@link ContainerHealth}. */
    health?: ContainerHealth;

    /**
     * `PodmanArgs=` — raw extra arguments appended to the underlying
     * `podman run` invocation. Use sparingly; prefer the typed fields above
     * when an equivalent directive exists.
     */
    podmanArgs?: string | string[];
    /** Extra `[Container]` directives not exposed as named fields, merged verbatim into the section. */
    extraDirectives?: Record<string, systemd.UnitValue>;

    /** Customisations for the generated `[Unit]` section. */
    unit?: systemd.UnitSection;
    /** Customisations for the generated `[Install]` section (e.g. `WantedBy=`). */
    install?: systemd.InstallSection;
    /** Customisations for the generated `[Service]` section (e.g. `Restart=`). */
    service?: systemd.ServiceSection;
};

export function toContainerUnit(spec: State): systemd.UnitFile {
    const container: Record<string, systemd.UnitValue> = {
        Image: spec.image,
        ContainerName: spec.name,
        Pod: spec.pod,
        StartWithPod: spec.startWithPod,

        Exec: systemd.renderCommand(spec.exec),
        Entrypoint: systemd.renderCommand(spec.entrypoint),

        Environment: spec.environment,
        EnvironmentFile: spec.environmentFile,
        EnvironmentHost: spec.environmentHost,

        User: spec.user,
        Group: spec.group,
        UserNS: spec.userNS,

        HostName: spec.hostname,

        Network: spec.network,
        NetworkAlias: spec.networkAlias,
        PublishPort: podman.renderPublishPort(spec.publishPort),
        AddHost: podman.renderAddHost(spec.addHost),
        DNS: spec.dns,

        Volume: podman.renderVolume(spec.volume),
        Mount: spec.mount,
        Tmpfs: renderTmpfs(spec.tmpfs),
        WorkingDir: spec.workingDir,
        ReadOnly: spec.readOnly,

        Memory: spec.memory,
        PidsLimit: spec.pidsLimit,
        ShmSize: spec.shmSize,

        AddCapability: spec.addCapability,
        DropCapability: spec.dropCapability,
        NoNewPrivileges: spec.noNewPrivileges,
        AddDevice: renderAddDevice(spec.addDevice),

        Label: spec.label,
        Annotation: spec.annotation,

        AutoUpdate: spec.autoUpdate,
        RunInit: spec.runInit,
        StopSignal: spec.stopSignal,
        StopTimeout: spec.stopTimeout,
        Notify: spec.notify,
        Pull: spec.pull,
        Timezone: spec.timezone,

        HealthCmd: systemd.renderCommand(spec.health?.cmd),
        HealthInterval: spec.health?.interval,
        HealthRetries: spec.health?.retries,
        HealthStartPeriod: spec.health?.startPeriod,
        HealthTimeout: spec.health?.timeout,
        HealthOnFailure: spec.health?.onFailure,

        PodmanArgs: spec.podmanArgs,

        ...spec.extraDirectives,
    };

    const file: systemd.UnitFile = {
        Container: container,
        Unit: systemd.withDefaults(
            podman.UNIT_DEFAULTS,
            spec.unit ? systemd.unitSectionToRecord(spec.unit) : {},
        ),
        Service: systemd.withDefaults(
            podman.SERVICE_DEFAULTS,
            spec.service ? systemd.serviceSectionToRecord(spec.service) : {},
        ),
    };
    if (spec.install)
        file.Install = systemd.installSectionToRecord(spec.install);
    return file;
}

export const apply = step('remote', async (state: State) => {
    state = { ...state, volume: state.volume ? [...state.volume] : [] }
    if (state.configFiles !== undefined) {
        // Patch config mounts into real volumes
        for (const [idx, [path, content]] of state.configFiles.entries()) {
            const file = `/etc/containers/tunkki-configs/${state.name}-${idx}`;
            state.volume?.push({
                source: file,
                target: path,
            });
            await Bun.file(file).write(content);
        }
    }
    const data = systemd.serializeUnitFile(toContainerUnit(state));

    const containerName = state.pod ? `${state.pod}-${state.name}` : state.name;
    await Bun.write(`/etc/containers/systemd/${containerName}.container`, data);
    await $`systemctl daemon-reload`;
    await $`systemctl restart ${containerName}`;
});

export const cleanup = async (state: State) => {
    const containerName = state.pod ? `${state.pod}-${state.name}` : state.name;
    await Bun.file(
        `/etc/containers/systemd/${containerName}.container`,
    ).delete();
    await $`systemctl stop ${containerName}`;
    await $`systemctl daemon-reload`;
};
