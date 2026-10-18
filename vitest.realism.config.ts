import { defineConfig } from 'vitest/config';
// The realism contract: balance, push recovery, locomotion speeds, contact rates, determinism, consistency.
export default defineConfig({ test: { include: ['tests/realism.test.ts'], testTimeout: 900_000 } });
