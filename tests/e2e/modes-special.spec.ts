import { expect, test } from '@playwright/test';

// The special-teams modes start from the Play menu with their options, put four athletes on the field by default,
// and the kick goes up. Screenshots: test-results/4x-<mode>.png.
const SPECIAL: [string, string, string[]][] = [
  ['kickoffReturn', 'KICKOFF RETURN', ['block', 'cover', 'distance']],
  ['kickoff', 'KICKOFF COVERAGE', ['cover', 'block', 'distance']],
  ['puntReturn', 'PUNT RETURN', ['block', 'cover', 'distance', 'los']],
  ['puntBlock', 'PUNT BLOCK', ['rush', 'protect', 'kickTime']],
  ['fieldGoalBlock', 'FIELD GOAL BLOCK', ['rush', 'protect', 'distance', 'kickTime']],
];

SPECIAL.forEach(([id, title, options], k) => test(`special teams: ${id} starts with its options and kicks`, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', mute: true })));
  await page.goto('/');
  await page.getByRole('button', { name: /^Play/ }).click({ timeout: 60_000 });
  await page.locator(`.mode-card[data-mode=${id}]`).click();
  for (const o of options) await expect(page.locator(`[data-option=${o}]`)).toHaveCount(1);
  await expect(page.locator('.mode-setup [role=status]')).toHaveText('4 athletes on the field.');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.status')).toContainText(title, { timeout: 60_000 });
  type App = { drill: { world: { athletes: unknown[] }; ballPos(): number[] } };
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.drill.world.athletes.length)).toBe(4);
  // the ball goes up: a kick (or, on a field goal try, the snap-to-kick time) within a few seconds of play
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.drill.ballPos()[1]), { timeout: 30_000 }).toBeGreaterThan(2); // above any hand that holds it
  await page.waitForTimeout(800);
  await page.screenshot({ path: `test-results/4${k}-${id}.png` });
  expect(errors).toEqual([]);
}));
