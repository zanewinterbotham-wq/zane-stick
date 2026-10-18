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
  webServer: { command: 'npm run build && npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173', timeout: 180_000, reuseExistingServer: true },
});
