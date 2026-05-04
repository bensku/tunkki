import { step } from '@bensku/tunkki/task';
import { podman, systemd } from '@bensku/tunkki/task/util';
import { $ } from 'bun';

/** Structured `UIDMap=` / `GIDMap=` entry. */
export type IdMapEntry = {
    /** ID inside the container at which the mapping starts. */
    containerId: number;
    /** ID outside the container at which the mapping starts. */
    hostId: number;
    /** Number of consecutive IDs covered by the mapping. */
    size: number;
    /** When true, emit the `+` prefix for a relative mapping. */
    relative?: boolean;
};

export type IdMapSpec = string | IdMapEntry | (string | IdMapEntry)[];

function renderIdMapOne(m: string | IdMapEntry): string {
    if (typeof m === 'string') return m;
    const prefix = m.relative ? '+' : '';
    return `${prefix}${m.containerId}:${m.hostId}:${m.size}`;
}

export function renderIdMap(
    input: IdMapSpec | undefined,
): string[] | undefined {
    if (input === undefined) return undefined;
    const entries = Array.isArray(input) ? input : [input];
    return entries.map(renderIdMapOne);
}

/**
 * Input for `DNSOption=`.
 *
 * - String / string[]: passed through verbatim (e.g. `"ndots:2"`).
 * - Record: `{ ndots: '2' }` -> `DNSOption=ndots:2`; a `true` value emits the
 *   bare option name, e.g. `{ debug: true }` -> `DNSOption=debug`.
 */
export type DnsOptionSpec = string | string[] | Record<string, string | true>;

export function renderDnsOption(
    input: DnsOptionSpec | undefined,
): string[] | undefined {
    if (input === undefined) return undefined;
    if (typeof input === 'string') return [input];
    if (Array.isArray(input)) return input;
    return Object.entries(input).map(([k, v]) =>
        v === true ? k : `${k}:${v}`,
    );
}

/**
 * Specification for a Quadlet `.pod` unit, describing a Podman pod that groups
 * one or more containers together (sharing network, IPC, etc.).
 *
 * Fields map 1:1 to directives of the `[Pod]` section documented in
 * podman-systemd.unit(5). Anything not exposed as a named field can be passed
 * via {@link extraDirectives}, and the surrounding `[Unit]`, `[Install]` and
 * `[Service]` sections can be customised via {@link unit}, {@link install} and
 * {@link service} respectively.
 */
export type State = {
    /** `PodName=` — name of the pod as seen by Podman. Must be unique on the host. */
    name: string;
    /** `HostName=` — hostname set inside the pod's UTS namespace and seen by all containers in the pod. */
    hostname?: string;

    /**
     * `Network=` — network(s) the pod is attached to. Accepts a Podman network
     * name, the path/name of a `.network` Quadlet, or special values such as
     * `host`, `none`, `pasta:...`, `slirp4netns:...`. Repeat for multiple networks.
     */
    network?: string | string[];
    /** `NetworkAlias=` — additional DNS aliases for the pod on its networks. */
    networkAlias?: string | string[];
    /**
     * `PublishPort=` — publish a container port to the host. Accepts a raw
     * `[host:][hostPort:]containerPort[/proto]` string, a structured
     * {@link PublishPortEntry}, or a mixed array of either.
     */
    publishPort?: podman.PublishPortSpec;
    /** `IP=` — static IPv4 address to assign to the pod on its network. */
    ip?: string;
    /** `IP6=` — static IPv6 address to assign to the pod on its network. */
    ip6?: string;
    /**
     * `AddHost=` — extra entries added to `/etc/hosts` inside the pod. Accepts
     * the raw `host:ip` string form or a `Record<host, ip>` shorthand (one
     * entry per line).
     */
    addHost?: podman.AddHostSpec;
    /** `DNS=` — DNS server(s) to configure inside the pod, overriding the host's resolver. */
    dns?: string | string[];
    /** `DNSSearch=` — DNS search domain(s) to set inside the pod. */
    dnsSearch?: string | string[];
    /**
     * `DNSOption=` — resolver options (e.g. `ndots:2`). Accepts the raw
     * string form or a `Record<option, value | true>` shorthand, where `true`
     * emits the bare option name.
     */
    dnsOption?: DnsOptionSpec;

    /**
     * `Volume=` — volumes mounted into the pod, shared with all containers.
     * Accepts the raw `source:target[:options]` string, a structured
     * {@link VolumeEntry}, or a mixed array of either.
     */
    volume?: podman.VolumeSpec;

    /** `Label=` — OCI labels applied to the pod. Each entry is emitted as `Label=key=value`. */
    label?: Record<string, string>;

    /** `ShmSize=` — size of `/dev/shm` shared by the pod's containers (e.g. `64m`, `1g`). */
    shmSize?: string;
    /** `StopTimeout=` — seconds to wait for the pod's containers to exit before sending SIGKILL. */
    stopTimeout?: number;
    /**
     * `ExitPolicy=` — what Podman does once all containers in the pod exit.
     * `stop` tears the pod down; `continue` keeps the infra container running
     * so a restarting member can rejoin without bringing the whole pod back up.
     *
     * Defaults to `continue` (Quadlet's upstream default is `stop`) so that a
     * single crashing container does not take its siblings with it.
     */
    exitPolicy?: 'stop' | 'continue';

    /**
     * `UserNS=` — user namespace mode for the pod, e.g. `auto`, `keep-id`,
     * `nomap`, `host`, or `auto:size=...`. See `podman-pod-create(1)`.
     */
    userNS?: string;
    /**
     * `UIDMap=` — explicit UID mapping for a new user namespace. Accepts the
     * raw `[+]containerId:hostId:size` string form or a structured
     * {@link IdMapEntry}.
     */
    uidMap?: IdMapSpec;
    /**
     * `GIDMap=` — explicit GID mapping for a new user namespace. Same shapes
     * as {@link uidMap}.
     */
    gidMap?: IdMapSpec;
    /** `SubUIDMap=` — name of an entry in `/etc/subuid` to use for the pod's UID mapping. */
    subUIDMap?: string;
    /** `SubGIDMap=` — name of an entry in `/etc/subgid` to use for the pod's GID mapping. */
    subGIDMap?: string;

    /**
     * `PodmanArgs=` — raw extra arguments appended to the underlying
     * `podman pod create` invocation. Use sparingly; prefer the typed fields
     * above when an equivalent directive exists.
     */
    podmanArgs?: string | string[];
    /** Extra `[Pod]` directives not exposed as named fields, merged verbatim into the section. */
    extraDirectives?: Record<string, systemd.UnitValue>;

    /** Customisations for the generated `[Unit]` section. */
    unit?: systemd.UnitSection;
    /** Customisations for the generated `[Install]` section (e.g. `WantedBy=`). */
    install?: systemd.InstallSection;
    /** Customisations for the generated `[Service]` section (e.g. `Restart=`). */
    service?: systemd.ServiceSection;
};

export function toPodUnit(spec: State): systemd.UnitFile {
    const pod: Record<string, systemd.UnitValue> = {
        PodName: spec.name,
        HostName: spec.hostname,

        Network: spec.network,
        NetworkAlias: spec.networkAlias,
        PublishPort: podman.renderPublishPort(spec.publishPort),
        IP: spec.ip,
        IP6: spec.ip6,
        AddHost: podman.renderAddHost(spec.addHost),
        DNS: spec.dns,
        DNSSearch: spec.dnsSearch,
        DNSOption: renderDnsOption(spec.dnsOption),

        Volume: podman.renderVolume(spec.volume),

        Label: spec.label,

        ShmSize: spec.shmSize,
        StopTimeout: spec.stopTimeout,
        ExitPolicy: spec.exitPolicy ?? 'continue',

        UserNS: spec.userNS,
        UIDMap: renderIdMap(spec.uidMap),
        GIDMap: renderIdMap(spec.gidMap),
        SubUIDMap: spec.subUIDMap,
        SubGIDMap: spec.subGIDMap,

        PodmanArgs: spec.podmanArgs,

        ...spec.extraDirectives,
    };

    const file: systemd.UnitFile = {
        Pod: pod,
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
    const data = systemd.serializeUnitFile(toPodUnit(state));

    await Bun.write(`/etc/containers/systemd/${state.name}.pod`, data);
    await $`systemctl daemon-reload`;
    await $`systemctl restart ${state.name}-pod`;
});

export const cleanup = async (state: State) => {
    await Bun.file(`/etc/containers/systemd/${state.name}.pod`).delete();
    await $`systemctl daemon-reload`;
    await $`systemctl stop ${state.name}-pod`;
};
