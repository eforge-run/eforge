import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // CLI entry point
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node22',
    clean: true,
    dts: false,
    external: [/^@eforge-build\//, /^ts-morph/, 'commander', 'yaml', 'zod'],
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    // Library entry: check module for use in tests
    entry: { check: 'src/check.ts' },
    format: ['esm'],
    target: 'node22',
    clean: false,
    dts: true,
    external: [/^@eforge-build\//, /^ts-morph/, 'commander', 'yaml', 'zod'],
  },
]);
