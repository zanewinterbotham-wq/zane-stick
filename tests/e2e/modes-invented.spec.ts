import { expect, test } from '@playwright/test';

// The invented modes from the Play menu: their options show, the athlete count warning follows them, and each starts.
test('Invented modes: Sumo Ring options and Start, Keep Away and the Gauntlet start with their rules in the HUD', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { if (!localStorage.getItem('zane-stick-settings-v1')) localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum' })); });
  await page.goto('/');
  await page.getByRole('button', { name: /^Play/ }).click({ timeout: 60_000 });

  await page.getByRole('button', { name: /^Sumo Ring/ }).click();
  await expect(page.locator('.mode-setup h1')).toHaveText('Sumo Ring');
  await expect(page.locator('.mode-setup [role=status]')).toHaveText('2 athletes on the field.');
  await page.locator('input[data-option=perSide]').fill('2');
  await expect(page.locator('.mode-setup [role=status]')).toHaveText('4 athletes on the field.');
  await page.locator('input[data-option=radius]').fill('4.5');
  await page.screenshot({ path: 'test-results/24-sumo-setup.png' });
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.status')).toContainText('SUMO RING', { timeout: 60_000 });
  await expect(page.locator('.status')).toContainText('2 v 2');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'test-results/25-sumo.png' });

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Quit to title' }).click();
  await page.getByRole('button', { name: /^Play/ }).click();
  await page.getByRole('button', { name: /^Keep Away/ }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.status')).toContainText('KEEP AWAY', { timeout: 60_000 });
  await expect(page.locator('.status')).toContainText('Hold the ball');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Quit to title' }).click();
  await page.getByRole('button', { name: /^Play/ }).click();
  await page.getByRole('button', { name: /^The Gauntlet/ }).click();
  await page.locator('input[data-option=tacklers]').fill('4');
  await expect(page.locator('.mode-setup [role=status]')).toContainText('5 athletes on the field. May run slowly');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.status')).toContainText('THE GAUNTLET', { timeout: 60_000 });
  await expect(page.locator('.status')).toContainText('4 tacklers');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'test-results/26-gauntlet.png' });
  expect(errors).toEqual([]);
});
