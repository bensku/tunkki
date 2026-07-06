import { step } from '@bensku/tunkki/task';
import { systemd } from '@bensku/tunkki/task/util';
import { $ } from 'bun';

/**
 * Specification for a systemd `.timer` unit.
 *
 * Top-level fields map 1:1 to directives of the `[Timer]` section documented
 * in systemd.timer(5). Anything not exposed as a named field can be passed
 * via {@link extraDirectives}, and the surrounding `[Unit]` and `[Install]`
 * sections can be customised via {@link unit} and {@link install}.
 *
 * To actually schedule the timer at boot, set `install.wantedBy` to
 * `['timers.target']`.
 */
export type State = {
    /** Unit base name (no `.timer` extension). Used as the file name and for `systemctl` calls. */
    name: string;

    /**
     * `Unit=` — the unit triggered each time this timer elapses. If omitted,
     * systemd defaults to `<name>.service`.
     */
    triggerUnit?: string;

    /**
     * `OnCalendar=` — wall-clock schedule expression(s), e.g. `daily`,
     * `*-*-* 04:00:00`, `Mon..Fri 09:00`. See systemd.time(7).
     */
    onCalendar?: string | string[];
    /** `OnActiveSec=` — fire this long after the timer itself becomes active. */
    onActiveSec?: string;
    /** `OnBootSec=` — fire this long after the system boots. */
    onBootSec?: string;
    /** `OnStartupSec=` — fire this long after systemd was first started. Differs from {@link onBootSec} for user managers. */
    onStartupSec?: string;
    /** `OnUnitActiveSec=` — fire this long after {@link triggerUnit} was last activated. */
    onUnitActiveSec?: string;
    /** `OnUnitInactiveSec=` — fire this long after {@link triggerUnit} was last deactivated. */
    onUnitInactiveSec?: string;

    /** `AccuracySec=` — slack window for firing; systemd batches up timers within this window. Default `1min`. */
    accuracySec?: string;
    /** `RandomizedDelaySec=` — random extra delay applied to each firing, useful for spreading load. */
    randomizedDelaySec?: string;
    /**
     * `Persistent=` — for `OnCalendar=`, store the last firing time on disk
     * and catch up missed runs once the system is back online.
     */
    persistent?: boolean;
    /** `WakeSystem=` — wake the system from suspend to fire the timer. Requires CAP_WAKE_ALARM. */
    wakeSystem?: boolean;
    /** `RemainAfterElapse=` — keep the timer unit loaded after it has elapsed. Default `true`. */
    remainAfterElapse?: boolean;
    /** `OnClockChange=` — fire when the wall clock jumps (e.g. after NTP sync). */
    onClockChange?: boolean;
    /** `OnTimezoneChange=` — fire when the system timezone changes. */
    onTimezoneChange?: boolean;

    /** Extra `[Timer]` directives not exposed as named fields, merged verbatim into the section. */
    extraDirectives?: Record<string, systemd.UnitValue>;

    /** Customisations for the generated `[Unit]` section. */
    unit?: systemd.UnitSection;
    /** Customisations for the generated `[Install]` section (typically `wantedBy: ['timers.target']`). */
    install?: systemd.InstallSection;

    script?: string;
};

export function toTimerUnit(spec: State): systemd.UnitFile {
    const timer: Record<string, systemd.UnitValue> = {
        Unit: spec.triggerUnit,
        OnCalendar: spec.onCalendar,
        OnActiveSec: spec.onActiveSec,
        OnBootSec: spec.onBootSec,
        OnStartupSec: spec.onStartupSec,
        OnUnitActiveSec: spec.onUnitActiveSec,
        OnUnitInactiveSec: spec.onUnitInactiveSec,
        AccuracySec: spec.accuracySec,
        RandomizedDelaySec: spec.randomizedDelaySec,
        Persistent: spec.persistent,
        WakeSystem: spec.wakeSystem,
        RemainAfterElapse: spec.remainAfterElapse,
        OnClockChange: spec.onClockChange,
        OnTimezoneChange: spec.onTimezoneChange,
        ...spec.extraDirectives,
    };

    const file: systemd.UnitFile = {
        Timer: timer,
        Unit: spec.unit ? systemd.unitSectionToRecord(spec.unit) : {},
    };
    if (spec.install)
        file.Install = systemd.installSectionToRecord(spec.install);
    return file;
}

export const apply = step('remote', async (state: State) => {
    const data = systemd.serializeUnitFile(toTimerUnit(state));
    await Bun.write(`/etc/systemd/system/${state.name}.timer`, data);
    await $`systemctl daemon-reload`;
    if (state.install) await $`systemctl reenable ${state.name}.timer`;
    await $`systemctl restart ${state.name}.timer`;
});

export const cleanup = async (state: State) => {
    await $`systemctl disable --now ${state.name}.timer`;
    await Bun.file(`/etc/systemd/system/${state.name}.timer`).delete();
    await $`systemctl daemon-reload`;
};
