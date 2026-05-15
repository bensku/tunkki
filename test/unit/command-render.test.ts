import { describe, expect, test } from 'bun:test';
import { renderCommand } from '../../task/util/systemd';

describe('renderCommand', () => {
    test('returns undefined when input is undefined', () => {
        expect(renderCommand(undefined)).toBeUndefined();
    });

    test('passes a string input through verbatim (no escaping)', () => {
        // Strings are an escape hatch — the caller takes responsibility for
        // shell quoting. We must not touch them.
        expect(renderCommand('/bin/echo "hello world"')).toBe(
            '/bin/echo "hello world"',
        );
    });

    test('renders an empty argv as the empty string', () => {
        expect(renderCommand([])).toBe('');
    });

    test('joins multiple safe args with single spaces', () => {
        expect(renderCommand(['/bin/echo', 'hello'])).toBe('/bin/echo hello');
    });

    test('leaves args with only safe characters unquoted', () => {
        // Safe set: [A-Za-z0-9_\-./@:=+,%]
        const safe = [
            '/bin/echo',
            '--flag=value',
            'a/b/c.txt',
            'user@host:path',
            '127.0.0.1',
            '50%',
            'a,b,c',
            '_underscored',
        ];
        for (const arg of safe) {
            expect(renderCommand([arg])).toBe(arg);
        }
    });

    test('quotes an arg containing a space', () => {
        expect(renderCommand(['/bin/echo', 'hello world'])).toBe(
            '/bin/echo "hello world"',
        );
    });

    test('quotes args containing shell metacharacters', () => {
        expect(renderCommand(['x;y'])).toBe('"x;y"');
        expect(renderCommand(['$HOME'])).toBe('"$HOME"');
        expect(renderCommand(['a|b'])).toBe('"a|b"');
        expect(renderCommand(['a&b'])).toBe('"a&b"');
        expect(renderCommand(['a(b)'])).toBe('"a(b)"');
    });

    test('escapes embedded double quotes', () => {
        expect(renderCommand(['say "hi"'])).toBe('"say \\"hi\\""');
    });

    test('escapes embedded backslashes', () => {
        expect(renderCommand(['c:\\path\\to\\file'])).toBe(
            '"c:\\\\path\\\\to\\\\file"',
        );
    });

    test('renders the empty string as ""', () => {
        expect(renderCommand([''])).toBe('""');
    });

    test('renders the empty string in the middle of an argv', () => {
        expect(renderCommand(['/bin/cmd', '', 'tail'])).toBe(
            '/bin/cmd "" tail',
        );
    });

    test('mixes safe and unsafe args correctly', () => {
        expect(renderCommand(['/usr/bin/env', 'NAME=foo bar', '/bin/sh'])).toBe(
            '/usr/bin/env "NAME=foo bar" /bin/sh',
        );
    });

    test('a single-quote in an arg triggers quoting (single quotes are NOT in the safe set)', () => {
        // Single quotes have no special meaning to systemd's parser, but they
        // are not in the safe set, so the arg gets wrapped in double quotes.
        // The single quote itself is not escaped (only " and \ are).
        expect(renderCommand(["it's"])).toBe('"it\'s"');
    });
});
