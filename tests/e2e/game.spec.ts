import { expect, test, type Page } from '@playwright/test';

/** Fail on any console error or uncaught exception. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('title loads, drill starts, scripted input plays a rep without errors', async ({ page }) => {
  const errors = watchErrors(page);
  // skip the first-launch benchmark for speed; it has its own test below
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum' })));
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.screenshot({ path: 'test-results/01-title.png' });
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  // run at the carrier, switch to contact mode, sink, reach and wrap
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Tab');
  await page.keyboard.down('Space');
  await page.waitForTimeout(500);
  await page.keyboard.down('KeyJ'); await page.keyboard.down('KeyL'); await page.keyboard.down('KeyK');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/02-play.png' });
  for (const k of ['KeyW', 'Space', 'KeyJ', 'KeyL', 'KeyK']) await page.keyboard.up(k);
  await expect(page.locator('.status')).toContainText('CONTACT');
  // overlay and anatomy view
  await page.keyboard.press('Backquote');
  await page.keyboard.press('KeyX');
  await page.waitForTimeout(800);
  await expect(page.locator('.overlay')).toContainText('FPS');
  await page.screenshot({ path: 'test-results/03-overlay-xray.png' });
  // reset rep, pause menu
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu h1')).toHaveText('Paused');
  await page.screenshot({ path: 'test-results/04-pause.png' });
  expect(errors).toEqual([]);
});

test('key test screen shows held keys', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum' })));
  await page.goto('/');
  await page.getByRole('button', { name: 'Key test' }).click();
  await page.keyboard.down('KeyW'); await page.keyboard.down('KeyJ');
  await expect(page.locator('.keys')).toContainText('KeyW');
  await expect(page.locator('.keys')).toContainText('KeyJ');
  await page.screenshot({ path: 'test-results/05-keytest.png' });
  expect(errors).toEqual([]);
});

test('first launch runs the benchmark and picks a preset', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 90_000 });
  const preset = await page.evaluate(() => JSON.parse(localStorage.getItem('zane-stick-settings-v1') ?? '{}').preset);
  expect(['minimum', 'high']).toContain(preset);
  expect(errors).toEqual([]);
});
