// vite.config.ts
// vitest config for coverage analysis

import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [],
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/types.ts', 'src/**/index.ts'],
      reporter: ['text', 'json', 'html'],
    },
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 5_000,
  },
})
