// The QB throw control in the page (docs/passing.md: the placement reticle; the other schemes are vaulted): the HUD panel
// and meter while he holds the ball, the pass reaching the human input (following the passer), the help and Settings
// rows, and in QB 1-on-1 the arc keeping the throw's loft through the throwing motion.
import { expect, test, type Page } from '@playwright/test';

type Aim = { aid: { arc?: { loft: number }; meter?: number } } | null;
type App = { __app: { aim: Aim; human: { latest: { pass?: unknown } | null; think: (...a: unknown[]) => unknown } } };

async function start(page: Page, mode: RegExp) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { if (!localStorage.getItem('zane-stick-settings-v1')) localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false }, mute: true })); });
  await page.goto('/');
  await page.getByRole('button', { name: /^Play/ }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: mode }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.passhud')).toBeVisible({ timeout: 60_000 });
  return errors;
}
/** Every bot stands still (UI test: the rep must not end under it). */
const stillBots = (page: Page) => page.evaluate(() => {
  const d = (window as unknown as { __app: { drill: { human: number; brains: { think: unknown }[]; world: { athletes: { cmd: Record<string, unknown> }[] } } } }).__app.drill;
  d.brains.forEach((_, i) => { if (i !== d.human) d.brains[i] = { think: () => ({ ...d.world.athletes[i].cmd, move: { x: 0, z: 0 }, dive: false, jump: false, thrustHips: false, pass: null }) }; });
});

test('placement reticle: the panel, the hold meter, and the pass on the human input', async ({ page }) => {
  const errors = await start(page, /^Ball Carrier/);
  await expect(page.locator('.status')).toContainText('YOU HAVE IT');
  await expect(page.locator('.passhud')).toContainText('Placement reticle');
  await expect(page.locator('.passhud')).not.toContainText('1–6');            // no scheme switching any more
  await expect(page.locator('.keylist')).toContainText('Throw (hold for more loft)');
  await stillBots(page);
  await page.evaluate(() => { // record the pass the human brain sees in a step (it rides on the input only 120 ms)
    const h = (window as unknown as App).__app.human, think = h.think.bind(h);
    h.think = (...a) => { if (h.latest?.pass) (window as unknown as { __saw: unknown }).__saw = h.latest.pass; return think(...a); };
  });
  await page.keyboard.down('KeyF'); await page.waitForTimeout(400);
  await expect(page.locator('.passhud .meter')).toBeVisible();
  await page.screenshot({ path: 'test-results/passing-reticle.png' });
  await page.keyboard.up('KeyF');
  const pass = await page.waitForFunction(() => (window as unknown as { __saw?: unknown }).__saw ?? null, null, { timeout: 5000 }).then((h) => h.jsonValue() as Promise<{ at: number[]; loft: number; follow?: boolean }>);
  expect(pass.at).toHaveLength(3); expect(pass.loft).toBeGreaterThan(0.3); expect(pass.follow).toBe(true);
  expect(errors).toEqual([]);
});

test('Settings → Controls lists the throw key and no scheme choice', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false } })));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Controls' }).click();
  await expect(page.locator('tr[data-action="throw"] .keys-cell')).toHaveText('F');
  await expect(page.locator('tr[data-action="scheme"]')).toHaveCount(0);
  await expect(page.getByText('QB throw scheme')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/passing-settings.png', fullPage: true });
});

test('QB 1-on-1: the reticle draws, and after the release the arc keeps the held loft through the throwing motion', async ({ page }) => {
  const errors = await start(page, /^QB 1-on-1/);
  await expect(page.locator('.passhud')).toContainText('Placement reticle');
  await page.keyboard.down('KeyF'); await page.waitForTimeout(700); // a full-loft hold
  await page.screenshot({ path: 'test-results/passing-qb-hold.png' });
  const held = await page.evaluate(() => (window as unknown as App).__app.aim?.aid.arc?.loft ?? -1);
  expect(held).toBeGreaterThan(0.9);
  await page.keyboard.up('KeyF');
  // sample the arc for the throwing motion (0.4 s): never back to the flat, unheld arc
  const lofts: number[] = [];
  for (let k = 0; k < 8; k++) { lofts.push(await page.evaluate(() => (window as unknown as App).__app.aim?.aid.arc?.loft ?? -1)); await page.waitForTimeout(40); }
  await page.screenshot({ path: 'test-results/passing-qb-release.png' });
  expect(lofts.filter((l) => l >= 0 && l < 0.9)).toEqual([]);
  expect(errors).toEqual([]);
});
