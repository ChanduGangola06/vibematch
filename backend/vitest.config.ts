import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/setup-env.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // server.ts / container.ts are the process bootstrap: covered by `npm run smoke`, not by unit tests
      exclude: ['src/**/*.d.ts', 'src/**/index.ts', 'src/server.ts', 'src/container.ts', 'src/core/http/types.ts'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
