import { defineConfig } from '@playwright/test';

// End-to-end checks against the production build served by `vite preview`.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1366, height: 768 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: [
    { command: 'npm run build && npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173', timeout: 180_000, reuseExistingServer: true },
    // net.spec.ts: the local room server, and a dev server whose /api proxy reaches it (it imports src/net directly).
    { command: 'npm run dev:rooms', url: 'http://127.0.0.1:8787/api/room', timeout: 120_000, reuseExistingServer: true, env: { WRANGLER_SEND_METRICS: 'false' } },
    { command: 'npx vite --port 5181 --strictPort', url: 'http://localhost:5181/src/net/protocol.ts', timeout: 60_000, reuseExistingServer: true },
  ],
});
