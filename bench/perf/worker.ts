// Physics on the page versus in the Worker, in Chromium (needs a build): frames per second and how fast the play's
// clock runs against the wall clock (1 = real time; below 1 the page cannot keep up and drops time), per level and
// scene. CPU throttling is not used: Chromium's emulation slows the page's thread, not the Worker's.
//   npm run build && PORT=4274 npx tsx bench/perf/worker.ts [preset ids…]
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const port = +(process.env.PORT ?? 4174), names = process.argv.slice(2).length ? process.argv.slice(2) : ['minimum', 'high'];
const server = await preview({ preview: { port, strictPort: true }, logLevel: 'error' });
// GPU=1: the machine's own GPU (headless still), else SwiftShader (CPU rendering, which competes with the Worker)
const browser = await chromium.launch({ args: process.env.GPU ? ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const scenes = [{ id: 'tackle 2', mode: 'tackle', options: {} }, { id: 'kickoff return 17', mode: 'kickoffReturn', options: { block: 7, cover: 9 } }];
type W = { __app: { fps: number; physMs: number; drill: { world: { time: number } } } };
for (const preset of names) for (const sc of scenes) for (const worker of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.addInitScript((s) => localStorage.setItem('zane-stick-settings-v1', JSON.stringify(s)),
    { preset, perf: { worker }, mute: true, slowMo: false, mode: sc.mode, modeOptions: { [sc.mode]: sc.options } });
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.querySelector('.menu h1')?.textContent === 'ZANE STICK', null, { timeout: 120_000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !!(window as unknown as W).__app.drill?.world, null, { timeout: 120_000 });
  await page.waitForTimeout(1000);
  const read = () => page.evaluate(() => { const a = (window as unknown as W).__app; return { t: a.drill.world.time, now: performance.now(), fps: a.fps, phys: a.physMs }; });
  const a = await read();
  await page.waitForTimeout(5000);
  const b = await read();
  console.log(`${preset.padEnd(8)} ${sc.id.padEnd(18)} ${worker ? 'worker' : 'page  '}: ${b.fps.toFixed(0).padStart(3)} fps, play clock ${((b.t - a.t) / ((b.now - a.now) / 1000)).toFixed(2)}x real time, physics ${b.phys.toFixed(1)} ms/frame`);
  await page.close();
}
await browser.close();
server.httpServer.close();
