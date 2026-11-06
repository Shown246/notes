import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/browser/**/*.browser.ts'], testTimeout: 60000 }
});
