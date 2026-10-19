// The quality ladder in the real page: the lowest level plays (overlay names it) and the physics Worker mode runs a
// rep off the page's thread, the athlete moving under the player's keys.
import { expect, test, type Page } from '@playwright/test';

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

type App = { __app: { sim: { play: unknown } | null; drill: { world: { time: number; scene: { athletes: { state: { com: number[] } }[] } } } } };
const com = (page: Page) => page.evaluate(() => [...(window as unknown as App).__app.drill.world.scene.athletes[0].state.com]);

async function play(page: Page, settings: object) {
  await page.addInitScript((s) => localStorage.setItem('zane-stick-settings-v1', JSON.stringify(s)), settings);
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await page.mouse.move(683, 384);
}

test('Potato plays: 200 Hz physics, the overlay names the level', async ({ page }) => {
  const errors = watchErrors(page);
  await play(page, { preset: 'potato', overlay: true, mute: true });
  const c0 = await com(page);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
  const c1 = await com(page);
  expect(Math.hypot(c1[0] - c0[0], c1[2] - c0[2])).toBeGreaterThan(0.5);
  await expect(page.locator('.panel.overlay')).toContainText('Potato');
  await expect(page.locator('.panel.overlay')).toContainText('200 Hz');
  await page.screenshot({ path: 'test-results/perf-potato.png' });
  expect(errors).toEqual([]);
});

test('worker mode: the rep runs in the physics Worker and the athlete moves under the keys', async ({ page }) => {
  const errors = watchErrors(page);
  await play(page, { preset: 'minimum', perf: { worker: true }, overlay: true, mute: true });
  expect(await page.evaluate(() => { const a = (window as unknown as App).__app; return !!a.sim && a.sim.play === a.drill; })).toBe(true);
  const t0 = await page.evaluate(() => (window as unknown as App).__app.drill.world.time), c0 = await com(page);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
  const t1 = await page.evaluate(() => (window as unknown as App).__app.drill.world.time), c1 = await com(page);
  expect(t1 - t0).toBeGreaterThan(0.8); // the replica follows the Worker's clock
  expect(Math.hypot(c1[0] - c0[0], c1[2] - c0[2])).toBeGreaterThan(0.5);
  await page.screenshot({ path: 'test-results/perf-worker.png' });
  // a new rep goes to the Worker too
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Reset rep/ }).click();
  await expect.poll(() => page.evaluate(() => { const a = (window as unknown as App).__app; return !!a.sim && a.sim.play === a.drill && a.drill.world.time < 1.5; })).toBe(true);
  expect(errors).toEqual([]);
});
