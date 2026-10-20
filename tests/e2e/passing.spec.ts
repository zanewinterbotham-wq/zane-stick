// QB throw schemes (docs/passing.md): switching while playing (1–6, V), the HUD panel and flash, each scheme's aim aid,
// the saved choice, the Settings row, and the pass reaching the human input. Runs in Ball Carrier (the player holds
// the ball); the QB 1-on-1 part runs once the mode 'pass' is in the registry.
import { expect, test, type Page } from '@playwright/test';

type App = { __app: { passer: { scheme: { id: string } } } };

async function start(page: Page, mode: RegExp, settings: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((s) => { if (!localStorage.getItem('zane-stick-settings-v1')) localStorage.setItem('zane-stick-settings-v1', JSON.stringify(s)); },
    { preset: 'minimum', perf: { worker: false }, version: 7, ...settings });
  await page.goto('/');
  await page.getByRole('button', { name: /^Play/ }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: mode }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.passhud')).toBeVisible({ timeout: 60_000 });
  return errors;
}
const scheme = (page: Page) => page.evaluate(() => (window as unknown as App).__app.passer.scheme.id);
/** Every bot stands still (UI test: the rep must not end under it). */
const stillBots = (page: Page) => page.evaluate(() => {
  const d = (window as unknown as { __app: { drill: { human: number; brains: { think: unknown }[]; world: { athletes: { cmd: Record<string, unknown> }[] } } } }).__app.drill;
  d.brains.forEach((_, i) => { if (i !== d.human) d.brains[i] = { think: () => ({ ...d.world.athletes[i].cmd, move: { x: 0, z: 0 }, dive: false, jump: false, thrustHips: false, pass: null }) }; });
});
/** A mouse flick up and to the right over 8 frames (headless has no pointer lock, so the counts go in directly). */
const flick = (page: Page) => page.evaluate(() => new Promise<void>((done) => {
  const m = (window as unknown as { __app: { input: { mouse: { x: number; y: number } } } }).__app.input.mouse;
  let n = 0;
  const step = () => { m.x += 60; m.y -= 120; if (++n < 8) requestAnimationFrame(step); else done(); };
  requestAnimationFrame(step);
}));
const NAMES = ['Aim & charge', 'Target lock', 'Placement reticle', 'Bullet / lob buttons', 'Flick', 'Auto QB'];

test('throw schemes: 1–6 and V switch while playing, each shows its aim aid, the choice is saved', async ({ page }) => {
  const errors = await start(page, /^Ball Carrier/);
  await expect(page.locator('.status')).toContainText('YOU HAVE IT');
  await expect(page.locator('.passhud')).toContainText('Throw scheme 2/6: Target lock'); // the default
  await expect(page.locator('.keylist')).toContainText('Throw scheme');                  // the help rows, while he holds the ball
  await stillBots(page); // the tackler would end the rep before every aid is on screen
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(`Digit${i + 1}`);
    await expect(page.locator('.toast')).toHaveText(`Throw scheme ${i + 1}/6: ${NAMES[i]}`);
    await expect(page.locator('.passhud')).toContainText(NAMES[i]);
    const holds = [0, 1, 2, 4].includes(i); // hold schemes show the meter while Throw is down
    if (holds) { await page.keyboard.down('KeyF'); await page.waitForTimeout(400); }
    if (i === 4) await flick(page);
    if (holds) await expect(page.locator('.passhud .meter')).toBeVisible();
    await page.screenshot({ path: `test-results/passing-${i + 1}.png` });
    // switch away before letting go: a switch drops the half-done hold, so nothing is thrown here
    if (holds) { await page.keyboard.press(`Digit${((i + 1) % 6) + 1}`); await page.keyboard.up('KeyF'); }
  }
  await page.keyboard.press('Digit6');
  await page.keyboard.press('KeyV');
  await expect(page.locator('.toast')).toHaveText('Throw scheme 1/6: Aim & charge'); // V wraps round
  expect(await scheme(page)).toBe('charge');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zane-stick-settings-v1')!).throwScheme)).toBe('charge');
  // a throw reaches the human input (Auto QB: one press)
  await page.keyboard.press('Digit6');
  await page.evaluate(() => { // record the pass the human brain sees in a step (it rides on the input only 120 ms)
    const h = (window as unknown as { __app: { human: { latest: { pass?: unknown } | null; think: (...a: unknown[]) => unknown } } }).__app.human, think = h.think.bind(h);
    h.think = (...a) => { if (h.latest?.pass) (window as unknown as { __saw: unknown }).__saw = h.latest.pass; return think(...a); };
  });
  await page.keyboard.press('KeyF');
  const pass = await page.waitForFunction(() => (window as unknown as { __saw?: unknown }).__saw ?? null, null, { timeout: 5000 }).then((h) => h.jsonValue() as Promise<{ at: number[]; loft: number }>);
  expect(pass.at).toHaveLength(3); expect(pass.loft).toBeGreaterThanOrEqual(0);
  await page.reload();
  await page.getByRole('button', { name: /^Quick play/ }).click({ timeout: 60_000 });
  await expect(page.locator('.passhud')).toContainText('Throw scheme 6/6: Auto QB', { timeout: 60_000 }); // remembered
  expect(errors).toEqual([]);
});

test('Settings → Controls lists the throw keys and the QB throw scheme choice', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false }, version: 7 })));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Controls' }).click();
  await expect(page.locator('tr[data-action="throw"] .keys-cell')).toHaveText('F');
  await expect(page.locator('tr[data-action="scheme"] .keys-cell')).toHaveText('V');
  const pick = page.getByRole('button', { name: 'QB throw scheme: 5 Flick', exact: true });
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zane-stick-settings-v1')!).throwScheme)).toBe('flick');
  await page.screenshot({ path: 'test-results/passing-settings.png', fullPage: true });
});

test('QB 1-on-1: the QB starts with the ball, the scheme panel shows, and every aim aid draws', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Play/ }).click({ timeout: 60_000 });
  test.skip(await page.getByRole('button', { name: /^QB 1-on-1/ }).count() === 0, "mode 'pass' is not in the registry on this branch");
  const errors = await start(page, /^QB 1-on-1/);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(`Digit${i + 1}`);
    await expect(page.locator('.passhud')).toContainText(NAMES[i]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/passing-qb-${i + 1}.png` });
  }
  expect(errors).toEqual([]);
});

test('QB 1-on-1, 2 v 2 in zone with a concept (remembered options): five athletes, the status names them', async ({ page }) => {
  const errors = await start(page, /^QB 1-on-1/, { modeOptions: { pass: { receivers: 2, coverage: 'zone', concept: 'smash' } } });
  await expect(page.locator('.status')).toContainText('smash  ·  zone');
  expect(await page.evaluate(() => (window as unknown as { __app: { drill: { world: { athletes: unknown[] } } } }).__app.drill.world.athletes.length)).toBe(5);
  await page.waitForTimeout(1500); // the routes and the drops under way
  await page.screenshot({ path: 'test-results/passing-qb-2v2.png' });
  expect(errors).toEqual([]);
});
