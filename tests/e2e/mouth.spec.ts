import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const skins: string[] = [...JSON.parse(readFileSync('src/game/skins.json', 'utf8')).map((s: { id: string }) => s.id), 'classic'];
const shapes = ['closed', 'grunt', 'scream', 'moan', 'exhale'];
/** Moods shown with the mouth that goes with them. */
const faces: [string, { angry: number; sad: number }, string][] = [['neutral', { angry: 0, sad: 0 }, 'closed'], ['angry', { angry: 1, sad: 0 }, 'grunt'], ['sad', { angry: 0, sad: 1 }, 'moan']];

type Mesh = { matrixWorld: { elements: number[] }; parent: { visible: boolean }; geometry: { getAttribute: (n: string) => { array: Float32Array } } };
type Mouth = { mesh: Mesh; driver: { force: { shape: string; level: number } | null; pose: { h: number; w: number; teeth: number } }; update: (dt: number) => void };
type Brows = { mesh: Mesh; driver: { force: { angry: number; sad: number } | null; pose: { angry: number; sad: number }; target: { angry: number; sad: number } } };
type Cam = { position: { set: (x: number, y: number, z: number) => void }; fov: number; lookAt: (x: number, y: number, z: number) => void; updateProjectionMatrix: () => void };
type Zs = { world: unknown; renderer: { athletes: { mouth: Mouth | null; brows: Brows | null }[]; camera: Cam; render: (w: unknown) => void } };

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Square-on view (along the mouth's own forward axis) of athlete 0's face, held in a mouth shape and a mood. `at` is
 *  where to look: the mouth, or the middle of the face between brows and mouth. */
async function closeUp(page: Page, o: { shape: string; level: number; mood?: { angry: number; sad: number }; at: 'mouth' | 'face' | 'brow'; path: string }) {
  await page.evaluate((o) => {
    const zs = (window as unknown as { __zs: Zs }).__zs, r = zs.renderer, a = r.athletes[0], m = a.mouth!;
    m.driver.force = { shape: o.shape, level: o.level };
    a.brows!.driver.force = o.mood ?? { angry: 0, sad: 0 };
    r.render(zs.world);
    // looking along the mouth's own forward axis, or the head's when looking at the brows
    const e = m.mesh.matrixWorld.elements, h = (o.at === 'mouth' ? e : a.brows!.mesh.matrixWorld.elements), len = Math.hypot(h[8], h[9], h[10]);
    const t = [e[12], e[13], e[14]];
    if (o.at !== 'mouth') {
      const p = a.brows!.mesh.geometry.getAttribute('position').array, c = [0, 0, 0], n = p.length / 3, b = a.brows!.mesh.matrixWorld.elements;
      for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) c[k] += p[i + k] / n;
      for (let k = 0; k < 3; k++) { const w = b[k] * c[0] + b[4 + k] * c[1] + b[8 + k] * c[2] + b[12 + k]; t[k] = o.at === 'brow' ? w : (t[k] + w) / 2; }
    }
    const dist = o.at === 'face' ? 1.1 : o.at === 'brow' ? 0.7 : 0.9;
    r.camera.fov = 40; r.camera.updateProjectionMatrix();
    r.camera.position.set(t[0] + (dist * h[8]) / len, t[1] + (dist * h[9]) / len, t[2] + (dist * h[10]) / len);
    r.camera.lookAt(t[0], t[1], t[2]);
    r.render(zs.world);
  }, o);
  await page.screenshot({ path: o.path, clip: { x: 483, y: 234, width: 400, height: 300 } });
}

async function stand(page: Page, skin: string) {
  await page.goto(`/?scenario=stand&skin=${skin}&gfx=high`);
  await page.waitForFunction(() => (window as unknown as { __zs?: unknown }).__zs, null, { timeout: 60_000 });
  await page.evaluate(() => { (window as unknown as { __zs: { advance: (s: number) => void } }).__zs.advance(0.5); });
}

for (const s of skins) {
  test(`mouth ${s}: every shape, close up`, async ({ page }) => {
    const errors = watchErrors(page);
    await stand(page, s);
    const heights: number[] = [];
    for (const shape of shapes) {
      await closeUp(page, { shape, level: 1, at: 'mouth', path: `test-results/mouth/${s}-${shape}.png` });
      heights.push(await page.evaluate(() => (window as unknown as { __zs: Zs }).__zs.renderer.athletes[0].mouth!.driver.pose.h));
    }
    expect(heights[0]).toBe(0);
    expect(heights[2]).toBeGreaterThan(heights[1]); // scream opens wider than a grunt
    expect(errors).toEqual([]);
  });

  test(`brows ${s}: neutral, angry and sad, close up`, async ({ page }) => {
    const errors = watchErrors(page);
    await stand(page, s);
    for (const [name, mood, shape] of faces) await closeUp(page, { shape, level: 1, mood, at: 'brow', path: `test-results/mouth/face-${s}-${name}.png` });
    expect(errors).toEqual([]);
  });
}

type App = { audio: { play: (cat: string, loud: number, pos: undefined, athlete: number) => boolean }; renderer: Zs['renderer']; cam: { mode: string } };

test('a voice sound on an athlete moves that athlete\'s mouth, then it relaxes; the helmet camera hides your own', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false }, mute: true })));
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.renderer?.athletes.length)).toBe(2);
  const open = (i: number) => page.evaluate((i) => (window as unknown as { __app: App }).__app.renderer.athletes[i].mouth!.driver.pose.h, i);
  await expect.poll(() => open(1)).toBeLessThan(0.01);
  await page.evaluate(() => (window as unknown as { __app: App }).__app.audio.play('pain_scream', 1, undefined, 1));
  // while it screams the mouth is open and moving (talking, not a static pose); the other athlete's is shut
  const seen: number[] = [];
  for (let i = 0; i < 20; i++) { seen.push(await open(1)); await page.waitForTimeout(40); }
  expect(Math.max(...seen)).toBeGreaterThan(0.4);
  expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.1);
  expect(await open(0)).toBeLessThan(0.01);
  await page.screenshot({ path: 'test-results/mouth/scream-in-game.png' });
  // then it closes (a pain grimace lingers for a moment first)
  await expect.poll(() => open(1), { timeout: 8000 }).toBeLessThan(0.01);
  // helmet camera: your own head, and with it your mouth and brows, is not drawn
  await page.evaluate(() => { (window as unknown as { __app: App }).__app.cam.mode = 'helmet'; });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.renderer.athletes[0].mouth!.mesh.parent.visible)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __app: App }).__app.renderer.athletes[1].mouth!.mesh.parent.visible)).toBe(true);
  expect(errors).toEqual([]);
});

test('the athletes\' brows follow the game: closing on the carrier makes the tackler angry', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false }, mute: true })));
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: App }).__app.renderer?.athletes.length)).toBe(2);
  const mood = (i: number) => page.evaluate((i) => (window as unknown as { __app: { renderer: Zs['renderer'] } }).__app.renderer.athletes[i].brows!.driver.pose, i);
  expect((await mood(1)).angry).toBeLessThan(0.05);
  // the carrier walks into the human, who sprints at him: angry before contact
  await page.evaluate(() => {
    type V = [number, number, number];
    const d = (window as unknown as { __app: { drill: { carrier: number; human: number; brains: { think: unknown }[]; world: { athletes: { cmd: Record<string, unknown> }[] } } } }).__app.drill;
    d.brains[d.carrier] = { think: (p: { athletes: { com: V }[] }) => {
      const me = p.athletes[d.carrier].com, h = p.athletes[d.human].com, dx = h[0] - me[0], dz = h[2] - me[2], n = Math.hypot(dx, dz) || 1;
      return { ...d.world.athletes[d.carrier].cmd, move: { x: dx / n, z: dz / n }, face: null, gait: 'jog', carry: 2, dive: false, thrustHips: false };
    } };
  });
  // sample the moods every 30 ms: the angry spell before the contact is short next to a slow software-GL frame
  await page.evaluate(() => {
    const w = window as unknown as { __app: { renderer: Zs['renderer'] }; __max: number[] };
    w.__max = [0, 0];
    setInterval(() => w.__app.renderer.athletes.forEach((a, i) => { w.__max[i] = Math.max(w.__max[i], a.brows!.driver.pose.angry); }), 30);
  });
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __max: number[] }).__max[0]), { timeout: 30_000 }).toBeGreaterThan(0.8);
  await page.screenshot({ path: 'test-results/mouth/angry-in-game.png' });
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  expect(errors).toEqual([]);
});
