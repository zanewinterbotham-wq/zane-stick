import { expect, test, type Browser, type Page } from '@playwright/test';
import { pickMode, seed, watchErrors } from './helpers';

// Multiplayer end to end (docs/multiplayer.md) against the local room server (npm run dev:rooms) through the Vite dev
// server's /api proxy (playwright.config.ts starts both): A hosts, B joins by the invite link, B takes a position, both
// ready, A starts; B's keys move B's athlete in A's simulation. C joins mid-game by typing the code and watches.
const DEV = process.env.MP_DEV ?? 'http://localhost:5181/'; // MP_DEV: a dev server on another port
// Headless contexts can't resolve each other's mDNS host candidates; plain local addresses let WebRTC connect.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=WebRtcHideLocalIpsWithMdns'] } });

type App = { __app: { net: { lobby: { players: { name: string; via: string }[]; assign: (string | null)[]; phase: string }; selfId: string; replica: { time: number } | null } | null;
  drill: { human: number; world: { time: number; scene: { athletes: { state: { com: Float64Array } }[] } } } | null; countdownUntil: number } };

async function open(browser: Browser, name: string, path = ''): Promise<{ page: Page; errors: string[] }> {
  const page = await (await browser.newContext()).newPage(), errors = watchErrors(page);
  await seed(page, { netName: name });
  await page.goto(DEV + path);
  return { page, errors };
}
const lobby = (p: Page) => p.evaluate(() => (window as unknown as App).__app.net?.lobby ?? null);
const com = (p: Page, i: number) => p.evaluate((i) => [...(window as unknown as App).__app.drill!.world.scene.athletes[i].state.com], i);

test('host, join by link and by code, position menu, ready, start, guest input on the host, spectator', async ({ browser }) => {
  test.setTimeout(240_000);
  const A = await open(browser, 'Ana'), a = A.page;
  await expect(a.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 90_000 });
  await a.getByRole('button', { name: /^Multiplayer/ }).click();
  await expect(a.locator('.mp-screen')).toBeVisible();
  await a.screenshot({ path: 'test-results/mp-01-host-or-join.png' });
  await a.getByRole('button', { name: /^Host a game/ }).click();
  const code = (await a.locator('.room-code').textContent({ timeout: 30_000 }))!.trim();
  expect(code).toMatch(/^[2-9A-HJKMNP-Z]{5}$/);

  // B opens the invite link: his name is saved, so he joins at once
  const B = await open(browser, 'Ben', `?join=${code}`), b = B.page;
  await expect(b.locator('.lobby')).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => (await lobby(a))?.players.map((p) => p.name)).toEqual(['Ana', 'Ben']);
  await expect.poll(async () => (await lobby(b))?.players.map((p) => p.name)).toEqual(['Ana', 'Ben']);

  // A picks Ball Carrier and adds a blocker; B takes the blocker slot (his team-mate)
  await a.getByRole('button', { name: 'Change mode' }).click();
  await pickMode(a, a.locator('.lobby .mode-card[data-mode="carry"]'));
  await expect(b.locator('.lobby-mode h3')).toHaveText('Ball Carrier'); // guests see the mode change live
  await a.getByRole('button', { name: 'Add a blocker' }).click();
  await expect(b.locator('.slot .pos')).toHaveText(['Ball carrier', 'Blocker', 'Tackler']); // team 0's column, then team 1's
  await b.locator('.slot', { hasText: 'Blocker' }).click();
  await expect(a.locator('.slot', { hasText: 'Blocker' })).toContainText('Ben');
  await expect(a.locator('.slot', { hasText: 'Tackler' })).toContainText('BOT');
  const benId = await b.evaluate(() => (window as unknown as App).__app.net!.selfId);
  expect((await lobby(a))!.assign).toEqual([expect.any(String), null, benId]);
  // the host drags Ben onto the Tackler, then puts him back with the Blocker's dropdown
  await a.locator('.slot', { hasText: 'Blocker' }).locator('.chip').dragTo(a.locator('.slot', { hasText: 'Tackler' }));
  await expect(b.locator('.slot.mine')).toContainText('Tackler');
  await a.locator('.slot-wrap', { hasText: 'Blocker' }).locator('select').selectOption({ label: 'Ben' });
  await expect(b.locator('.slot.mine')).toContainText('Blocker');
  expect((await lobby(a))!.assign).toEqual([expect.any(String), null, benId]);
  await expect(a.getByRole('button', { name: 'Start', exact: true })).toBeDisabled(); // Ben is not ready
  await b.getByRole('button', { name: 'Ready up' }).click();
  await expect(a.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  await expect.poll(async () => (await lobby(a))!.players[1].via, { timeout: 15_000 }).toMatch(/rtc|relay/);
  await a.screenshot({ path: 'test-results/mp-02-lobby-host.png' });
  await b.screenshot({ path: 'test-results/mp-03-lobby-guest.png' });
  await b.setViewportSize({ width: 390, height: 844 });
  await b.screenshot({ path: 'test-results/mp-04-lobby-phone.png', fullPage: true });
  await b.setViewportSize({ width: 1366, height: 768 });

  // start: 3-2-1 on both screens, then the play
  await a.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(a.locator('.countdown')).toBeVisible();
  await expect(b.locator('.countdown')).toBeVisible({ timeout: 10_000 });
  await expect(b.locator('.status')).toContainText('BALL CARRIER', { timeout: 30_000 });
  await expect(b.locator('.status')).toContainText('You: Blocker');
  await a.waitForFunction(() => { const app = (window as unknown as App).__app; return app.drill && performance.now() > app.countdownUntil && app.drill.world.time > 1; }, null, { timeout: 30_000 });
  await b.waitForFunction(() => ((window as unknown as App).__app.net?.replica?.time ?? 0) > 0.5, null, { timeout: 30_000 });

  // B holds W: his athlete (slot 2) runs up the field in A's simulation, and B sees it on his replica
  const before = await com(a, 2);
  await b.keyboard.down('KeyW');
  await a.waitForTimeout(1500);
  await b.keyboard.up('KeyW');
  const after = await com(a, 2);
  console.log(`Ben's athlete on the host moved ${(after[2] - before[2]).toFixed(2)} m along +Z`);
  expect(after[2] - before[2]).toBeGreaterThan(1.5);
  await b.waitForTimeout(400);
  const seen = await com(b, 2);
  expect(Math.hypot(seen[0] - after[0], seen[2] - after[2])).toBeLessThan(1.5); // the replica is ~0.1 s behind
  await a.screenshot({ path: 'test-results/mp-05-game-host.png' });
  await b.screenshot({ path: 'test-results/mp-06-game-guest.png' });
  // name tags: over everyone but yourself, the person's name or BOT (3 athletes: host, guest, a bot)
  const tags = (p: Page) => p.evaluate(() => (window as unknown as { __app: { renderer: { tags: { root: { children: unknown[] }; key: string } } } }).__app.renderer.tags.key);
  const texts = async (p: Page) => (JSON.parse((await tags(p)) || '[]') as ({ text: string } | null)[]).map((t) => t?.text ?? null);
  await expect.poll(() => texts(b)).toEqual(['Ana', 'BOT', null]); // Ben (slot 2) sees the host by name and the bot
  await expect.poll(() => texts(a)).toEqual([null, 'BOT', 'Ben']);
  await b.screenshot({ path: 'test-results/mp-06b-name-tags.png' });

  // the next rep only when both players ask: A's Enter alone changes nothing, B's too starts rep 2 on both screens
  const repOf = (p: Page) => p.evaluate(() => (window as unknown as { __app: { net: { start: { rep: number } | null } } }).__app.net?.start?.rep ?? -1);
  const rep0 = await repOf(a);
  // the play ends (the host's rules would, on a tackle or the clock): the result card shows on both screens
  await a.evaluate(() => (window as unknown as { __app: { drill: { end(r: string): void } } }).__app.drill.end('time'));
  for (const p of [a, b]) await expect(p.locator('.panel.result')).toBeVisible({ timeout: 15_000 });
  await a.keyboard.press('Enter');
  await expect(b.locator('.netbadge')).toContainText('restart 1/2', { timeout: 10_000 }); // both see who has asked
  await a.waitForTimeout(1500);
  expect(await repOf(a)).toBe(rep0);
  await b.keyboard.press('Enter');
  await expect.poll(() => repOf(a), { timeout: 15_000 }).toBe(rep0 + 1);
  await expect.poll(() => repOf(b), { timeout: 15_000 }).toBe(rep0 + 1);
  await b.waitForFunction(() => ((window as unknown as App).__app.net?.replica?.time ?? 0) > 0.3, null, { timeout: 30_000 });
  // and the old play's card is gone on both, and stays gone (it came back on the host while the new rep was built)
  await a.waitForTimeout(1500);
  for (const p of [a, b]) await expect(p.locator('.panel.result')).toBeHidden();

  // C types the code (lowercase, with a dash) mid-game: he watches this rep
  const C = await open(browser, 'Cy'), c = C.page;
  await expect(c.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 90_000 });
  await c.getByRole('button', { name: /^Multiplayer/ }).click();
  await c.getByLabel('Room code').fill(`${code.slice(0, 2).toLowerCase()}-${code.slice(2).toLowerCase()}`);
  await expect(c.getByLabel('Room code')).toHaveValue(code);
  await c.getByLabel('Room code').press('Enter');
  await c.waitForFunction(() => ((window as unknown as App).__app.net?.replica?.time ?? 0) > 0, null, { timeout: 60_000 });
  expect(await c.evaluate(() => (window as unknown as App).__app.drill!.human)).toBe(-1);
  await expect(c.locator('.status')).toContainText('Watching');
  await expect.poll(async () => (await lobby(a))!.players.map((p) => p.name)).toEqual(['Ana', 'Ben', 'Cy']);
  await c.keyboard.down('Tab');
  await expect(c.locator('.roster-hud')).toContainText('Cy');
  await c.screenshot({ path: 'test-results/mp-07-spectator.png' });
  await c.keyboard.up('Tab');

  // B leaves: his athlete is a bot on the host at once; the host goes back to the lobby and C follows
  expect(B.errors.filter((e) => !/WebGL|GPU stall/i.test(e))).toEqual([]);
  await b.close();
  await expect.poll(async () => (await lobby(a))!.players.map((p) => p.name), { timeout: 15_000 }).toEqual(['Ana', 'Cy']);
  expect(await a.evaluate(() => (window as unknown as { __app: { drill: { isBot(i: number): boolean } } }).__app.drill.isBot(2))).toBe(true);
  await a.keyboard.press('Escape');
  await a.getByRole('button', { name: 'Back to lobby' }).click();
  await expect(c.locator('.lobby')).toBeVisible({ timeout: 10_000 });
  expect(A.errors.filter((e) => !/WebGL|GPU stall/i.test(e))).toEqual([]);
  expect(C.errors.filter((e) => !/WebGL|GPU stall/i.test(e))).toEqual([]);
});

test('joining a room that does not exist says so', async ({ browser }) => {
  const { page } = await open(browser, 'Dee', '?join=ZZZZZ');
  await expect(page.locator('.mp-status.error')).toContainText('No room has that code', { timeout: 90_000 });
  await expect(page.getByLabel('Room code')).toHaveValue('ZZZZZ');
});
