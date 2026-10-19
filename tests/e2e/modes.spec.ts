import { expect, test } from '@playwright/test';
import { MODES } from '../../src/sim/modes/registry';

test('Play: mode cards with previews, a setup with options that are remembered, and Start', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { if (!localStorage.getItem('zane-stick-settings-v1')) localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false } })); });
  await page.goto('/');
  await page.getByRole('button', { name: /^Play/ }).click({ timeout: 60_000 });
  const cards = page.locator('.mode-card');
  await expect(cards).toHaveCount(MODES.length);
  for (const id of ['tackle', 'carry', 'oklahoma', 'kickoffReturn', 'gauntlet', 'sumo', 'keepaway', 'scramble', 'goalline', 'hitstick']) {
    const img = page.locator(`.mode-card[data-mode=${id}] img`);
    await img.scrollIntoViewIfNeeded(); // lazy images load once on screen
    await expect(img).toHaveJSProperty('complete', true, { timeout: 30_000 });
    expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  }
  await page.screenshot({ path: 'test-results/20-modes.png' });

  // the carry setup: tacklers and blockers; above four athletes it warns about low-end devices
  await page.getByRole('button', { name: /^Ball Carrier/ }).click();
  await expect(page.locator('.mode-setup h1')).toHaveText('Ball Carrier');
  await expect(page.locator('.mode-setup [role=status]')).toHaveText('2 athletes on the field.');
  await page.locator('input[data-option=tacklers]').fill('3');
  await page.locator('input[data-option=blockers]').fill('2');
  await expect(page.locator('.mode-setup [role=status]')).toContainText('6 athletes on the field. May run slowly');
  await page.screenshot({ path: 'test-results/21-mode-setup.png' });
  await page.locator('input[data-option=tacklers]').fill('2');
  await page.locator('input[data-option=blockers]').fill('1');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.status')).toContainText('BALL CARRIER', { timeout: 60_000 });
  await expect(page.locator('.status')).toContainText('YOU HAVE IT');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: { drill: { world: { athletes: unknown[] } } } }).__app.drill.world.athletes.length)).toBe(4);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/22-carry-blockers.png' });

  // back at the title, Quick play remembers the mode; the setup remembers its options
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Quit to title' }).click();
  await expect(page.getByRole('button', { name: /^Quick play: Ball Carrier/ })).toBeVisible();
  await page.getByRole('button', { name: /^Play/ }).click();
  await page.getByRole('button', { name: /^Ball Carrier/ }).click();
  await expect(page.locator('input[data-option=tacklers]')).toHaveValue('2');
  await expect(page.locator('input[data-option=blockers]')).toHaveValue('1');

  // the Oklahoma drill: pick a role and a lane width, then play it
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: /^Oklahoma Drill/ }).click();
  await page.getByRole('button', { name: 'Blocker', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Blocker', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('input[data-option=width]').fill('7');
  await expect(page.locator('.mode-setup')).toContainText('7 yd');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.status')).toContainText('OKLAHOMA DRILL', { timeout: 60_000 });
  await expect(page.locator('.status')).toContainText('You are the blocker');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/23-oklahoma.png' });
  expect(errors).toEqual([]);
});
