import { defineConfig } from 'vitest/config';
// Unit + fast physics tests. The slower realism contract lives in vitest.realism.config.ts.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['tests/realism.test.ts', 'node_modules/**'], testTimeout: 120_000 } });
