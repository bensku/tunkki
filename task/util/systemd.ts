/**
 * A value for a single key in a systemd unit file.
 *
 * - `string`/`number`/`boolean` are written as `Key=value`.
 * - `string[]` emits one `Key=value` line per element, which systemd treats as
 *   repeated (and usually additive) directives.
 * - `Record<string, string>` emits one `Key=k=v` line per entry, used for
 *   directives such as `Label=`, `Environment=` or `Annotation=` whose values
 *   are themselves key/value pairs.
 * - `undefined` causes the directive to be omitted entirely.
 */
export type UnitValue =
    | string
    | string[]
    | number
    | boolean
    | Record<string, string>
    | undefined;

/**
 * In-memory representation of a systemd unit file.
 *
 * The outer record is keyed by section name (e.g. `Unit`, `Service`, `Install`,
 * `Container`, `Pod`); the inner record holds the directives within that
 * section. See systemd.unit(5) for the general unit file syntax and
 * podman-systemd.unit(5) for the Quadlet-specific sections.
 */
export type UnitFile = Record<string, Record<string, UnitValue>>;

export function serializeUnitFile(data: UnitFile): string {
    const lines: string[] = [];
    const sections = Object.entries(data).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
    );
    for (const [section, entries] of sections) {
        if (lines.length > 0) lines.push('');
        lines.push(`[${section}]`);
        const keys = Object.entries(entries).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
        );
        for (const [key, value] of keys) {
            for (const v of normalizeValue(value)) {
                if (/[\r\n]/.test(v)) {
                    throw new Error(
                        `unit file value for ${section}.${key} contains a newline`,
                    );
                }
                lines.push(`${key}=${v}`);
            }
        }
    }
    return `${lines.join('\n')}\n`;
}

function normalizeValue(value: UnitValue): string[] {
    if (value === undefined) return [];
    if (typeof value === 'boolean') return [value ? 'true' : 'false'];
    if (typeof value === 'number') return [String(value)];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value;
    return Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`);
}

/**
 * Common directives of the `[Unit]` section of a systemd unit file.
 *
 * Documents the unit and declares its relationships with other units. See
 * systemd.unit(5) for the full set of supported directives; uncommon ones can
 * be passed via {@link UnitSection.extra}.
 */
export type UnitSection = {
    /** `Description=` — short, human-readable title shown in logs and `systemctl status`. */
    description?: string;
    /** `Documentation=` — space-separated list of URIs (`man:`, `https:`, ...) pointing to documentation for this unit. */
    documentation?: string | string[];
    /**
     * `After=` — ordering dependency: this unit is started after the listed
     * units. Ordering only; does not pull the listed units into the
     * transaction (use {@link wants} or {@link requires} for that).
     */
    after?: string | string[];
    /** `Before=` — ordering dependency: this unit is started before the listed units. */
    before?: string | string[];
    /**
     * `Requires=` — strong requirement dependency: if any listed unit fails to
     * start or stops, this unit is also stopped. Does not imply ordering;
     * combine with {@link after} to also order.
     */
    requires?: string | string[];
    /**
     * `Wants=` — weak requirement dependency: the listed units are pulled in
     * but failures do not affect this unit. Preferred over {@link requires}
     * when the dependency is non-essential.
     */
    wants?: string | string[];
    /**
     * `Requisite=` — like {@link requires}, but the listed units must already
     * be active; otherwise the unit fails to start instead of being pulled in.
     */
    requisite?: string | string[];
    /**
     * `BindsTo=` — like {@link requires}, but additionally stops this unit
     * whenever any of the listed units becomes inactive for any reason
     * (including unexpected exit).
     */
    bindsTo?: string | string[];
    /**
     * `PartOf=` — propagates stop and restart actions from the listed units to
     * this one (one-way; this unit does not affect them).
     */
    partOf?: string | string[];
    /** `Conflicts=` — negative dependency: starting this unit stops the listed units, and vice versa. */
    conflicts?: string | string[];
    /**
     * `StartLimitIntervalSec=` — length of the window over which {@link startLimitBurst}
     * start attempts are counted. Set to `0` to disable the rate limit entirely
     * (so systemd never gives up on a crashing service).
     */
    startLimitIntervalSec?: string | number;
    /**
     * `StartLimitBurst=` — maximum number of start attempts allowed within
     * {@link startLimitIntervalSec} before systemd refuses further restarts
     * until `systemctl reset-failed` is run.
     */
    startLimitBurst?: number;
    /** Additional `[Unit]` directives not exposed as named fields. */
    extra?: Record<string, UnitValue>;
};

export function unitSectionToRecord(s: UnitSection): Record<string, UnitValue> {
    return {
        Description: s.description,
        Documentation: s.documentation,
        After: s.after,
        Before: s.before,
        Requires: s.requires,
        Wants: s.wants,
        Requisite: s.requisite,
        BindsTo: s.bindsTo,
        PartOf: s.partOf,
        Conflicts: s.conflicts,
        StartLimitIntervalSec: s.startLimitIntervalSec,
        StartLimitBurst: s.startLimitBurst,
        ...s.extra,
    };
}

/**
 * Common directives of the `[Install]` section of a systemd unit file.
 *
 * Read by `systemctl enable`/`disable` to install symlinks; ignored by the
 * service manager at runtime. See systemd.unit(5).
 */
export type InstallSection = {
    /**
     * `WantedBy=` — when this unit is enabled, a `Wants=` symlink is created
     * from each listed unit's `.wants/` directory. Typical value:
     * `multi-user.target` or `default.target`.
     */
    wantedBy?: string | string[];
    /** `RequiredBy=` — like {@link wantedBy}, but installs a `Requires=` symlink instead. */
    requiredBy?: string | string[];
    /** `Alias=` — additional names this unit can be referred to by. The aliased names must have the same suffix as the unit. */
    alias?: string | string[];
    /** `Also=` — additional units that should be enabled or disabled together with this one. */
    also?: string | string[];
    /** Additional `[Install]` directives not exposed as named fields. */
    extra?: Record<string, UnitValue>;
};

export function installSectionToRecord(
    s: InstallSection,
): Record<string, UnitValue> {
    return {
        WantedBy: s.wantedBy,
        RequiredBy: s.requiredBy,
        Alias: s.alias,
        Also: s.also,
        ...s.extra,
    };
}

/**
 * Values accepted by the `Restart=` directive — controls when a service is
 * restarted after exit. See systemd.service(5).
 *
 * - `no` — never restart (default).
 * - `on-success` — restart only if the process exited cleanly (exit code 0).
 * - `on-failure` — restart on non-zero exit, signal, timeout or watchdog.
 * - `on-abnormal` — restart on signal, timeout or watchdog (not on plain non-zero exit).
 * - `on-watchdog` — restart only on watchdog timeout.
 * - `on-abort` — restart only on uncaught signal.
 * - `always` — restart unconditionally.
 */
export type ServiceRestart =
    | 'no'
    | 'on-success'
    | 'on-failure'
    | 'on-abnormal'
    | 'on-watchdog'
    | 'on-abort'
    | 'always';

/**
 * Common directives of the `[Service]` section of a systemd unit file.
 *
 * For Quadlet units (`.container`, `.pod`, ...) this section may be specified
 * alongside the Quadlet-specific section to override or extend the generated
 * service. See systemd.service(5) and systemd.exec(5).
 */
export type ServiceSection = {
    /** `Restart=` — when the service should be restarted. See {@link ServiceRestart}. */
    restart?: ServiceRestart;
    /** `RestartSec=` — delay before restarting. Accepts a systemd time span (`5s`, `1min`) or a number of seconds. */
    restartSec?: string | number;
    /**
     * `RestartSteps=` — number of steps over which the restart delay grows
     * exponentially from {@link restartSec} to {@link restartMaxDelaySec}.
     * Used together they implement exponential backoff.
     */
    restartSteps?: number;
    /**
     * `RestartMaxDelaySec=` — upper bound on the restart delay computed by
     * {@link restartSteps}. Once reached, further restarts wait this long
     * between attempts.
     */
    restartMaxDelaySec?: string | number;
    /** `TimeoutStartSec=` — maximum time the service may take to start before being considered failed. */
    timeoutStartSec?: string | number;
    /** `TimeoutStopSec=` — maximum time the service may take to stop; after this, SIGKILL is sent. */
    timeoutStopSec?: string | number;
    /** `Environment=` — environment variables passed to the service process. Each entry is emitted as `Environment=KEY=VALUE`. */
    environment?: Record<string, string>;
    /** `EnvironmentFile=` — path(s) to files containing `KEY=VALUE` lines that are loaded into the service environment. Prefix with `-` to make a missing file non-fatal. */
    environmentFile?: string | string[];
    /** Additional `[Service]` directives not exposed as named fields. */
    extra?: Record<string, UnitValue>;
};

export function serviceSectionToRecord(
    s: ServiceSection,
): Record<string, UnitValue> {
    return {
        Restart: s.restart,
        RestartSec: s.restartSec,
        RestartSteps: s.restartSteps,
        RestartMaxDelaySec: s.restartMaxDelaySec,
        TimeoutStartSec: s.timeoutStartSec,
        TimeoutStopSec: s.timeoutStopSec,
        Environment: s.environment,
        EnvironmentFile: s.environmentFile,
        ...s.extra,
    };
}

/**
 * Merge two unit-section records, preferring values from {@link overrides}
 * unless they are `undefined`, in which case the value from {@link defaults}
 * is used.
 *
 * Useful for layering library-supplied defaults underneath user-supplied
 * sections produced by {@link unitSectionToRecord} / {@link serviceSectionToRecord},
 * which emit `undefined` for unset fields.
 */
export function withDefaults(
    defaults: Record<string, UnitValue>,
    overrides: Record<string, UnitValue>,
): Record<string, UnitValue> {
    const out: Record<string, UnitValue> = { ...defaults };
    for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined) out[k] = v;
    }
    return out;
}

/**
 * Argv-style command. Strings are passed through verbatim; arrays are joined
 * with shell-style double quoting compatible with systemd's command-line
 * parser, so callers do not need to escape spaces or quotes themselves.
 */
export type CommandSpec = string | string[];

export function renderCommand(
    input: CommandSpec | undefined,
): string | undefined {
    if (input === undefined) return undefined;
    if (typeof input === 'string') return input;
    return input.map(quoteArg).join(' ');
}

function quoteArg(arg: string): string {
    if (arg === '') return '""';
    if (/^[A-Za-z0-9_\-./@:=+,%]+$/.test(arg)) return arg;
    return `"${arg.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
