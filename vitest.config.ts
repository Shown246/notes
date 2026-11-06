import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20000,
    hookTimeout: 120000,
    maxWorkers: 1,
    fileParallelism: false
  }
});
