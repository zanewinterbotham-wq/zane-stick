import { expect, test } from '@playwright/test';

test('the sprint hold/toggle switch lives in the Controls screen, not the pause menu', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', version: 2 })));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Controls' }).click();
  const sprint = (mode: string) => page.getByRole('button', { name: `Sprint: ${mode}`, exact: true });
  await expect(sprint('hold')).toHaveAttribute('aria-pressed', 'true');
  await sprint('toggle (press on / off)').click();
  await expect(sprint('toggle (press on / off)')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Sink hips/ })).toHaveCount(0); // lowering the pads sinks the hips
  await page.screenshot({ path: 'test-results/15-controls-modes.png', fullPage: true });
});
