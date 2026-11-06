/**
 * First step returns nothing, though it has a next step.
 */
export const apply = [
    { location: 'remote', handler: async () => undefined },
    { location: 'remote', handler: async () => 'unreachable' },
];
