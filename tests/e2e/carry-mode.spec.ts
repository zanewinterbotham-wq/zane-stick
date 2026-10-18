import { expect, test } from '@playwright/test';

test('carry mode: start with the ball, the bot is the tackler', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', version: 2 })));
  await page.goto('/');
  await page.getByRole('button', { name: /carry the ball/ }).click({ timeout: 60_000 });
  await expect(page.locator('.status')).toContainText('BALL CARRIER', { timeout: 60_000 });
  await expect(page.locator('.status')).toContainText('YOU HAVE IT');
  await page.screenshot({ path: 'test-results/16-carry-mode.png' });
  expect(errors).toEqual([]);
});
