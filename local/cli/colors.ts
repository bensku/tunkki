const RESET = '\x1b[0m';

function tint(name: string, s: string, enabled: boolean): string {
    if (!enabled) return s;
    const code = Bun.color(name, 'ansi');
    return code ? code + s + RESET : s;
}

export function makeColor(enabled: boolean) {
    return {
        green: (s: string) => tint('green', s, enabled),
        red: (s: string) => tint('red', s, enabled),
        yellow: (s: string) => tint('yellow', s, enabled),
        cyan: (s: string) => tint('cyan', s, enabled),
        // Bun.color only handles colors, not SGR text attributes — keep these
        // as raw escapes since there's no Bun equivalent for dim/bold.
        dim: (s: string) => (enabled ? `\x1b[2m${s}${RESET}` : s),
        bold: (s: string) => (enabled ? `\x1b[1m${s}${RESET}` : s),
    };
}

export type Colorizer = ReturnType<typeof makeColor>;
