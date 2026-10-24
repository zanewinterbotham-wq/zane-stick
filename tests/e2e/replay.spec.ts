// Instant replay / photo mode viewer: the scrubber, the key-hint buttons, Escape not exiting, no context menu.
import { expect, test, type Page } from '@playwright/test';
import { seed, watchErrors } from './helpers';

type Pb = { t: number; paused: boolean; speed: number; buf: { start: number; end: number } };
const play = (page: Page) => page.evaluate(() => {
  const p = (window as unknown as { __app: { view: { play: Pb } } }).__app.view.play;
  return { t: p.t, paused: p.paused, speed: p.speed, start: p.buf.start, end: p.buf.end };
});
const frac = (p: { t: number; start: number; end: number }) => (p.t - p.start) / (p.end - p.start);

test('replay: scrubber click and drag, buttons, C and Exit leave, Escape does not, no context menu', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page);
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await page.waitForTimeout(2500); // some seconds of game to record
  await page.keyboard.press('KeyC');
  const box = page.locator('.viewer');
  await expect(box).toBeVisible();
  // the Space button pauses (a playing replay would drift away from the scrubbed spot)
  await page.getByRole('button', { name: /^Space:/ }).click();
  expect((await play(page)).paused).toBe(true);
  // clicking anywhere on the bar jumps there; dragging follows
  const tr = (await page.locator('.viewer .track').boundingBox())!;
  expect(tr.height).toBeGreaterThanOrEqual(14);
  expect(tr.width).toBeGreaterThan(900);
  await page.mouse.click(tr.x + tr.width * 0.5, tr.y + tr.height / 2);
  expect(frac(await play(page))).toBeCloseTo(0.5, 1);
  await page.mouse.move(tr.x + tr.width * 0.5, tr.y + 7);
  await page.mouse.down();
  await page.mouse.move(tr.x + tr.width * 0.9, tr.y + 7 + 40); // off the bar: the capture keeps scrubbing
  await page.mouse.up();
  expect(frac(await play(page))).toBeCloseTo(0.9, 1);
  // the hint buttons do what their keys do
  await page.getByRole('button', { name: /^1:/ }).click();
  expect((await play(page)).speed).toBe(0.25);
  const t0 = (await play(page)).t;
  await page.getByRole('button', { name: /^←/ }).click();
  expect((await play(page)).t).toBeCloseTo(t0 - 0.25, 1);
  // right-click on the view: no browser menu (the page cancels the event)
  const prevented = await page.evaluate(() => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('canvas')!.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(true);
  // Escape does not leave
  await page.keyboard.press('Escape');
  await expect(box).toBeVisible();
  await page.screenshot({ path: 'test-results/replay-viewer.png' });
  await page.getByRole('button', { name: /^Exit/ }).click();
  await expect(box).toBeHidden();
  // photo mode: Exit button, row centred, Escape ignored, P leaves
  await page.keyboard.press('KeyP');
  await expect(box).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box).toBeVisible();
  const row = (await page.locator('.viewer .ctl').boundingBox())!;
  expect(Math.abs(row.x + row.width / 2 - 683)).toBeLessThan(2);
  await expect(page.getByRole('button', { name: /^Save picture/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/photo-viewer.png' });
  await page.keyboard.press('KeyP');
  await expect(box).toBeHidden();
  await page.keyboard.press('KeyC');
  await expect(box).toBeVisible();
  await page.keyboard.press('KeyC');
  await expect(box).toBeHidden();
  expect(errors).toEqual([]);
});
