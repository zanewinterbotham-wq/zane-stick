import { expect, test } from '@playwright/test';

test('sprint and sink hold/toggle switches live in the Controls screen, not the pause menu', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', version: 2 })));
  await page.goto('/');
  await page.getByRole('button', { name: 'Controls' }).click();
  const sprint = page.getByRole('button', { name: /^Sprint: / });
  await expect(sprint).toHaveText('Sprint: hold');
  await sprint.click();
  await expect(sprint).toHaveText('Sprint: toggle (press on / off)');
  await expect(page.getByRole('button', { name: /^Sink hips: / })).toHaveText('Sink hips: hold');
  await page.screenshot({ path: 'test-results/15-controls-modes.png', fullPage: true });
});
