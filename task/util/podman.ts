import type { UnitValue } from './systemd';

/**
 * Defaults merged into the `[Unit]` section of every generated `.pod` and
 * `.container` unit. Disables systemd's start-rate limiter so a crashing
 * service is never blocked from restarting without operator intervention.
 */
export const UNIT_DEFAULTS: Record<string, UnitValue> = {
    StartLimitIntervalSec: 0,
};

/**
 * Defaults merged into the `[Service]` section of every generated `.pod` and
 * `.container` unit. Implements exponential backoff capped at 5 minutes so a
 * crash loop does not exhaust CPU but the service still recovers on its own.
 *
 * With these values the delay sequence is roughly 1s, 2s, 4s, 8s, 16s, 32s,
 * 64s, then 2min steady.
 */
export const SERVICE_DEFAULTS: Record<string, UnitValue> = {
    Restart: 'always',
    RestartSec: 1,
    RestartSteps: 7,
    RestartMaxDelaySec: '2min',
};

/**
 * Input for `AddHost=` (Container and Pod).
 *
 * - String / string[]: passed through verbatim, e.g. `"host:1.2.3.4"` or
 *   `"host1;host2:1.2.3.4"` for the multi-host shorthand.
 * - Record: each `host -> ip` entry becomes a single `AddHost=host:ip` line.
 */
export type AddHostSpec = string | string[] | Record<string, string>;

export function renderAddHost(
    input: AddHostSpec | undefined,
): string[] | undefined {
    if (input === undefined) return undefined;
    if (typeof input === 'string') return [input];
    if (Array.isArray(input)) return input;
    return Object.entries(input).map(([host, ip]) => `${host}:${ip}`);
}

/** Structured `PublishPort=` entry. */
export type PublishPortEntry = {
    /** Host IP/interface to bind on. Omit to bind on all interfaces. */
    host?: string;
    /** Host port. Omit to let Podman assign a random port. */
    hostPort?: number;
    /** Container port. Required. */
    containerPort: number;
    /** Transport protocol. Defaults to `tcp`. */
    protocol?: 'tcp' | 'udp';
};

export type PublishPortSpec =
    | string
    | PublishPortEntry
    | (string | PublishPortEntry)[];

function renderPublishPortOne(p: string | PublishPortEntry): string {
    if (typeof p === 'string') return p;
    const parts: string[] = [];
    if (p.host !== undefined) parts.push(p.host);
    if (p.host !== undefined || p.hostPort !== undefined) {
        parts.push(p.hostPort !== undefined ? String(p.hostPort) : '');
    }
    parts.push(String(p.containerPort));
    return p.protocol ? `${parts.join(':')}/${p.protocol}` : parts.join(':');
}

export function renderPublishPort(
    input: PublishPortSpec | undefined,
): string[] | undefined {
    if (input === undefined) return undefined;
    const entries = Array.isArray(input) ? input : [input];
    return entries.map(renderPublishPortOne);
}

/** Structured `Volume=` entry. */
export type VolumeEntry = {
    /**
     * Host path, named volume, or `.volume` Quadlet. Omit for an anonymous
     * volume managed by Podman.
     */
    source?: string;
    /** Mount target inside the container. */
    target: string;
    /** Mount options such as `ro`, `Z`, `rw`, `exec`. Joined with commas. */
    options?: string[];
};

export type VolumeSpec = string | VolumeEntry | (string | VolumeEntry)[];

function renderVolumeOne(v: string | VolumeEntry): string {
    if (typeof v === 'string') return v;
    const head = v.source !== undefined ? `${v.source}:${v.target}` : v.target;
    return v.options && v.options.length > 0
        ? `${head}:${v.options.join(',')}`
        : head;
}

export function renderVolume(
    input: VolumeSpec | undefined,
): string[] | undefined {
    if (input === undefined) return undefined;
    const entries = Array.isArray(input) ? input : [input];
    return entries.map(renderVolumeOne);
}
