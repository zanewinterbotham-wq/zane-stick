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
  const app = (window as unknown as { __app: { human: { contact: boolean; latest: { torso: number; sink: number; armL: number; armR: number; held: Set<string>; cameraYaw: number } | null } } }).__app;
  const l = app.human.latest!;
  return { contact: app.human.contact, torso: l.torso, sink: l.sink, armL: l.armL, armR: l.armR, thrust: l.held.has('thrust'), yaw: l.cameraYaw };
});

async function startRep(page: Page) {
  // skip the first-launch benchmark for speed; it has its own test below
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum' })));
  await page.goto('/');
  await expect(page.locator('.menu h1')).toHaveText('ZANE STICK', { timeout: 60_000 });
  await page.screenshot({ path: 'test-results/01-title.png' });
  await page.keyboard.press('Enter');
  await expect(page.locator('.status')).toContainText('OPEN FIELD', { timeout: 60_000 });
  await page.mouse.move(683, 384);
}

test('title loads, drill starts, mouse and keyboard controls reach the brain, contact mode is automatic', async ({ page }) => {
  const errors = watchErrors(page);
  await startRep(page);
  // the control list is a vertical panel on the left
  const list = page.locator('.keylist');
  await expect(list).toContainText('Left click');
  await expect(list).toContainText('Scroll');
  const box = (await list.boundingBox())!;
  expect(box.x).toBeLessThan(40);
  expect(box.height).toBeGreaterThan(box.width * 0.6);
  // arms on the mouse buttons, torso on the wheel, sink on Ctrl (and C), thrust on Space overriding sink
  await page.mouse.down({ button: 'left' });
  await page.mouse.down({ button: 'right' });
  await page.mouse.wheel(0, 300);
  await page.keyboard.down('KeyC');
  await page.waitForTimeout(500);
  let l = await latest(page);
  expect([l.armL, l.armR]).toEqual([1, 1]);
  expect(l.torso).toBeGreaterThan(0.3);
  expect(l.sink).toBeGreaterThan(0.3);
  await page.keyboard.up('KeyC');
  await page.mouse.up({ button: 'left' }); await page.mouse.up({ button: 'right' });
  await page.keyboard.down('Space');
  await page.waitForTimeout(100);
  expect((await latest(page)).thrust).toBe(true);
  await page.keyboard.up('Space');
  await page.keyboard.down('ControlLeft');
  await page.waitForTimeout(300);
  expect((await latest(page)).sink).toBeGreaterThan(0.2);
  await page.keyboard.up('ControlLeft');
  // run at the carrier: contact mode switches itself on
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await latest(page)).contact, { timeout: 20_000 }).toBe(true);
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

test('automatic camera moves the arms to J / L and the torso to I / K, live', async ({ page }) => {
  const errors = watchErrors(page);
  // a browser without keyboard lock (Firefox, Safari): the HUD says how to sink without Ctrl+W
  await page.addInitScript(() => Object.defineProperty(navigator, 'keyboard', { value: undefined }));
  await startRep(page);
  await expect(page.locator('.keylist')).toContainText('C also sinks');
  await expect(page.locator('.keylist')).toContainText('Ctrl / C');
  await page.keyboard.down('KeyC');
  await page.waitForTimeout(300);
  expect((await latest(page)).sink).toBeGreaterThan(0.2);
  await page.keyboard.up('KeyC');
  await page.screenshot({ path: 'test-results/08-no-keyboard-lock.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu h1')).toHaveText('Paused');
  await page.getByRole('button', { name: /Automatic camera: off/ }).click();
  await page.getByRole('button', { name: 'Controls' }).click();
  await expect(page.locator('table.controls').first()).toContainText('I / K');
  await page.screenshot({ path: 'test-results/08b-controls-auto.png', fullPage: true });
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: /Resume/ }).click();
  await expect(page.locator('.keylist')).toContainText('I / K');
  await expect(page.locator('.keylist')).not.toContainText('Left click');
  await page.keyboard.down('KeyJ'); await page.keyboard.down('KeyK');
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(500);
  const l = await latest(page);
  expect([l.armL, l.armR]).toEqual([1, 0]);
  expect(l.torso).toBeGreaterThan(0.2);
  await page.mouse.up({ button: 'left' });
  await page.screenshot({ path: 'test-results/09-auto-camera.png' });
  expect(errors).toEqual([]);
});

test('controls screen lists the mouse controls and the game keys', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum' })));
  await page.goto('/');
  await page.getByRole('button', { name: 'Controls' }).click();
  for (const t of ['Left click', 'Right click', 'Scroll', 'Ctrl', 'Space', 'Shift', 'Esc', 'Enter']) await expect(page.locator('.menu')).toContainText(t);
  await expect(page.locator('.menu')).not.toContainText('Dive');
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
  await expect(page.locator('.menu h1')).toHaveText('Tuning');
  for (const label of ['Support: strength', 'Support: carry accel (m/s²)', 'Support: weight share', 'Support: tilt fade start', 'Support: tilt fade end', 'Support: big hit (N·s)', 'Support: tracking stiffness ×', 'Athlete speed ×', 'Muscle strength ×']) {
    await expect(page.getByRole('slider', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('slider', { name: 'Support: strength' })).toHaveValue('1');
  await expect(page.getByLabel('Exported values')).toHaveValue(/"support"/);
  await page.screenshot({ path: 'test-results/07-tuning.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('key test screen shows held keys', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('zane-stick-settings-v1', JSON.stringify({ preset: 'minimum' })));
  await page.goto('/');
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
  expect(['minimum', 'high']).toContain(preset);
  expect(errors).toEqual([]);
});
