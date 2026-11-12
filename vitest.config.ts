import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@agent-dream/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    setupFiles: ['./scripts/no-network-guard.ts'],
    testTimeout: 30000,
    pool: 'forks',
  },
});
