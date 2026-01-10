import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 600000,
    hookTimeout: 10000,
    include: ['tests/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts', '**/*.spec.ts', '**/tests/**'],
    },
    passWithNoTests: true,
    setupFiles: ['vitest.setup.ts'],
    fileParallelism: false,
  },
});
