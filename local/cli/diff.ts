import type { Colorizer } from './colors';

const INDENT = '  ';

export function renderValue(v: unknown): string {
    return Bun.inspect(v, { colors: false, depth: 4 });
}

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pad(depth: number): string {
    return INDENT.repeat(depth);
}

function fmtPath(path: string[]): string {
    let out = '';
    for (const seg of path) {
        if (seg.startsWith('[')) out += seg;
        else if (out) out += `.${seg}`;
        else out = seg;
    }
    return out;
}

/**
 * Render a structural diff between oldVal and newVal as a list of pre-indented
 * lines. Pass undefined on either side for pure additions / deletions.
 */
export function renderDiff(
    oldVal: unknown,
    newVal: unknown,
    c: Colorizer,
    indentSpaces: number,
    keyPath: string[] = [],
): string[] {
    const lines: string[] = [];
    const baseDepth = Math.max(0, indentSpaces / 2);
    diff(oldVal, newVal, keyPath, baseDepth, lines, c);
    return lines;
}

function diff(
    oldVal: unknown,
    newVal: unknown,
    path: string[],
    depth: number,
    lines: string[],
    c: Colorizer,
): void {
    const keyLabel = path.length > 0 ? `${fmtPath(path)}: ` : '';
    const prefix = pad(depth);

    // Pure addition
    if (oldVal === undefined && newVal !== undefined) {
        addAll('+', newVal, fmtPath(path), depth, lines, c);
        return;
    }
    // Pure deletion
    if (newVal === undefined && oldVal !== undefined) {
        addAll('-', oldVal, fmtPath(path), depth, lines, c);
        return;
    }

    // Both present (and not both undefined)
    const oldIsObj = isObject(oldVal);
    const newIsObj = isObject(newVal);
    const oldIsArr = Array.isArray(oldVal);
    const newIsArr = Array.isArray(newVal);

    // Same type: object
    if (oldIsObj && newIsObj) {
        const keys = new Set<string>([
            ...Object.keys(oldVal),
            ...Object.keys(newVal),
        ]);
        const sorted = [...keys].sort();
        let any = false;
        for (const k of sorted) {
            const o = oldVal[k];
            const n = newVal[k];
            const before = lines.length;
            diff(o, n, [...path, k], depth, lines, c);
            if (lines.length > before) any = true;
        }
        if (!any && path.length > 0) {
            // Container unchanged; nothing to emit at this level.
        }
        return;
    }

    // Same type: array
    if (oldIsArr && newIsArr) {
        const max = Math.max(oldVal.length, newVal.length);
        for (let i = 0; i < max; i++) {
            const o = i < oldVal.length ? oldVal[i] : undefined;
            const n = i < newVal.length ? newVal[i] : undefined;
            diff(o, n, [...path, `[${i}]`], depth, lines, c);
        }
        return;
    }

    // Type mismatch or both primitives
    if (Object.is(oldVal, newVal)) {
        return; // unchanged
    }

    // Render as inline change
    if (!oldIsObj && !newIsObj && !oldIsArr && !newIsArr) {
        const oldStr = renderValue(oldVal);
        const newStr = renderValue(newVal);
        lines.push(
            `${prefix}${c.yellow('~')} ${keyLabel}${c.dim(oldStr)} ${c.dim('->')} ${c.green(newStr)}`,
        );
        return;
    }

    // Type mismatch (e.g. object -> primitive). Show full -/+ blocks.
    addAll('-', oldVal, fmtPath(path), depth, lines, c);
    addAll('+', newVal, fmtPath(path), depth, lines, c);
}

function addAll(
    sign: '+' | '-',
    val: unknown,
    label: string,
    depth: number,
    lines: string[],
    c: Colorizer,
): void {
    const tint = sign === '+' ? c.green : c.red;
    const labelStr = label ? `${label}: ` : '';
    const prefix = pad(depth);

    if (isObject(val)) {
        const keys = Object.keys(val).sort();
        if (keys.length === 0) {
            lines.push(`${prefix}${tint(sign)} ${labelStr}{}`);
            return;
        }
        if (label) {
            lines.push(`${prefix}${tint(sign)} ${labelStr}`);
        }
        for (const k of keys) {
            addAll(sign, val[k], k, depth + 1, lines, c);
        }
        return;
    }
    if (Array.isArray(val)) {
        if (val.length === 0) {
            lines.push(`${prefix}${tint(sign)} ${labelStr}[]`);
            return;
        }
        if (label) {
            lines.push(`${prefix}${tint(sign)} ${labelStr}`);
        }
        for (let i = 0; i < val.length; i++) {
            addAll(sign, val[i], `[${i}]`, depth + 1, lines, c);
        }
        return;
    }
    lines.push(`${prefix}${tint(sign)} ${labelStr}${tint(renderValue(val))}`);
}
