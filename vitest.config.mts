import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./packages/core/src/app', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'packages/**/*.test.tsx', 'apps/web/lib/**/*.test.ts'],
    // Screenshot and preview tooling copies apps into e2e/.scratch.
    exclude: [...configDefaults.exclude, '**/.scratch/**'],
    environment: 'node',
  },
});
