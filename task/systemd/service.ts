import { step } from '@bensku/tunkki/task';
import { systemd } from '@bensku/tunkki/task/util';
import { $ } from 'bun';

/**
 * Specification for a systemd `.service` unit.
 *
 * Top-level fields map 1:1 to directives of the `[Service]` section
 * documented in systemd.service(5) and systemd.exec(5). Anything not exposed
 * as a named field can be passed via {@link extraDirectives}, and the
 * surrounding `[Unit]` and `[Install]` sections can be customised via
 * {@link unit} and {@link install} respectively.
 */
export type State = {
    /** Unit base name (no `.service` extension). Used as the file name and for `systemctl` calls. */
    name: string;

    /**
     * `Type=` — process startup model. See systemd.service(5):
     * - `simple` — main process is the one started by `ExecStart=` (default).
     * - `exec` — like `simple`, but readiness waits for `execve()`.
     * - `forking` — `ExecStart=` forks; the parent exits and the child becomes the main process.
     * - `oneshot` — short-lived process that exits before follow-up units run; combine with {@link remainAfterExit}.
     * - `dbus` — readiness is signalled by acquiring a name on the bus.
     * - `notify` / `notify-reload` — readiness signalled via `sd_notify(3)`.
     * - `idle` — like `simple` but delayed until other jobs are dispatched.
     */
    type?:
        | 'simple'
        | 'exec'
        | 'forking'
        | 'oneshot'
        | 'dbus'
        | 'notify'
        | 'notify-reload'
        | 'idle';

    /**
     * `ExecStart=` — command line to run as the service's main process. Pass
     * a `string[]` to supply argv directly without worrying about shell
     * quoting. For multiple `ExecStart=` lines (only valid for
     * `Type=oneshot`), use {@link extraDirectives} with a `string[]` value.
     */
    exec?: systemd.CommandSpec;
    /** `ExecStartPre=` — command run before {@link exec}. */
    execStartPre?: systemd.CommandSpec;
    /** `ExecStartPost=` — command run after {@link exec} starts successfully. */
    execStartPost?: systemd.CommandSpec;
    /** `ExecStop=` — command run to stop the service before the manager sends SIGTERM. */
    execStop?: systemd.CommandSpec;
    /** `ExecStopPost=` — command run after the service has stopped, regardless of how. */
    execStopPost?: systemd.CommandSpec;
    /** `ExecReload=` — command executed when the service is asked to reload via `systemctl reload`. */
    execReload?: systemd.CommandSpec;

    /** `User=` — UID or username the service's processes run as. */
    user?: string | number;
    /** `Group=` — primary GID or group name for the service's processes. */
    group?: string | number;
    /**
     * `DynamicUser=` — allocate a transient user/group at start, freed at
     * stop. Implies `PrivateTmp=`, `RemoveIPC=` and other hardening.
     */
    dynamicUser?: boolean;
    /** `WorkingDirectory=` — directory the service's processes are started in. */
    workingDirectory?: string;
    /** `RootDirectory=` — directory used as the root filesystem (chroot) for the service. */
    rootDirectory?: string;

    /** `Environment=` — environment variables passed to the service's processes. Each entry is emitted as `Environment=KEY=VALUE`. */
    environment?: Record<string, string>;
    /** `EnvironmentFile=` — path(s) to files containing `KEY=VALUE` lines. Prefix with `-` to make a missing file non-fatal. */
    environmentFile?: string | string[];
    /** `PassEnvironment=` — names of environment variables imported from the manager into the service. */
    passEnvironment?: string | string[];

    /** `StandardInput=` — connection for stdin (`null`, `tty`, `socket`, `data`, ...). See systemd.exec(5). */
    standardInput?: string;
    /** `StandardOutput=` — connection for stdout (`journal`, `inherit`, `null`, `tty`, `file:...`, ...). */
    standardOutput?: string;
    /** `StandardError=` — connection for stderr (same value space as {@link standardOutput}). */
    standardError?: string;

    /** `Restart=` — when the service should be restarted. See {@link systemd.ServiceRestart}. */
    restart?: systemd.ServiceRestart;
    /** `RestartSec=` — delay before restarting. Accepts a systemd time span (`5s`, `1min`) or seconds. */
    restartSec?: string | number;
    /** `RestartSteps=` — number of steps over which the restart delay grows exponentially up to {@link restartMaxDelaySec}. */
    restartSteps?: number;
    /** `RestartMaxDelaySec=` — upper bound on the exponential restart delay. */
    restartMaxDelaySec?: string | number;
    /** `TimeoutStartSec=` — maximum time the service may take to start before being considered failed. */
    timeoutStartSec?: string | number;
    /** `TimeoutStopSec=` — maximum time the service may take to stop; after this, SIGKILL is sent. */
    timeoutStopSec?: string | number;
    /** `TimeoutSec=` — convenience alias setting both {@link timeoutStartSec} and {@link timeoutStopSec}. */
    timeoutSec?: string | number;

    /** `KillMode=` — how processes are killed when the service is stopped. */
    killMode?: 'control-group' | 'mixed' | 'process' | 'none';
    /** `KillSignal=` — signal used to ask processes to terminate (default `SIGTERM`). */
    killSignal?: string;
    /**
     * `RemainAfterExit=` — keep the service in the active state after the
     * main process exits. Typically used with `Type=oneshot`.
     */
    remainAfterExit?: boolean;
    /** `PIDFile=` — path to a PID file written by a `Type=forking` service. */
    pidFile?: string;

    /** `Nice=` — process scheduling priority (`-20`..`19`). */
    nice?: number;
    /** `OOMScoreAdjust=` — kernel OOM-killer adjustment (`-1000`..`1000`). */
    oomScoreAdjust?: number;
    /** `Slice=` — cgroup slice the service belongs to (e.g. `system.slice`). */
    slice?: string;

    /** `MemoryMax=` — hard memory limit (e.g. `512M`, `2G`, `infinity`). */
    memoryMax?: string;
    /** `CPUQuota=` — CPU time available to the service, as a percentage (e.g. `50%`, `200%`). */
    cpuQuota?: string;
    /** `TasksMax=` — maximum number of tasks (threads/processes). Pass `'infinity'` for no limit. */
    tasksMax?: number | string;

    /** `NoNewPrivileges=` — set the no-new-privs bit, preventing the process from gaining new privileges via execve. */
    noNewPrivileges?: boolean;
    /**
     * `ProtectSystem=` — make `/usr` (and optionally `/etc`, `/boot`)
     * read-only for the service. `true` is read-only `/usr`; `'full'` adds
     * `/etc` and `/boot`; `'strict'` makes the entire filesystem read-only
     * apart from explicitly allowed paths.
     */
    protectSystem?: boolean | 'full' | 'strict';
    /**
     * `ProtectHome=` — restrict access to `/home`, `/root`, `/run/user`.
     * `true` makes them inaccessible; `'read-only'` permits reads;
     * `'tmpfs'` overlays an empty tmpfs.
     */
    protectHome?: boolean | 'read-only' | 'tmpfs';
    /** `PrivateTmp=` — give the service a private `/tmp` and `/var/tmp` directory, deleted on stop. */
    privateTmp?: boolean;
    /** `PrivateNetwork=` — run the service in a private network namespace with only loopback. */
    privateNetwork?: boolean;
    /** `PrivateUsers=` — run the service in a private user namespace; UIDs other than the service's own are mapped to `nobody`. */
    privateUsers?: boolean;

    /** Extra `[Service]` directives not exposed as named fields, merged verbatim into the section. */
    extraDirectives?: Record<string, systemd.UnitValue>;

    /** Customisations for the generated `[Unit]` section. */
    unit?: systemd.UnitSection;
    /** Customisations for the generated `[Install]` section (e.g. `WantedBy=`). */
    install?: systemd.InstallSection;
};

export function toServiceUnit(spec: State): systemd.UnitFile {
    const service: Record<string, systemd.UnitValue> = {
        Type: spec.type,

        ExecStart: systemd.renderCommand(spec.exec),
        ExecStartPre: systemd.renderCommand(spec.execStartPre),
        ExecStartPost: systemd.renderCommand(spec.execStartPost),
        ExecStop: systemd.renderCommand(spec.execStop),
        ExecStopPost: systemd.renderCommand(spec.execStopPost),
        ExecReload: systemd.renderCommand(spec.execReload),

        User: spec.user,
        Group: spec.group,
        DynamicUser: spec.dynamicUser,
        WorkingDirectory: spec.workingDirectory,
        RootDirectory: spec.rootDirectory,

        Environment: spec.environment,
        EnvironmentFile: spec.environmentFile,
        PassEnvironment: spec.passEnvironment,

        StandardInput: spec.standardInput,
        StandardOutput: spec.standardOutput,
        StandardError: spec.standardError,

        Restart: spec.restart,
        RestartSec: spec.restartSec,
        RestartSteps: spec.restartSteps,
        RestartMaxDelaySec: spec.restartMaxDelaySec,
        TimeoutStartSec: spec.timeoutStartSec,
        TimeoutStopSec: spec.timeoutStopSec,
        TimeoutSec: spec.timeoutSec,

        KillMode: spec.killMode,
        KillSignal: spec.killSignal,
        RemainAfterExit: spec.remainAfterExit,
        PIDFile: spec.pidFile,

        Nice: spec.nice,
        OOMScoreAdjust: spec.oomScoreAdjust,
        Slice: spec.slice,

        MemoryMax: spec.memoryMax,
        CPUQuota: spec.cpuQuota,
        TasksMax: spec.tasksMax,

        NoNewPrivileges: spec.noNewPrivileges,
        ProtectSystem: spec.protectSystem,
        ProtectHome: spec.protectHome,
        PrivateTmp: spec.privateTmp,
        PrivateNetwork: spec.privateNetwork,
        PrivateUsers: spec.privateUsers,

        ...spec.extraDirectives,
    };

    const file: systemd.UnitFile = {
        Service: service,
        Unit: spec.unit ? systemd.unitSectionToRecord(spec.unit) : {},
    };
    if (spec.install)
        file.Install = systemd.installSectionToRecord(spec.install);
    return file;
}

export const apply = step('remote', async (state: State) => {
    const data = systemd.serializeUnitFile(toServiceUnit(state));
    await Bun.write(`/etc/systemd/system/${state.name}.service`, data);
    await $`systemctl daemon-reload`;
    if (state.install) await $`systemctl reenable ${state.name}.service`;
    await $`systemctl restart ${state.name}.service`;
});

export const cleanup = async (state: State) => {
    await $`systemctl disable --now ${state.name}.service`;
    await Bun.file(`/etc/systemd/system/${state.name}.service`).delete();
    await $`systemctl daemon-reload`;
};
