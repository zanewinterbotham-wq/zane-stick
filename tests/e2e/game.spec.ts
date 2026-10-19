import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** Fail on any console error or uncaught exception. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** The human's latest input snapshot, as the brain sees it. */
const latest = (page: Page) => page.evaluate(() => {
  const app = (window as unknown as { __app: { human: { contact: boolean; latest: { torso: number; armL: number; armR: number; held: Set<string>; cameraYaw: number; shiftLock?: boolean } | null } } }).__app;
  const l = app.human.latest ?? { torso: 0, armL: 0, armR: 0, held: new Set<string>(), cameraYaw: 0 }; // before the first frame
  return { contact: app.human.contact, torso: l.torso, armL: l.armL, armR: l.armR, thrust: l.held.has('thrust'), yaw: l.cameraYaw, held: [...l.held], shiftLock: !!l.shiftLock };
});

type AppHandle = {
  __app: {
    humanHeading(): number; lockKeys(): Promise<void> | undefined;
    drill: { world: { athletes: { segIndex: Map<string, number> }[]; scene: { athletes: { state: { segPos: Float64Array } }[] } } };
    renderer: { camera: { position: { x: number; y: number; z: number } }; athletes: { segs: { visible: boolean }[]; parts: { seg: number; node: { visible: boolean } }[] }[] };
  };
  __lockKeys?: string[];
};

const settingsTab = (page: Page, name: string) => page.getByRole('button', { name: 'Settings', exact: true }).click().then(() => page.getByRole('tab', { name }).click());

async function startRep(page: Page) {
  // skip the first-launch benchmark for speed; it has its own test below
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false } })));
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.screenshot({ path: 'test-results/01-title.png' });
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await page.waitForFunction(() => (window as unknown as { __app: { human: { latest: unknown } } }).__app.human.latest);
  await page.mouse.move(683, 384);
}


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

test('title loads, drill starts, mouse and keyboard controls reach the brain, contact mode is automatic', async ({ page }) => {
  const errors = watchErrors(page);
  await startRep(page);
  // the control list is a vertical panel on the left
  await carrierComesToYou(page);
  const list = page.locator('.keylist');
  await expect(list).toContainText('Left click');
  await expect(list).toContainText('Scroll');
  const box = (await list.boundingBox())!;
  expect(box.x).toBeLessThan(40);
  expect(box.height).toBeGreaterThan(box.width * 0.6);
  // arms on the mouse buttons, the pads on the wheel (scroll up = down: the trunk leans and the hips sink together),
  // thrust on Q overriding both; there is no separate sink key
  await expect(list).not.toContainText('Sink');
  await page.mouse.down({ button: 'left' });
  await page.mouse.down({ button: 'right' });
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(500);
  const l = await latest(page);
  expect([l.armL, l.armR]).toEqual([1, 1]);
  expect(l.torso).toBeGreaterThan(0.2);
  const cmd = await page.evaluate(() => { const d = (window as unknown as { __app: { drill: { human: number; world: { athletes: { cmd: { sink: number; lean: { fwd: number } } }[] } } } }).__app.drill; const c = d.world.athletes[d.human].cmd; return { sink: c.sink, lean: c.lean.fwd }; });
  expect(cmd.lean).toBeGreaterThan(0.2);
  expect(cmd.sink).toBeGreaterThan(0.1);
  // about ten notches up reach a level trunk (torso 1); scrolling down raises it again
  for (let i = 0; i < 9; i++) await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await latest(page)).torso).toBeGreaterThan(0.97);
  // a big hit (given or taken) brings lowered pads back up to the running position; a raised torso stays
  const padsUp = () => page.evaluate(() => (window as unknown as { __app: { input: { padsUp(): void } } }).__app.input.padsUp());
  await padsUp();
  await expect.poll(async () => (await latest(page)).torso).toBeLessThan(0.02);
  await page.mouse.wheel(0, 1500);
  await expect.poll(async () => (await latest(page)).torso).toBeLessThan(-0.3);
  await padsUp();
  await page.waitForTimeout(200);
  expect((await latest(page)).torso).toBeLessThan(-0.3);
  await page.evaluate(() => (window as unknown as { __app: { input: { resetTorso(): void } } }).__app.input.resetTorso());
  await page.mouse.up({ button: 'left' }); await page.mouse.up({ button: 'right' });
  await page.keyboard.down('KeyQ');
  await page.waitForTimeout(100);
  expect((await latest(page)).thrust).toBe(true);
  await page.keyboard.up('KeyQ');
  // run at the carrier: contact mode switches itself on
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await latest(page)).contact, { timeout: 45_000 }).toBe(true); // slow under a full parallel run
  await expect(page.locator('.status')).toContainText('CONTACT');
  await page.mouse.down({ button: 'left' }); await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/02-play.png' });
  await page.mouse.up({ button: 'left' }); await page.mouse.up({ button: 'right' });
  await page.keyboard.up('KeyW');
  // mouse look needs pointer lock, which a headless browser may refuse; when it is granted, the mouse turns
  // the camera and losing the lock pauses
  const locked = await page.evaluate(() => !!document.pointerLockElement);
  console.log(`pointer lock ${locked ? 'granted' : 'refused'}`);
  if (locked) {
    const yaw0 = (await latest(page)).yaw;
    await page.mouse.move(883, 384, { steps: 5 });
    await page.waitForTimeout(200);
    expect(Math.abs((await latest(page)).yaw - yaw0)).toBeGreaterThan(0.1);
  } else {
    await page.mouse.click(683, 384); // retry the lock: refusal must not throw
  }
  // overlay
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(800);
  await expect(page.locator('.overlay')).toContainText('FPS');
  await page.screenshot({ path: 'test-results/03-overlay.png' });
  // reset rep, pause menu
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  if (locked) await page.evaluate(() => document.exitPointerLock());
  else await page.keyboard.press('Escape');
  await expect(page.locator('.menu h1')).toHaveText('Paused');
  await page.screenshot({ path: 'test-results/04-pause.png' });
  expect(errors).toEqual([]);
});

test('Space jumps: a physics take-off, through the air and back down on his feet', async ({ page }) => {
  const errors = watchErrors(page);
  await startRep(page);
  const jump = () => page.evaluate(() => { const d = (window as unknown as { __app: { drill: { human: number; world: { athletes: { controller: { frame: { root: { jump: string } } } }[] } } } }).__app.drill; return d.world.athletes[d.human].controller.frame.root.jump; });
  await page.keyboard.down('Space');
  await page.waitForTimeout(100);
  expect((await latest(page)).held).toContain('jump');
  await page.keyboard.up('Space');
  await expect.poll(jump, { intervals: [20] }).toBe('flight');
  await page.waitForTimeout(250); // about the top of the flight
  await page.screenshot({ path: 'test-results/02-jump.png' });
  await expect.poll(jump, { timeout: 5_000 }).toBe('none');
  expect(errors).toEqual([]);
});

test('J / L and I / K always work alongside the mouse, with or without the automatic camera', async ({ page }) => {
  const errors = watchErrors(page);
  // a browser without keyboard lock (Firefox, Safari) plays the same: no key needs the lock
  await page.addInitScript(() => Object.defineProperty(navigator, 'keyboard', { value: undefined }));
  await startRep(page);
  await expect(page.locator('.keylist .note')).toHaveCount(0);
  // the Chromebook keys work with the mouse camera too
  await expect(page.locator('.keylist')).toContainText('K / I');
  await page.keyboard.down('KeyL'); await page.keyboard.down('KeyK');
  // the torso ramps at its rate per second of frames: polled, so a slow frame rate under load still gets there
  await expect.poll(async () => (await latest(page)).torso, { timeout: 10_000 }).toBeGreaterThan(0.2);
  let l = await latest(page);
  expect([l.armL, l.armR]).toEqual([0, 1]);
  await page.keyboard.up('KeyL'); await page.keyboard.up('KeyK');
  await page.screenshot({ path: 'test-results/08-no-keyboard-lock.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu h1')).toHaveText('Paused');
  await settingsTab(page, 'Camera');
  await page.getByRole('button', { name: 'Automatic camera: On' }).click();
  await page.getByRole('tab', { name: 'Controls' }).click();
  await expect(page.locator('tr[data-action=torsoDown] .keys-cell')).toHaveText('K');
  await expect(page.locator('tr[data-action=armL] .keys-cell')).toHaveText('Left click / J');
  await page.screenshot({ path: 'test-results/08b-controls-auto.png', fullPage: true });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: /Resume/ }).click();
  await expect(page.locator('.keylist')).toContainText('K / I');
  await expect(page.locator('.keylist')).toContainText('Left click / J');
  await page.evaluate(() => (window as unknown as { __app: { input: { resetTorso(): void } } }).__app.input.resetTorso());
  await page.keyboard.down('KeyJ'); await page.keyboard.down('KeyI');
  await page.mouse.down({ button: 'right' });
  await expect.poll(async () => (await latest(page)).torso, { timeout: 10_000 }).toBeLessThan(-0.2);
  l = await latest(page);
  expect([l.armL, l.armR]).toEqual([1, 1]);
  await page.mouse.up({ button: 'right' });
  await page.screenshot({ path: 'test-results/09-auto-camera.png' });
  expect(errors).toEqual([]);
});

test('side shuffle toggles on middle click and ;, Alt+Tab is never blocked, switching away pauses', async ({ page }) => {
  const errors = watchErrors(page);
  // record what the game asks keyboard lock for
  await page.addInitScript(() => Object.defineProperty(navigator, 'keyboard', { value: { lock: (k?: string[]) => { (window as unknown as { __lockKeys?: string[] }).__lockKeys = k; return Promise.resolve(); }, unlock() {} } }));
  await startRep(page);
  await page.mouse.down({ button: 'middle' }); await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => (await latest(page)).shiftLock).toBe(true);
  await expect(page.locator('.status')).toContainText('SIDE SHUFFLE');
  await expect(page.locator('.keylist')).toContainText('Middle click / ;');
  // D with shift lock: the body shuffles right instead of turning to run right
  const h0 = await page.evaluate(() => (window as unknown as AppHandle).__app.humanHeading());
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1500);
  const h1 = await page.evaluate(() => (window as unknown as AppHandle).__app.humanHeading());
  await page.screenshot({ path: 'test-results/11-side-shuffle.png' });
  await page.keyboard.up('KeyD');
  const turned = Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)));
  console.log(`side shuffle: body turned ${(turned * 180 / Math.PI).toFixed(1)}° while holding D`);
  expect(turned).toBeLessThan(0.4);
  await page.keyboard.press('Semicolon');
  await expect.poll(async () => (await latest(page)).shiftLock).toBe(false);
  // Alt and Tab keep their default (Alt+Tab switches windows); a bound key is still captured
  const prevented = await page.evaluate(() => ['AltLeft', 'Tab', 'MetaLeft', 'KeyW'].map((code) => {
    const e = new KeyboardEvent('keydown', { code, altKey: code !== 'AltLeft' && code !== 'KeyW', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    return e.defaultPrevented;
  }));
  expect(prevented).toEqual([false, false, false, true]);
  // keyboard lock takes only the bound keys, never Alt, Tab, the Windows key or Esc
  await page.evaluate(() => (window as unknown as AppHandle).__app.lockKeys());
  const locked = await page.evaluate(() => (window as unknown as AppHandle).__lockKeys);
  expect(locked).toEqual(expect.arrayContaining(['KeyW', 'ShiftLeft', 'Space', 'KeyJ', 'Semicolon']));
  for (const k of locked!) expect(k).not.toMatch(/^(Alt|Tab|Meta|Escape|Mouse)/);
  // switching away (Alt+Tab) pauses and frees the mouse
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('.menu h1')).toHaveText('Paused');
  await expect.poll(() => page.evaluate(() => !!document.pointerLockElement)).toBe(false);
  expect(errors).toEqual([]);
});

test('controls rebind live and persist; reserved keys are refused; reset restores the defaults', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false } })); } });
  await page.goto('/');
  await settingsTab(page, 'Controls');
  const cell = (a: string) => page.locator(`tr[data-action=${a}] .keys-cell`);
  await expect(cell('dive')).toHaveText('E');
  await page.getByRole('button', { name: /^Replace Dive/ }).click();
  await page.keyboard.press('Tab');
  await expect(page.locator('.menu [role=status]')).toContainText('Tab stays with the browser');
  await page.keyboard.press('KeyR');
  await expect(cell('dive')).toHaveText('R');
  // a mouse button can be added; it leaves the action that had it
  await page.getByRole('button', { name: /^Add a key to Thrust/ }).click();
  await page.mouse.click(20, 20, { button: 'middle' });
  await expect(cell('thrust')).toHaveText('Q / Middle click');
  await expect(cell('shiftLock')).toHaveText(';');
  await page.screenshot({ path: 'test-results/12-rebind.png', fullPage: true });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zane-stick-settings-v1')!).bindings.dive)).toEqual(['KeyR']);
  // saved: a reload keeps it, and it drives the athlete
  await page.reload();
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await expect(page.locator('.keylist')).toContainText('Q / Middle click');
  await page.keyboard.down('KeyR');
  await expect.poll(async () => (await latest(page)).held).toContain('dive');
  await page.keyboard.up('KeyR');
  await page.keyboard.press('Escape');
  await settingsTab(page, 'Controls');
  await page.getByRole('button', { name: 'Reset controls to defaults' }).click();
  await expect(cell('dive')).toHaveText('E');
  await expect(cell('thrust')).toHaveText('Q');
  await expect(cell('jump')).toHaveText('Space');
  expect(errors).toEqual([]);
});

test('helmet camera sits at the eyes every frame and hides the own head', async ({ page }) => {
  const errors = watchErrors(page);
  await startRep(page);
  await page.keyboard.press('Escape');
  await settingsTab(page, 'Camera');
  await page.getByRole('button', { name: 'Camera view: Helmet' }).click();
  await page.keyboard.press('Escape'); // Esc steps back to the pause menu
  await page.getByRole('button', { name: /Resume/ }).click();
  const probe = () => page.evaluate(() => {
    const app = (window as unknown as AppHandle).__app, w = app.drill.world, r = app.renderer;
    const hi = w.athletes[0].segIndex.get('head')!, p = w.scene.athletes[0].state.segPos, c = r.camera.position;
    const shown = (i: number) => r.athletes[i].segs[hi].visible && r.athletes[i].parts.filter((q) => q.seg === hi).every((q) => q.node.visible);
    return { dist: Math.hypot(c.x - p[3 * hi], c.y - p[3 * hi + 1], c.z - p[3 * hi + 2]), own: shown(0), other: shown(1) };
  });
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  const run = await probe();
  await page.screenshot({ path: 'test-results/13-helmet.png' });
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  console.log(`helmet camera ${run.dist.toFixed(3)} m from the head origin while sprinting`);
  expect(run.dist).toBeLessThan(0.25);
  expect([run.own, run.other]).toEqual([false, true]);
  await page.keyboard.press('Escape');
  await settingsTab(page, 'Camera');
  await page.getByRole('button', { name: 'Camera view: Chase' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Resume/ }).click();
  await page.waitForTimeout(300);
  expect((await probe()).own).toBe(true);
  expect(errors).toEqual([]);
});

test('the view looks nearly straight up and well down, in the chase and helmet cameras, never into the turf', async ({ page }) => {
  const errors = watchErrors(page);
  await startRep(page);
  // look as far as the limits allow (the look call is what mouse movement does) and read the rendered view
  const view = (dy: number) => page.evaluate(async (dy) => {
    const app = (window as unknown as { __app: { cam: { look(x: number, y: number): void; aimPitch: number }; renderer: { camera: { position: { y: number }; matrixWorld: { elements: number[] } } } } }).__app;
    app.cam.look(0, dy);
    await new Promise((r) => setTimeout(r, 300));
    const c = app.renderer.camera;
    return { y: c.position.y, up: -c.matrixWorld.elements[9], aim: app.cam.aimPitch };
  }, dy);
  const up = await view(-10);
  await page.screenshot({ path: 'test-results/13b-look-up.png' });
  const down = await view(10);
  await page.screenshot({ path: 'test-results/13c-look-down.png' });
  await page.evaluate(() => (window as unknown as { __app: { toggleCamera(): void } }).__app.toggleCamera());
  const helmetUp = await view(-10);
  await page.screenshot({ path: 'test-results/13d-helmet-look-up.png' });
  console.log(`look up: view ${up.up.toFixed(2)}, camera ${up.y.toFixed(2)} m, arm aim ${up.aim.toFixed(2)} rad; down ${down.up.toFixed(2)}; helmet up ${helmetUp.up.toFixed(2)}`);
  expect(up.up).toBeGreaterThan(0.9);     // within ~25° of straight up
  expect(up.y).toBeGreaterThan(0.29);
  expect(up.aim).toBeGreaterThan(1.4);    // the arms reach overhead
  expect(down.up).toBeLessThan(-0.9);
  expect(helmetUp.up).toBeGreaterThan(0.9);
  expect(errors).toEqual([]);
});

test('the picked sounds load and decode from the deploy (and nothing from the dev library), and play in a rep', async ({ page }) => {
  const errors = watchErrors(page), sfx: { url: string; status: number }[] = [];
  page.on('response', (r) => { if (/\.ogg$/.test(r.url())) sfx.push({ url: r.url(), status: r.status() }); });
  await page.addInitScript(() => {
    const w = window as unknown as { __plays: number }, start = AudioBufferSourceNode.prototype.start;
    w.__plays = 0;
    AudioBufferSourceNode.prototype.start = function (...a: Parameters<typeof start>) { w.__plays++; return start.apply(this, a); };
  });
  const plays = () => page.evaluate(() => (window as unknown as { __plays: number }).__plays);
  await startRep(page);
  const { categories } = JSON.parse(readFileSync('src/game/sfx-picks.json', 'utf8')) as { categories: Record<string, { files: string[] }> };
  const picked = Object.values(categories).reduce((n, c) => n + c.files.length, 0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: { audio: { buffers: Map<string, unknown> } } }).__app.audio.buffers.size), { timeout: 30_000 }).toBe(picked);
  expect(sfx.length).toBe(picked);
  for (const r of sfx) { expect(r.status, r.url).toBe(200); expect(r.url).toContain('/sfx/'); expect(r.url).not.toContain('/art/'); }
  // footsteps while running
  const before = await plays();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  expect(await plays() - before).toBeGreaterThan(3);
  expect(errors).toEqual([]);
});

test('controls screen lists the mouse controls and the game keys', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false } })));
  await page.goto('/');
  await settingsTab(page, 'Controls');
  for (const t of ['Left click', 'Right click', 'Scroll', 'Lower the pads', 'Space', 'Shift', 'Esc', 'Enter']) await expect(page.locator('.menu')).toContainText(t);
  await expect(page.locator('.menu')).not.toContainText('Ctrl'); // no sink key any more
  await expect(page.locator('.menu')).toContainText('Dive forward'); // owner asked for dive on E
  await page.screenshot({ path: 'test-results/10-controls.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('tuning panel shows the support, speed and strength sliders; HUD shows speed', async ({ page }) => {
  const errors = watchErrors(page);
  await startRep(page);
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await expect(page.locator('.speedo')).toContainText('mph');
  await page.screenshot({ path: 'test-results/06-sprint-speedo.png' });
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  await page.keyboard.press('KeyT');
  await expect(page.locator('.menu h1')).toHaveText('Settings');
  await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
  for (const label of ['Support: strength', 'Support: carry accel (m/s²)', 'Support: weight share', 'Support: tilt fade start', 'Support: tilt fade end', 'Support: big hit (N·s)', 'Support: tracking stiffness ×', 'Athlete speed ×', 'Muscle strength ×']) {
    await expect(page.getByRole('slider', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('slider', { name: 'Support: strength' })).toHaveValue('1');
  await expect(page.getByLabel('Exported values')).toHaveValue(/"support"/);
  await page.screenshot({ path: 'test-results/07-tuning.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('difficulty screen: presets, the independent sliders and hit power, remembered; reachable from the pause menu', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => { if (!localStorage.getItem('zane-stick-settings-v1')) localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false } })); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.menu h1')).toHaveText('Settings');
  await expect(page.getByRole('status')).toContainText('Difficulty: Normal');
  for (const label of ['AI toughness (force needed to tackle the bot)', 'AI juking', 'Player strength', 'Player speed', 'Hit power']) await expect(page.getByRole('slider', { name: label })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Hit power' })).toHaveValue('1.5');
  await page.getByRole('button', { name: 'Easy' }).click();
  await expect(page.getByRole('status')).toContainText('Difficulty: Easy');
  await expect(page.getByRole('slider', { name: 'AI toughness (force needed to tackle the bot)' })).toHaveValue('0.6');
  await expect(page.getByRole('slider', { name: 'AI juking' })).toHaveValue('0');
  await page.getByRole('slider', { name: 'Hit power' }).fill('2.5');
  await page.getByRole('slider', { name: 'AI juking' }).fill('0.3');
  await expect(page.getByRole('status')).toContainText('Difficulty: Custom');
  await page.screenshot({ path: 'test-results/14-difficulty.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Difficulty: Custom');
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK');
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await page.waitForTimeout(500);
  if (await page.evaluate(() => !!document.pointerLockElement)) await page.evaluate(() => document.exitPointerLock());
  else await page.keyboard.press('Escape');
  await expect(page.locator('.menu h1')).toHaveText('Paused');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Hit power' })).toHaveValue('2.5');
  await expect(page.getByRole('slider', { name: 'AI juking' })).toHaveValue('0.3');
  expect(errors).toEqual([]);
});

test('key test screen shows held keys', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum', perf: { worker: false } })));
  await page.goto('/');
  await settingsTab(page, 'Controls');
  await page.getByRole('button', { name: 'Key test' }).click();
  await page.keyboard.down('KeyW'); await page.keyboard.down('KeyJ');
  await expect(page.locator('.keys')).toContainText('KeyW');
  await expect(page.locator('.keys')).toContainText('KeyJ');
  await page.screenshot({ path: 'test-results/05-keytest.png' });
  expect(errors).toEqual([]);
});

test('first launch runs the benchmark and picks a preset', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 90_000 });
  const preset = await page.evaluate(() => JSON.parse(localStorage.getItem('zane-stick-settings-v1') ?? '{}').preset);
  expect(['potato', 'minimum', 'medium', 'high', 'ultra']).toContain(preset);
  expect(errors).toEqual([]);
});
