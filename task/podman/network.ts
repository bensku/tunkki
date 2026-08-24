import { step } from '@bensku/tunkki/task';
import { systemd } from '@bensku/tunkki/task/util';
import { $ } from 'bun';

/** Values accepted by `Driver=`. */
export type NetworkDriver = 'bridge' | 'macvlan' | 'ipvlan' | string;

/** Values accepted by `IPAMDriver=`. */
export type NetworkIPAMDriver = 'host-local' | 'dhcp' | 'none';

/**
 * Specification for a Quadlet `.network` unit, describing a Podman network
 * managed by systemd.
 *
 * Fields map 1:1 to directives of the `[Network]` section documented in
 * podman-systemd.unit(5). Anything not exposed as a named field can be passed
 * via {@link extraDirectives}, and the surrounding `[Unit]`, `[Install]` and
 * `[Service]` sections can be customised via {@link unit}, {@link install} and
 * {@link service} respectively.
 */
export type State = {
    /**
     * `NetworkName=` — name of the network as seen by Podman. If omitted,
     * Quadlet derives one from the unit file name (prefixed with `systemd-`).
     */
    name?: string;

    /** `Driver=` — network driver. Defaults to `bridge`. */
    driver?: NetworkDriver;
    /**
     * `IPAMDriver=` — IP Address Management driver. `host-local` allocates
     * from a configured subnet, `dhcp` defers to an external DHCP server,
     * `none` disables IPAM entirely.
     */
    ipamDriver?: NetworkIPAMDriver;

    /**
     * `Subnet=` — subnet(s) in CIDR notation. Multiple entries are matched
     * positionally with {@link gateway} and {@link ipRange}, so keep the
     * arrays the same length and in the same order if you supply more than
     * one of each.
     */
    subnet?: string | string[];
    /**
     * `Gateway=` — gateway IP for the corresponding subnet at the same array
     * index. Requires {@link subnet} to also be set.
     */
    gateway?: string | string[];
    /**
     * `IPRange=` — allocation range for the corresponding subnet at the same
     * array index. Accepts CIDR notation or `<startIP>-<endIP>`.
     */
    ipRange?: string | string[];

    /** `IPv6=` — enable dual-stack IPv6 networking. */
    ipv6?: boolean;
    /** `Internal=` — restrict the network to host-local traffic, with no host gateway or external connectivity. */
    internal?: boolean;
    /** `DisableDNS=` — disable Podman's built-in DNS plugin (`aardvark-dns`) on this network. */
    disableDNS?: boolean;
    /** `DNS=` — DNS resolver(s) configured for containers on this network. */
    dns?: string | string[];

    /**
     * `InterfaceName=` — for the `bridge` driver, the bridge interface name on
     * the host; for `macvlan`/`ipvlan`, the parent device the network is
     * attached to.
     */
    interfaceName?: string;

    /**
     * `Options=` — driver-specific options such as `mtu=9000`, `vlan=100`,
     * `mode=l2`. Each entry is emitted as `Options=key=value`.
     */
    options?: Record<string, string>;
    /** `Label=` — OCI labels applied to the network. Each entry is emitted as `Label=key=value`. */
    label?: Record<string, string>;

    /** `NetworkDeleteOnStop=` — delete the network when its service stops, instead of leaving it on the host. */
    networkDeleteOnStop?: boolean;

    /**
     * `PodmanArgs=` — raw extra arguments appended to the underlying
     * `podman network create` invocation. Use sparingly; prefer the typed
     * fields above when an equivalent directive exists.
     */
    podmanArgs?: string | string[];
    /** Extra `[Network]` directives not exposed as named fields, merged verbatim into the section. */
    extraDirectives?: Record<string, systemd.UnitValue>;

    /** Customisations for the generated `[Unit]` section. */
    unit?: systemd.UnitSection;
    /** Customisations for the generated `[Install]` section (e.g. `WantedBy=`). */
    install?: systemd.InstallSection;
    /** Customisations for the generated `[Service]` section (e.g. `Restart=`). */
    service?: systemd.ServiceSection;
};

export function toNetworkUnit(spec: State): systemd.UnitFile {
    const network: Record<string, systemd.UnitValue> = {
        NetworkName: spec.name,

        Driver: spec.driver,
        IPAMDriver: spec.ipamDriver,

        Subnet: spec.subnet,
        Gateway: spec.gateway,
        IPRange: spec.ipRange,

        IPv6: spec.ipv6,
        Internal: spec.internal,
        DisableDNS: spec.disableDNS,
        DNS: spec.dns,

        InterfaceName: spec.interfaceName,

        Options: spec.options,
        Label: spec.label,

        NetworkDeleteOnStop: spec.networkDeleteOnStop,

        PodmanArgs: spec.podmanArgs,

        ...spec.extraDirectives,
    };

    const file: systemd.UnitFile = {
        Network: network,
        Unit: spec.unit ? systemd.unitSectionToRecord(spec.unit) : {},
        Service: spec.service
            ? systemd.serviceSectionToRecord(spec.service)
            : {},
    };
    if (spec.install)
        file.Install = systemd.installSectionToRecord(spec.install);
    return file;
}

export const apply = step('remote', async (state: State) => {
    const data = systemd.serializeUnitFile(toNetworkUnit(state));

    await Bun.write(`/etc/containers/systemd/${state.name}.network`, data);
    await $`systemctl daemon-reload`;
    // TODO no idea if it is ok to "restart" network like this
    await $`systemctl restart ${state.name}-network`;
});

export const cleanup = async (state: State) => {
    try {
        await Bun.file(
            `/etc/containers/systemd/${state.name}.network`,
        ).delete();
        await $`systemctl daemon-reload`;
        await $`systemctl stop ${state.name}-network`;
    } catch (_e) {
        // Ignore for now
    }
};
