import { expect, test, type Page } from '@playwright/test';
import { seed, watchErrors } from './helpers';

const KEY = 'zane-stick-settings-v1';
const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), KEY);
const openSettings = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true }).click();
const tab = (page: Page, name: string) => page.getByRole('tab', { name }).click();

test('settings: title menu has Settings and no skin button; every tab opens, a value changes and persists', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page, {}, 'once');
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await expect(page.getByRole('button', { name: /Skin:|Difficulty:|Quality:/ })).toHaveCount(0);
  await openSettings(page);
  await expect(page.getByRole('tab')).toHaveText(['Gameplay', 'Controls', 'Camera', 'Graphics', 'Audio', 'Gore', 'Advanced']);

  await page.screenshot({ path: 'test-results/settings-gameplay.png' });
  await page.getByRole('slider', { name: 'Hit power' }).fill('2.5');

  await tab(page, 'Controls');
  await page.screenshot({ path: 'test-results/settings-controls.png' });
  await page.getByRole('button', { name: 'Sprint: toggle (press on / off)' }).click();

  await tab(page, 'Camera');
  await page.screenshot({ path: 'test-results/settings-camera.png' });
  await page.getByRole('button', { name: 'Camera view: Helmet' }).click();

  await tab(page, 'Graphics');
  await page.screenshot({ path: 'test-results/settings-graphics.png' });
  // the ladder, one line per level, and the Advanced overrides over the chosen one
  await expect(page.getByRole('group', { name: 'Quality', exact: true }).getByRole('button')).toHaveText(['Potato', 'Low', 'Medium', 'High', 'Ultra']);
  await expect(page.getByRole('list', { name: 'Quality levels' }).getByRole('listitem')).toHaveCount(5);
  await page.getByRole('button', { name: 'Quality: High' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: /^High/ })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('button', { name: 'Physics rate: Level (480 Hz)' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Shadow quality: 1024' }).click();
  await page.getByRole('button', { name: 'Shadow quality: 1024' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/settings-graphics-advanced.png' });
  await page.getByRole('button', { name: 'Effort shading: Off' }).click();

  await tab(page, 'Audio');
  await page.screenshot({ path: 'test-results/settings-audio.png' });
  await page.getByRole('button', { name: 'Sound: Off' }).click();

  await tab(page, 'Gore');
  await page.screenshot({ path: 'test-results/settings-gore.png' });
  await page.getByRole('button', { name: 'Gore: High' }).click();

  await tab(page, 'Advanced');
  await page.locator('details').evaluateAll((ds) => ds.forEach((d) => ((d as HTMLDetailsElement).open = true))); // tuning categories start collapsed
  await page.screenshot({ path: 'test-results/settings-advanced.png' });
  await page.getByRole('button', { name: 'Performance overlay: On' }).click();
  // the Jump section: each knob moved is stored on its own over the defaults
  await page.getByRole('slider', { name: 'Jump height', exact: true }).fill('1.5');
  await page.getByRole('slider', { name: 'Charge time' }).fill('0.5');
  await page.getByRole('slider', { name: 'Jump height', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/settings-advanced-jump.png' });

  expect(await stored(page)).toMatchObject({ jump: { height: 1.5, charge: 0.5 }, hitPower: 2.5, sprintToggle: true, camera: 'helmet', preset: 'high', perf: { shadowMap: 1024 }, effortShading: false, mute: true, goreLevel: 3, overlay: true });

  // a reload keeps all of it
  await page.reload();
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await openSettings(page);
  await expect(page.getByRole('slider', { name: 'Hit power' })).toHaveValue('2.5');
  await tab(page, 'Controls');
  await expect(page.getByRole('button', { name: 'Sprint: toggle (press on / off)' })).toHaveAttribute('aria-pressed', 'true');
  await tab(page, 'Camera');
  await expect(page.getByRole('button', { name: 'Camera view: Helmet' })).toHaveAttribute('aria-pressed', 'true');
  await tab(page, 'Graphics');
  await expect(page.getByRole('button', { name: 'Quality: High' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Shadow quality: 1024' })).toHaveAttribute('aria-pressed', 'true');
  await tab(page, 'Audio');
  await expect(page.getByRole('button', { name: 'Sound: Off' })).toHaveAttribute('aria-pressed', 'true');
  await tab(page, 'Gore');
  await expect(page.getByRole('button', { name: 'Gore: High' })).toHaveAttribute('aria-pressed', 'true');
  await tab(page, 'Advanced');
  await page.locator('details').evaluateAll((ds) => ds.forEach((d) => ((d as HTMLDetailsElement).open = true))); // tuning categories start collapsed
  await expect(page.getByRole('button', { name: 'Performance overlay: On' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('slider', { name: 'Jump height', exact: true })).toHaveValue('1.5');
  await page.getByRole('button', { name: 'Reset jump to defaults' }).click();
  await expect(page.getByRole('slider', { name: 'Jump height', exact: true })).toHaveValue('1.35');
  await expect(page.getByRole('slider', { name: 'Charge time' })).toHaveValue('0.25');
  expect((await stored(page)).jump).toMatchObject({ height: 1.35, charge: 0.25 }); // back to the game's values
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK');
  expect(errors).toEqual([]);
});

test('settings: the pause menu keeps only Resume, Reset rep, Settings, Inventory and Quit', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page);
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu h1')).toHaveText('Paused');
  await expect(page.locator('.menu .item')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/settings-pause-menu.png' });
  await openSettings(page);
  await expect(page.locator('.menu h1')).toHaveText('Settings');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('.menu h1')).toHaveText('Paused');
  expect(errors).toEqual([]);
});
