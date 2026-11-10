/**
 * References to task outputs. While tasks are defined, a reference is a proxy
 * returned by a task type (for fields that the type doesn't define itself). When loading finishes, the builder turns proxies
 * into tokens such as `$tunkki{h1.endpoint/ip}`, which are substituted with
 * actual outputs at plan and apply time.
 */

const REF = Symbol('tunkki.outputRef');
const TOKEN = /\$tunkki\{([^}]*)\}/g;

export interface OutputRef {
    id: string;
    path: string[];
}

/**
 * Creates a proxy that refers to a task's output, or a value inside it.
 */
export function outputRef(id: string, path: string[] = []): unknown {
    const ref: OutputRef = { id, path };
    return new Proxy(
        {},
        {
            get(_, prop) {
                if (prop === REF) {
                    return ref;
                } else if (prop === Symbol.toPrimitive || prop === 'toJSON') {
                    return () => tokenOf(ref);
                } else if (typeof prop === 'symbol') {
                    return undefined;
                }
                return outputRef(id, [...path, prop]);
            },
        },
    );
}

/**
 * Creates the object a task type returns: given fields (e.g. the task's id)
 * merged with a reference to the task's output. Given fields take precedence
 * over fields of the output with same names.
 */
export function withOutputRef<T extends object>(id: string, fields: T): T {
    const ref = outputRef(id) as Record<string | symbol, unknown>;
    return new Proxy(fields, {
        get(target, prop, receiver) {
            if (prop in target) {
                return Reflect.get(target, prop, receiver);
            }
            return ref[prop];
        },
    });
}

function tokenOf(ref: OutputRef): string {
    const parts = [ref.id, ...ref.path].map(encodeURIComponent);
    return `$tunkki{${parts.join('/')}}`;
}

function parseToken(content: string): OutputRef {
    const [id = '', ...path] = content.split('/').map(decodeURIComponent);
    return { id, path };
}

function isRef(value: object): boolean {
    return (value as Record<symbol, unknown>)[REF] !== undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Copies plain objects and arrays in a value, transforming strings and
 * references with the given function. Other values are kept as they are.
 */
function mapValue(
    value: unknown,
    leaf: (value: string | object) => unknown,
): unknown {
    if (typeof value === 'string') {
        return leaf(value);
    } else if (typeof value === 'object' && value !== null && isRef(value)) {
        return leaf(value);
    } else if (Array.isArray(value)) {
        return value.map((item) => mapValue(item, leaf));
    } else if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                mapValue(item, leaf),
            ]),
        );
    }
    return value;
}

/**
 * Replaces output proxies in a value with tokens.
 */
export function replaceRefs(value: unknown): unknown {
    return mapValue(value, (leaf) =>
        typeof leaf === 'string' ? leaf : String(leaf),
    );
}

/**
 * Finds output tokens in a value.
 */
export function findRefs(value: unknown): OutputRef[] {
    // Tokens are URI-encoded, so JSON never escapes anything inside them
    const json = JSON.stringify(value) ?? '';
    return [...json.matchAll(TOKEN)].map((match) => parseToken(match[1] ?? ''));
}

export interface Substituted {
    value: unknown;

    /**
     * Tokens that could not be resolved. They are left in value as is.
     */
    unresolved: string[];
}

/**
 * Substitutes output tokens in a value.
 * @param value Value with tokens.
 * @param lookup Gets a task's output, or undefined if it is not known.
 * @throws If a token embedded in a string refers to an object.
 */
export function substituteState(
    value: unknown,
    lookup: (id: string) => unknown,
): Substituted {
    const unresolved: string[] = [];
    const resolve = (token: string, content: string) => {
        const ref = parseToken(content);
        let current = lookup(ref.id);
        for (const key of ref.path) {
            current =
                typeof current === 'object' && current !== null
                    ? (current as Record<string, unknown>)[key]
                    : undefined;
        }
        if (current === undefined) {
            unresolved.push(token);
        }
        return current;
    };

    const substituted = mapValue(value, (leaf) => {
        const text = leaf as string;
        const whole = text.match(/^\$tunkki\{([^}]*)\}$/);
        if (whole) {
            // Whole-value token keeps the type of the output
            const output = resolve(text, whole[1] ?? '');
            return output === undefined ? text : output;
        }
        return text.replaceAll(TOKEN, (token, content: string) => {
            const output = resolve(token, content);
            if (output === undefined) {
                return token;
            } else if (typeof output === 'object' && output !== null) {
                throw new Error(
                    `${token} refers to an object, which cannot be embedded in a string`,
                );
            }
            return String(output);
        });
    });
    return { value: substituted, unresolved };
}
