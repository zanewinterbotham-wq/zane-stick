import { existsSync, readFileSync, rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PICKS_OUT } from '../playwright.config';

test('audition, pick, choose a character, view 3D, pick effects, save', async ({ page }) => {
  rmSync(PICKS_OUT, { force: true });
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.row')).toHaveCount(5);
  await expect(page.locator('.group h2')).toHaveText(['Hits', 'Feet', 'UI']);

  // keyboard: first row is current; Space plays it through Web Audio (real decode of the fixture .ogg)
  await page.keyboard.press('Space');
  await expect(page.locator('#status')).toHaveText('Played hit_helmet_helmet_01');
  await page.keyboard.press('KeyX'); // pick 01
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('KeyX'); // pick 02
  await page.keyboard.press('KeyS'); // next category: foot_step_turf_01
  await page.keyboard.press('KeyP');
  await expect(page.locator('#status')).toHaveText('Played foot_step_turf_01');
  await page.keyboard.press('KeyS');
  await page.keyboard.press('KeyA'); // back to foot_step_turf_01
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('KeyX'); // pick foot_step_turf_02
  // mouse: play and pick the UI click, then unpick helmet 02
  await page.locator('[data-variant=ui_click_01] .play').click();
  await expect(page.locator('#status')).toHaveText('Played ui_click_01');
  await page.locator('[data-variant=ui_click_01] .heart').click();
  await page.locator('[data-variant=hit_helmet_helmet_02] .heart').click();
  await page.locator('[data-variant=hit_helmet_helmet_02] .heart').click();
  await expect(page.locator('[data-cat=hit_helmet_helmet] .picked')).toHaveText('2 picked');
  await expect(page.locator('#soundCount')).toHaveText('4 picked');
  await page.locator('[data-cat=foot_step_turf] input[type=range]').fill('0.5');
  await page.screenshot({ path: 'test-results/picker/01-sounds.png', fullPage: true });

  await page.getByRole('tab', { name: /Characters/ }).click();
  await expect(page.locator('#cards .card')).toHaveCount(2);
  await page.locator('[data-style=stick]').getByText('Choose this one').click();
  await expect(page.locator('#charName')).toHaveText('Stick (fixture)');
  await page.screenshot({ path: 'test-results/picker/02-characters.png' });
  await page.locator('[data-style=stick]').getByRole('button', { name: 'View 3D' }).click();
  await expect(page.locator('.vstatus')).toContainText('away.glb', { timeout: 20_000 }); // models sort by name
  await page.locator('.viewer').getByRole('button', { name: 'home' }).click();
  await expect(page.locator('.vstatus')).toContainText('home.glb', { timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/picker/03-viewer.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.layer')).toHaveCount(0);

  await page.getByRole('tab', { name: /Effects/ }).click();
  await expect(page.locator('[data-effect]')).toHaveCount(5);
  await page.locator('[data-effect=voxel]').getByRole('button', { name: 'Preview' }).click();
  await page.locator('[data-effect=voxel]').getByText('Pick').click();
  await page.locator('[data-effect=comic]').getByText('Pick').click();
  await expect(page.locator('#fxName')).toHaveText('Voxel blood +1');
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/picker/04-effects.png' });

  await page.locator('#notes').fill('test note');
  await page.getByRole('button', { name: 'Save to project' }).click();
  await expect(page.locator('#status')).toContainText('Saved to');
  expect(existsSync(PICKS_OUT)).toBe(true);
  expect(JSON.parse(readFileSync(PICKS_OUT, 'utf8'))).toEqual({
    version: 1,
    sounds: { hit_helmet_helmet: ['hit_helmet_helmet_01', 'hit_helmet_helmet_02'], foot_step_turf: ['foot_step_turf_02'], ui_click: ['ui_click_01'] },
    character: 'stick', volumes: { foot_step_turf: 0.5 }, effects: ['voxel', 'comic'], notes: 'test note',
  });

  // the endpoint rejects a malformed picks file
  const bad = await page.request.post('/api/picks', { data: { version: 1, sounds: { a: 'x' } } });
  expect(bad.status()).toBe(400);
  // reload: the saved state comes back, and nothing is unsaved
  await page.reload();
  await expect(page.locator('#soundCount')).toHaveText('4 picked');
  await expect(page.locator('#status')).toContainText('Loaded');
  expect(errors).toEqual([]);
});

test('choose a stadium, view it in 3D, save', async ({ page }) => {
  rmSync(PICKS_OUT, { force: true });
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('tab', { name: /Stadiums/ }).click();
  await expect(page.locator('#stadiumCards .card')).toHaveCount(1);
  await page.locator('[data-stadium=arena]').getByText('Choose this one').click();
  await expect(page.locator('#stadiumName')).toHaveText('Arena (fixture)');
  await expect(page.locator('[data-stadium=arena]')).toHaveClass(/chosen/);
  await page.screenshot({ path: 'test-results/picker/04-stadiums.png' });
  await page.locator('[data-stadium=arena]').getByRole('button', { name: 'View 3D' }).click();
  await expect(page.locator('.vstatus')).toContainText('arena.glb', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save to project' }).click();
  await expect(page.locator('#status')).toContainText('Saved to');
  expect(JSON.parse(readFileSync(PICKS_OUT, 'utf8'))).toEqual({ version: 1, sounds: {}, character: null, stadium: 'arena', volumes: {}, notes: '' });
  expect(errors).toEqual([]);
});
