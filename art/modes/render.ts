// Mode preview pictures, rendered by the game itself: for each mode, headless Chromium opens the built site, starts
// the mode from the Play menu with its default options, lets a bot brain play the human's role for a moment, and
// saves the chase camera's view to public/modes/<id>.jpg.
//   npm run build && npx tsx art/modes/render.ts [mode ids…]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { MODES } from '../../src/sim/modes/registry';

/** Seconds of play before the picture (default AT_DEFAULT): the moment that shows what the mode is about. */
const AT: Record<string, number> = { tackle: 1.4, carry: 1.2, oklahoma: 0.5, kickoffReturn: 4, kickoff: 1.4, puntReturn: 4.2, puntBlock: 1.8, fieldGoalBlock: 1.5 };
const AT_DEFAULT = 1;
Object.assign(AT, { gauntlet: 3, sumo: 1.3, keepaway: 0.6, scramble: 2.2, goalline: 1, hitstick: 2.6, pass: 2.65 });
const PORT = 4191;

const ids = process.argv.slice(2).length ? process.argv.slice(2) : MODES.map((m) => m.id);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { shell: true, stdio: 'ignore' });
try {
  const url = `http://localhost:${PORT}/`;
  for (let i = 0; ; i++) { try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ } if (i > 60) throw new Error('preview server did not start'); await new Promise((r) => setTimeout(r, 500)); }
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const id of ids) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'high', mute: true })));
    await page.goto(url);
    await page.getByRole('button', { name: /^Play/ }).click({ timeout: 60_000 });
    await page.locator(`.mode-card[data-mode="${id}"]`).click();
    await page.getByRole('button', { name: 'Start' }).click();
    await page.waitForFunction(() => { const a = (window as unknown as { __app: { drill: unknown; paused: boolean } }).__app; return a.drill && !a.paused; }, null, { timeout: 60_000 });
    await page.evaluate((t) => {
      type D = { brains: unknown[]; roleBrain(i: number): unknown; step(): void; world: { dt: number } };
      const app = (window as unknown as { __app: { paused: boolean; drill: D; hud: { setVisible(on: boolean): void } } }).__app, d = app.drill;
      app.paused = true;
      d.brains[0] = d.roleBrain(0);
      for (let i = 0; i < t / d.world.dt; i++) d.step();
      app.hud.setVisible(false);
    }, AT[id] ?? AT_DEFAULT);
    await page.waitForTimeout(1000); // the camera settles on the paused frame
    await page.locator('#view').screenshot({ path: `public/modes/${id}.jpg`, type: 'jpeg', quality: 82 });
    console.log('rendered', id);
    await page.close();
  }
  await browser.close();
} finally {
  // the server runs under a shell: on Windows only a tree kill stops vite itself
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); else server.kill();
}
