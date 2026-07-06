import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Алиас @/* дублирует tsconfig paths: vitest не читает tsconfig, резолвим явно.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/__tests__/**'],
    },
  },
});
