import { describe, expect, test } from 'bun:test';
import { serializeUnitFile, withDefaults } from '../../task/util/systemd';

describe('serializeUnitFile', () => {
    test('renders a single section with a string value', () => {
        const out = serializeUnitFile({
            Service: { ExecStart: '/bin/echo hi' },
        });
        expect(out).toBe('[Service]\nExecStart=/bin/echo hi\n');
    });

    test('separates multiple sections with a blank line and orders them alphabetically', () => {
        const out = serializeUnitFile({
            Service: { ExecStart: '/bin/true' },
            Install: { WantedBy: 'multi-user.target' },
            Unit: { Description: 'demo' },
        });
        expect(out).toBe(
            '[Install]\nWantedBy=multi-user.target\n' +
                '\n' +
                '[Service]\nExecStart=/bin/true\n' +
                '\n' +
                '[Unit]\nDescription=demo\n',
        );
    });

    test('orders keys within a section alphabetically', () => {
        const out = serializeUnitFile({
            Service: {
                ExecStart: '/bin/true',
                User: 'nobody',
                Restart: 'always',
            },
        });
        expect(out).toBe(
            '[Service]\nExecStart=/bin/true\nRestart=always\nUser=nobody\n',
        );
    });

    test('emits one line per element for string[] (repeated directives)', () => {
        const out = serializeUnitFile({
            Unit: { After: ['network.target', 'multi-user.target'] },
        });
        expect(out).toBe(
            '[Unit]\nAfter=network.target\nAfter=multi-user.target\n',
        );
    });

    test('renders Record<string,string> as Key=k=v lines, sorted by inner key', () => {
        const out = serializeUnitFile({
            Service: {
                Environment: { ZED: 'last', ALPHA: 'first', MID: 'middle' },
            },
        });
        expect(out).toBe(
            '[Service]\nEnvironment=ALPHA=first\nEnvironment=MID=middle\nEnvironment=ZED=last\n',
        );
    });

    test('renders booleans as true/false', () => {
        const out = serializeUnitFile({
            Service: { PrivateTmp: true, NoNewPrivileges: false },
        });
        expect(out).toBe('[Service]\nNoNewPrivileges=false\nPrivateTmp=true\n');
    });

    test('renders numbers via String()', () => {
        const out = serializeUnitFile({
            Service: { Nice: 5, OOMScoreAdjust: -500 },
        });
        expect(out).toBe('[Service]\nNice=5\nOOMScoreAdjust=-500\n');
    });

    test('omits undefined values entirely', () => {
        const out = serializeUnitFile({
            Service: {
                ExecStart: '/bin/true',
                User: undefined,
                Restart: 'always',
            },
        });
        expect(out).toBe('[Service]\nExecStart=/bin/true\nRestart=always\n');
    });

    test('throws when a value contains a newline', () => {
        expect(() =>
            serializeUnitFile({
                Service: { ExecStart: '/bin/echo\nhi' },
            }),
        ).toThrow(/Service\.ExecStart contains a newline/);
    });

    test('throws when a value contains a carriage return', () => {
        expect(() =>
            serializeUnitFile({
                Service: { Description: 'foo\rbar' },
            }),
        ).toThrow(/Service\.Description contains a newline/);
    });

    test('throws when one element of a string[] contains a newline', () => {
        expect(() =>
            serializeUnitFile({
                Unit: { After: ['ok.target', 'bad\nentry.target'] },
            }),
        ).toThrow(/Unit\.After contains a newline/);
    });

    test('renders nothing for an empty section but still emits the header', () => {
        const out = serializeUnitFile({ Unit: {} });
        expect(out).toBe('[Unit]\n');
    });

    test('an empty unit file yields just a trailing newline', () => {
        expect(serializeUnitFile({})).toBe('\n');
    });

    test('preserves insertion order of values inside a string[] (no sort within array)', () => {
        const out = serializeUnitFile({
            Unit: { After: ['z.target', 'a.target', 'm.target'] },
        });
        expect(out).toBe(
            '[Unit]\nAfter=z.target\nAfter=a.target\nAfter=m.target\n',
        );
    });
});

describe('withDefaults', () => {
    test('keeps default when override is undefined', () => {
        const out = withDefaults(
            { A: 'default-a', B: 'default-b' },
            { A: undefined },
        );
        expect(out).toEqual({ A: 'default-a', B: 'default-b' });
    });

    test('override wins when defined', () => {
        const out = withDefaults({ A: 'default-a' }, { A: 'override-a' });
        expect(out).toEqual({ A: 'override-a' });
    });

    test('adds keys present only in overrides', () => {
        const out = withDefaults({ A: 'd' }, { B: 'o' });
        expect(out).toEqual({ A: 'd', B: 'o' });
    });

    test('preserves keys present only in defaults', () => {
        const out = withDefaults({ A: 'd' }, {});
        expect(out).toEqual({ A: 'd' });
    });

    test('does not mutate the input objects', () => {
        const defaults = { A: 'd' };
        const overrides = { B: 'o' };
        withDefaults(defaults, overrides);
        expect(defaults).toEqual({ A: 'd' });
        expect(overrides).toEqual({ B: 'o' });
    });
});
