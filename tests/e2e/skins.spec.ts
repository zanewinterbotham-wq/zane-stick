import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const skins: { id: string; label: string }[] = JSON.parse(readFileSync('src/game/skins.json', 'utf8'));

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && /skin/.test(m.text()))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

type App = { renderer: { skin: { id: string }; athletes: { parts: unknown[] }[] } };
const skinState = (page: Page) => page.evaluate(() => {
  const r = (window as unknown as { __app: App }).__app.renderer;
  return { id: r.skin.id, parts: r.athletes.map((a) => a.parts.length) };
});


/** The AI carrier now dodges a straight run, so these UI tests have him walk into the human instead. */
async function carrierComesToYou(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    type V = [number, number, number];
    const d = (window as unknown as { __app: { drill: { carrier: number; human: number; brains: { think: unknown }[]; world: { athletes: { cmd: Record<string, unknown> }[] } } } }).__app.drill;
    d.brains[d.carrier] = { think: (p: { athletes: { com: V }[] }) => {
      const me = p.athletes[d.carrier].com, h = p.athletes[d.human].com, dx = h[0] - me[0], dz = h[2] - me[2], n = Math.hypot(dx, dz) || 1;
      return { ...d.world.athletes[d.carrier].cmd, move: { x: dx / n, z: dz / n }, face: null, gait: 'jog', carry: 2, dive: false, thrustHips: false };
    } };
  });
}

test('the default skin (the owner pick, Rubber Hose) dresses both athletes; standing and tackling', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum' })));
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await expect(page.getByRole('button', { name: /Skin:/ })).toHaveCount(0); // skins are chosen in the Inventory
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await expect.poll(() => skinState(page), { timeout: 30_000 }).toEqual({ id: 'rubberhose', parts: [21, 21] });
  await carrierComesToYou(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/skin-default-stand.png' });
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
  await page.evaluate(() => { (window as unknown as { __app: { cam: { mode: string } } }).__app.cam.mode = 'side'; });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: { drill: { world: { impact: { firstContactTime: number } } } } }).__app.drill.world.impact.firstContactTime), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/skin-default-tackle.png' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/skin-default-tackle-2.png' });
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  // the inventory equips a skin from the pause menu; it applies from the next rep
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Skin:/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Inventory/ }).click();
  await page.locator(`.inv-card[data-item="${skins[1].id}"] .equip`).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('zane-stick-settings-v1') ?? '{}').skin);
  expect(saved).toBe(skins[1].id);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  // anatomy view swaps the skin for the physics shapes
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Graphics' }).click();
  await page.getByRole('button', { name: 'Anatomy view: On' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Resume/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/skin-xray.png' });
  expect(errors).toEqual([]);
});

type Zs = {
  advance: (s: number) => number;
  world: { scene: { athletes: { state: { com: number[] } }[] } };
  renderer: { camera: { position: { set: (x: number, y: number, z: number) => void }; lookAt: (x: number, y: number, z: number) => void }; render: (w: unknown) => void };
};
for (const s of [...skins.map((k) => k.id), 'classic']) {
  test(`skin ${s}: sprinting athlete`, async ({ page }) => {
    const errors = watchErrors(page);
    // side view at standard detail, then a close front three-quarter view at minimum detail (fused segments)
    for (const [detail, file] of [['standard', 'sprint'], ['minimum', 'sprint-close']]) {
      await page.goto(`/?scenario=sprint&skin=${s}&cam=side&gfx=high&detail=${detail}`);
      await page.waitForFunction(() => (window as unknown as { __zs?: unknown }).__zs, null, { timeout: 60_000 });
      // small steps: the camera smoothing integrates per call
      await page.evaluate((close) => {
        const zs = (window as unknown as { __zs: Zs }).__zs;
        for (let i = 0; i < 50; i++) zs.advance(0.05);
        if (!close) return;
        const c = zs.world.scene.athletes[0].state.com;
        zs.renderer.camera.position.set(c[0] + 1.4, c[1] + 0.2, c[2] + 2.2);
        zs.renderer.camera.lookAt(c[0], c[1] - 0.05, c[2]);
        zs.renderer.render(zs.world);
      }, detail === 'minimum');
      await page.screenshot({ path: `test-results/skin-${s}-${file}.png` });
    }
    expect(errors).toEqual([]);
  });
}
