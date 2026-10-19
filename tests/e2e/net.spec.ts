import { expect, test, type Page } from '@playwright/test';

// src/net against the local room server (npm run dev:rooms) through the Vite dev server's /api proxy, in two browser
// contexts: one makes a room, the other joins with its code. Pages load a module URL, not the game, to stay light.
const DEV = 'http://localhost:5181/src/net/protocol.ts';
// Headless contexts can't resolve each other's mDNS host candidates; plain local addresses let them connect.
test.use({ launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } });

type W = { room: any; got: unknown[]; ended: string[] };
async function open(page: Page, code: string | null, noRtc = false): Promise<string> {
  await page.goto(DEV);
  return page.evaluate(async ([code, noRtc]) => {
    const w = window as unknown as W & { RTCPeerConnection?: unknown };
    if (noRtc) delete w.RTCPeerConnection; // a network that blocks WebRTC, as far as the transport can tell
    const mod = '/src/net/room.ts';
    const net = await import(/* @vite-ignore */ mod);
    w.room = code ? await net.joinRoom(code, 'Guest') : await net.createRoom('Host');
    w.got = []; w.ended = [];
    w.room.onMessage((_: string, d: string | ArrayBuffer) => w.got.push(typeof d === 'string' ? d : [...new Uint8Array(d)]));
    w.room.onClose((r: string) => w.ended.push(r));
    return w.room.code as string;
  }, [code, noRtc] as const);
}
const via = (p: Page) => p.evaluate(() => (window as unknown as W).room.peers()[0]?.via);
const got = (p: Page) => p.evaluate(() => (window as unknown as W).got);

test('a room made in one browser is joined by code in another and talks over WebRTC', async ({ browser }) => {
  const [host, guest] = await Promise.all([browser.newContext(), browser.newContext()].map(async (c) => (await c).newPage()));
  const code = await open(host, null);
  expect(code).toMatch(/^[2-9A-HJKMNP-Z]{5}$/);
  await open(guest, code.toLowerCase());
  await expect.poll(() => via(guest), { timeout: 10_000 }).toBe('rtc');
  await expect.poll(() => via(host), { timeout: 10_000 }).toBe('rtc');
  await host.evaluate(() => { const r = (window as unknown as W).room; r.broadcast('lobby', true); r.broadcast(new Uint8Array([1, 2, 3]).buffer, false); });
  await guest.evaluate(() => { const r = (window as unknown as W).room; r.broadcast('want', true); r.broadcast(new Uint8Array([4]).buffer, false); });
  await expect.poll(() => got(guest)).toEqual(['lobby', [1, 2, 3]]);
  await expect.poll(() => got(host)).toEqual(['want', [4]]);
  await expect.poll(() => host.evaluate(() => (window as unknown as W).room.peers()[0].rtt), { timeout: 5000 }).toBeGreaterThan(0);
  await host.evaluate(() => (window as unknown as W).room.close());
  await expect.poll(() => guest.evaluate(() => (window as unknown as W).ended)).toEqual(['host-left']);
});

test('a guest without WebRTC still plays over the room relay', async ({ browser }) => {
  const [host, guest] = await Promise.all([browser.newContext(), browser.newContext()].map(async (c) => (await c).newPage()));
  const code = await open(host, null);
  await open(guest, code, true);
  expect(await via(guest)).toBe('relay');
  await expect.poll(() => host.evaluate(() => (window as unknown as W).room.peers().length)).toBe(1);
  await host.evaluate(() => (window as unknown as W).room.broadcast('during connecting', true)); // relayed already
  await expect.poll(() => got(guest)).toEqual(['during connecting']);
  await expect.poll(() => via(host), { timeout: 10_000 }).toBe('relay'); // gave up on RTC after ~6 s
  await guest.evaluate(() => (window as unknown as W).room.broadcast(new Uint8Array([7, 7]).buffer, false));
  await expect.poll(() => got(host)).toEqual([[7, 7]]);
});
