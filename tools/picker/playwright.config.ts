import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// `npm run test:picker`: the dev picker on its fixtures, saving picks to a temp file (never art/picks.json).
export const PICKS_OUT = join(tmpdir(), 'zane-stick-picker-e2e', 'picks.json');
const repo = resolve(import.meta.dirname, '../..');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  outputDir: join(repo, 'test-results/picker'),
  use: {
    baseURL: 'http://localhost:5181',
    viewport: { width: 1366, height: 768 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
    command: 'npx vite --config tools/picker/vite.config.ts --port 5181 --strictPort',
    cwd: repo,
    url: 'http://localhost:5181',
    reuseExistingServer: false,
    env: { PICKER_LIBRARY: 'fixtures', PICKER_PICKS: PICKS_OUT, PICKER_NO_OPEN: '1' },
  },
});
