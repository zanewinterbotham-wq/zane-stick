// Runs the engine perf scenario in Chromium at 1x, 4x and 6x CPU throttling (Chromebook stand-in).
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const server = await createServer({ server: { port: 5199 }, logLevel: 'error', optimizeDeps: { exclude: ['@mujoco/mujoco'] } });
await server.listen();
const browser = await chromium.launch();
const results: Record<string, unknown> = {};
for (const rate of [1, 4, 6]) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.goto('http://localhost:5199/bench/engines/browser/index.html');
  await page.waitForFunction(() => (window as any).__done, null, { timeout: 600_000, polling: 1000 });
  results[`${rate}x`] = await page.evaluate(() => (window as any).__done);
  console.log(rate + 'x', JSON.stringify(results[`${rate}x`]));
  await page.close();
}
await browser.close();
await server.close();
mkdirSync('bench/out', { recursive: true });
writeFileSync('bench/out/engines-browser.json', JSON.stringify(results, null, 2));
