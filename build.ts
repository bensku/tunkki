await Bun.build({
    entrypoints: ['./remote/index.ts'],
    compile: {
        outfile: './tunkki',
    },
});
