import { describe, expect, test } from 'bun:test';
import { renderDnsOption, renderIdMap } from '../../task/podman/pod';
import {
    renderAddHost,
    renderPublishPort,
    renderVolume,
} from '../../task/util/podman';

describe('renderPublishPort', () => {
    test('returns undefined for undefined input', () => {
        expect(renderPublishPort(undefined)).toBeUndefined();
    });

    test('passes a raw string through', () => {
        expect(renderPublishPort('127.0.0.1:8080:80/tcp')).toEqual([
            '127.0.0.1:8080:80/tcp',
        ]);
    });

    test('renders a bare containerPort entry', () => {
        // No host, no hostPort -> just the container port number.
        expect(renderPublishPort({ containerPort: 80 })).toEqual(['80']);
    });

    test('renders hostPort:containerPort when host is omitted', () => {
        expect(
            renderPublishPort({ hostPort: 8080, containerPort: 80 }),
        ).toEqual(['8080:80']);
    });

    test('renders host::containerPort when hostPort is omitted but host is set', () => {
        // Setting host without hostPort produces the empty middle field, e.g.
        // `127.0.0.1::80` (Podman picks a random host port).
        expect(
            renderPublishPort({ host: '127.0.0.1', containerPort: 80 }),
        ).toEqual(['127.0.0.1::80']);
    });

    test('renders host:hostPort:containerPort when all are set', () => {
        expect(
            renderPublishPort({
                host: '127.0.0.1',
                hostPort: 8080,
                containerPort: 80,
            }),
        ).toEqual(['127.0.0.1:8080:80']);
    });

    test('appends /protocol suffix', () => {
        expect(
            renderPublishPort({
                hostPort: 53,
                containerPort: 53,
                protocol: 'udp',
            }),
        ).toEqual(['53:53/udp']);
    });

    test('renders an array of mixed string and structured entries', () => {
        expect(
            renderPublishPort([
                { hostPort: 8080, containerPort: 80 },
                '443:443/tcp',
                { containerPort: 9000 },
            ]),
        ).toEqual(['8080:80', '443:443/tcp', '9000']);
    });
});

describe('renderVolume', () => {
    test('returns undefined for undefined input', () => {
        expect(renderVolume(undefined)).toBeUndefined();
    });

    test('passes a raw string through', () => {
        expect(renderVolume('/host:/cont:ro')).toEqual(['/host:/cont:ro']);
    });

    test('renders an anonymous (target-only) volume', () => {
        expect(renderVolume({ target: '/data' })).toEqual(['/data']);
    });

    test('renders a host-path bind mount', () => {
        expect(renderVolume({ source: '/srv/foo', target: '/data' })).toEqual([
            '/srv/foo:/data',
        ]);
    });

    test('renders a Quadlet-volume reference', () => {
        expect(renderVolume({ source: 'foo.volume', target: '/data' })).toEqual(
            ['foo.volume:/data'],
        );
    });

    test('joins options with commas', () => {
        expect(
            renderVolume({
                source: '/srv/foo',
                target: '/data',
                options: ['ro', 'Z'],
            }),
        ).toEqual(['/srv/foo:/data:ro,Z']);
    });

    test('omits the option suffix when options is empty', () => {
        expect(
            renderVolume({
                source: '/srv/foo',
                target: '/data',
                options: [],
            }),
        ).toEqual(['/srv/foo:/data']);
    });

    test('renders an array of mixed string and structured entries', () => {
        expect(
            renderVolume([
                '/host:/cont',
                { target: '/anon' },
                { source: 'data.volume', target: '/data', options: ['ro'] },
            ]),
        ).toEqual(['/host:/cont', '/anon', 'data.volume:/data:ro']);
    });
});

describe('renderAddHost', () => {
    test('returns undefined for undefined input', () => {
        expect(renderAddHost(undefined)).toBeUndefined();
    });

    test('wraps a single string in an array', () => {
        expect(renderAddHost('foo:1.2.3.4')).toEqual(['foo:1.2.3.4']);
    });

    test('passes a string array through as-is', () => {
        expect(renderAddHost(['foo:1.2.3.4', 'bar:5.6.7.8'])).toEqual([
            'foo:1.2.3.4',
            'bar:5.6.7.8',
        ]);
    });

    test('renders a record as host:ip lines', () => {
        expect(renderAddHost({ foo: '1.2.3.4', bar: '5.6.7.8' })).toEqual([
            'foo:1.2.3.4',
            'bar:5.6.7.8',
        ]);
    });
});

describe('renderIdMap', () => {
    test('returns undefined for undefined input', () => {
        expect(renderIdMap(undefined)).toBeUndefined();
    });

    test('renders a single structured entry', () => {
        expect(
            renderIdMap({ containerId: 0, hostId: 1000, size: 65536 }),
        ).toEqual(['0:1000:65536']);
    });

    test('emits the + prefix for relative mappings', () => {
        expect(
            renderIdMap({
                containerId: 0,
                hostId: 1000,
                size: 65536,
                relative: true,
            }),
        ).toEqual(['+0:1000:65536']);
    });

    test('passes a raw string through', () => {
        expect(renderIdMap('0:1000:65536')).toEqual(['0:1000:65536']);
    });

    test('renders an array of mixed string and structured entries', () => {
        expect(
            renderIdMap([
                { containerId: 0, hostId: 1000, size: 1 },
                '1:1001:65535',
                { containerId: 100, hostId: 100, size: 1, relative: true },
            ]),
        ).toEqual(['0:1000:1', '1:1001:65535', '+100:100:1']);
    });
});

describe('renderDnsOption', () => {
    test('returns undefined for undefined input', () => {
        expect(renderDnsOption(undefined)).toBeUndefined();
    });

    test('wraps a single string in an array', () => {
        expect(renderDnsOption('ndots:2')).toEqual(['ndots:2']);
    });

    test('passes a string array through as-is', () => {
        expect(renderDnsOption(['ndots:2', 'rotate'])).toEqual([
            'ndots:2',
            'rotate',
        ]);
    });

    test('renders record entries as key:value', () => {
        expect(renderDnsOption({ ndots: '2' })).toEqual(['ndots:2']);
    });

    test('emits the bare option name when value is true', () => {
        // Record value === true means the option is a flag (no value).
        expect(renderDnsOption({ debug: true, ndots: '2' })).toEqual([
            'debug',
            'ndots:2',
        ]);
    });
});
