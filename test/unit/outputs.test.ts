import { describe, expect, test } from 'bun:test';
import {
    findRefs,
    outputRef,
    replaceRefs,
    substituteState,
} from '../../local/outputs';

const outputs: Record<string, unknown> = {
    'h1.a': { port: 80, tags: ['x'], nothing: null },
    'h1.b': 'plain',
};
const lookup = (id: string) => outputs[id];

describe('output refs', () => {
    test('stringify to tokens', () => {
        const ref = outputRef('h1.a') as Record<string, unknown>;
        expect(`${ref.port}`).toBe('$tunkki{h1.a/port}');
        expect(JSON.stringify({ x: ref.port })).toBe(
            '{"x":"$tunkki{h1.a/port}"}',
        );
        expect(String(ref)).toBe('$tunkki{h1.a}');
    });

    test('are replaced inside plain objects and arrays only', () => {
        const ref = outputRef('h1.a') as Record<string, unknown>;
        const bytes = new Uint8Array([1, 2]);
        expect(replaceRefs({ a: [ref.port], b: bytes, c: 1 })).toEqual({
            a: ['$tunkki{h1.a/port}'],
            b: bytes,
            c: 1,
        });
    });

    test('are found in tokens', () => {
        expect(findRefs({ a: ['x $tunkki{h1.a/port} $tunkki{h1.b}'] })).toEqual(
            [
                { id: 'h1.a', path: ['port'] },
                { id: 'h1.b', path: [] },
            ],
        );
    });
});

describe('substituteState', () => {
    test('whole-value tokens keep their type', () => {
        expect(
            substituteState(
                {
                    port: '$tunkki{h1.a/port}',
                    tags: '$tunkki{h1.a/tags}',
                    nothing: '$tunkki{h1.a/nothing}',
                },
                lookup,
            ),
        ).toEqual({
            value: { port: 80, tags: ['x'], nothing: null },
            unresolved: [],
        });
    });

    test('embedded tokens stringify primitives', () => {
        expect(
            substituteState(
                ['http://$tunkki{h1.b}:$tunkki{h1.a/port}/'],
                lookup,
            ),
        ).toEqual({ value: ['http://plain:80/'], unresolved: [] });
    });

    test('embedding an object fails', () => {
        expect(() =>
            substituteState('tags: $tunkki{h1.a/tags}', lookup),
        ).toThrow(/refers to an object/);
    });

    test('reports unresolved tokens and leaves them in place', () => {
        expect(
            substituteState(
                {
                    a: '$tunkki{h1.missing}',
                    b: 'x$tunkki{h1.a/nope}',
                    c: '$tunkki{h1.b/length}',
                },
                lookup,
            ),
        ).toEqual({
            value: {
                a: '$tunkki{h1.missing}',
                b: 'x$tunkki{h1.a/nope}',
                c: '$tunkki{h1.b/length}',
            },
            unresolved: [
                '$tunkki{h1.missing}',
                '$tunkki{h1.a/nope}',
                '$tunkki{h1.b/length}',
            ],
        });
    });

    test('decodes ids and paths', () => {
        expect(
            substituteState('$tunkki{h1.we%2Fird/a%2Fb}', (id) =>
                id === 'h1.we/ird' ? { 'a/b': 1 } : undefined,
            ),
        ).toEqual({ value: 1, unresolved: [] });
    });
});
