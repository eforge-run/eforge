import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    setupFiles: ['./test/setup-test-env.ts'],
    include: [
      'test/**/*.test.ts',
      'packages/engine/test/**/*.test.ts',
      // --- eforge:region plan-04-monitor-ui ---
      'packages/monitor-ui/src/**/*.test.tsx',
      // --- eforge:endregion plan-04-monitor-ui ---
    ],
    server: {
      deps: {
        inline: [/^@eforge-build\//, /^@modelcontextprotocol\//],
        moduleDirectories: ['node_modules', 'packages/engine/node_modules', 'packages/eforge/node_modules'],
      },
    },
  },
  resolve: {
    alias: [
      { find: /^@eforge-build\/engine\/(.*)$/, replacement: resolve(root, 'packages/engine/src/$1') },
      { find: /^@eforge-build\/monitor\/(.*)$/, replacement: resolve(root, 'packages/monitor/src/$1') },
      { find: '@eforge-build/monitor', replacement: resolve(root, 'packages/monitor/src/index.ts') },
      { find: /^@eforge-build\/monitor-ui\/(.*)$/, replacement: resolve(root, 'packages/monitor-ui/src/$1') },
      { find: '@eforge-build/client', replacement: resolve(root, 'packages/client/src/index.ts') },
      // --- eforge:region plan-04-monitor-ui ---
      // @/ alias for monitor-ui src root — used by monitor-ui component test files.
      { find: /^@\/(.*)$/, replacement: resolve(root, 'packages/monitor-ui/src/$1') },
      // --- eforge:endregion plan-04-monitor-ui ---
      // @modelcontextprotocol/sdk is installed in packages/eforge/node_modules only; map sub-paths
      // to the ESM dist so test files can import from it directly.
      {
        find: /^@modelcontextprotocol\/sdk\/(.+)$/,
        replacement: resolve(root, 'packages/eforge/node_modules/@modelcontextprotocol/sdk/dist/esm/$1'),
      },
      {
        find: '@modelcontextprotocol/sdk',
        replacement: resolve(root, 'packages/eforge/node_modules/@modelcontextprotocol/sdk/dist/esm/index.js'),
      },
    ],
  },
});
