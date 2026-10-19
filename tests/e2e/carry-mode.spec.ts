import { expect, test } from '@playwright/test';

test('carry mode: start with the ball, the bot is the tackler', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false }, version: 2 })));
  await page.goto('/');
  await page.getByRole('button', { name: /^Play/ }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Ball Carrier/ }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.status')).toContainText('BALL CARRIER', { timeout: 60_000 });
  await expect(page.locator('.status')).toContainText('YOU HAVE IT');
  await page.screenshot({ path: 'test-results/16-carry-mode.png' });
  expect(errors).toEqual([]);
});
