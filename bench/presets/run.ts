// Physics and render cost per preset, in Chromium, at 1x / 4x / 6x CPU throttling (Chromebook stand-in).
//   npm run build && npx tsx bench/presets/run.ts [skin]   (skin id from src/game/skins.json or 'classic'; default voxel)
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';

const port = +(process.env.PORT ?? 4174); // another checkout may hold the default
const server = await preview({ preview: { port, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const skin = process.argv[2] ?? 'voxel';
const out: Record<string, unknown> = { skin };
for (const rate of [1, 4, 6]) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.goto(`http://localhost:${port}/?bench=1&skin=${skin}`);
  await page.waitForFunction(() => (window as any).__bench, null, { timeout: 600_000, polling: 1000 });
  const r = await page.evaluate(() => (window as any).__bench);
  out[`${rate}x`] = r.results;
  console.log(`--- ${rate}x CPU throttle\n${r.report}`);
  await page.close();
}
await browser.close();
server.httpServer.close();
mkdirSync('bench/out', { recursive: true });
writeFileSync(`bench/out/presets-${skin}.json`, JSON.stringify(out, null, 2));
