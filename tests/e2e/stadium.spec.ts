import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const stadiums: { id: string; label: string }[] = JSON.parse(readFileSync('src/game/stadiums.json', 'utf8'));

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && /stadium/.test(m.text()))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

type Zs = {
  advance: (s: number) => number;
  renderer: { camera: { position: { set: (x: number, y: number, z: number) => void }; lookAt: (x: number, y: number, z: number) => void }; render: (w: unknown) => void };
  world: unknown;
};

for (const s of [...stadiums, { id: 'field', label: 'Open Field' }]) {
  test(`stadium ${s.id}: chase camera in the drill and a wide shot`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum' })));
    await page.goto(`/?stadium=${s.id}`);
    await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
    await page.keyboard.press('Enter');
    await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __app: { renderer: { stadium: { id: string } } } }).__app.renderer.stadium.id)).toBe(s.id);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/stadium-${s.id}-chase.png` });

    // wide shot from above the sideline at full graphics (the dev view has no athletes' physics wall; the art shows it)
    await page.goto(`/?scenario=stand&stadium=${s.id}&gfx=high`);
    await page.waitForFunction(() => (window as unknown as { __zs?: unknown }).__zs, null, { timeout: 60_000 });
    await page.evaluate(() => {
      const zs = (window as unknown as { __zs: Zs }).__zs;
      zs.advance(0.5);
      zs.renderer.camera.position.set(-70, 46, -92);
      zs.renderer.camera.lookAt(0, 0, 8);
      zs.renderer.render(zs.world);
    });
    await page.screenshot({ path: `test-results/stadium-${s.id}-wide.png` });
    expect(errors).toEqual([]);
  });
}

test('the inventory lists skins and stadiums; equipping a stadium is remembered and shows on the next rep', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => { if (!localStorage.getItem('zane-stick-settings-v1')) localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum' })); });
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.getByRole('button', { name: /^Inventory/ }).click();
  const panel = page.getByRole('dialog', { name: 'Inventory' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveText(['Skins', 'Stadiums']);
  await expect(panel.locator('.inv-card')).toHaveCount(9); // 8 skins and Classic
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.inv-card img')].every((i) => i.complete && i.naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: 'test-results/inventory-skins.png' });

  await panel.getByRole('tab', { name: 'Stadiums' }).click();
  await expect(panel.locator('.inv-card')).toHaveCount(stadiums.length + 1); // and the Open Field
  await expect(panel.locator('.inv-card.equipped h3')).toHaveText(stadiums[0].label);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.inv-card img')].every((i) => i.complete && i.naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: 'test-results/inventory-stadiums.png' });

  const other = stadiums.find((x) => x.id === 'night')!; // not the default (the owner picked the dome)
  await panel.locator(`.inv-card[data-item="night"] .equip`).click();
  await expect(panel.locator('.inv-card.equipped h3')).toHaveText(other.label);
  await expect(panel.locator('[role=status]')).toContainText('next rep');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zane-stick-settings-v1') ?? '{}').stadium)).toBe('night');
  await page.screenshot({ path: 'test-results/inventory-equipped.png' });

  // Esc goes back to the title; the next rep is played in the stadium just equipped
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK');
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: { renderer: { stadium: { id: string } } } }).__app.renderer.stadium.id)).toBe('night');
  expect(errors).toEqual([]);
});
