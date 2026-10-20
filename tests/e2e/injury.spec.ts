// Injury effects in the real renderer (design §6.6): a knockout by physics in the dev hit view, then every effect style
// played on the same bodies (a break at the carrier's knee, a knockout). Screenshots in test-results/injury-*.png.
// (Breaks by physics are tested headless in tests/injury.test.ts: a running leg is rarely straight to break here.)
import { expect, test } from '@playwright/test';
import { watchErrors } from './helpers';

type Zs = { __zs: {
  advance(s: number): number;
  world: { time: number; dt: number; injuries: { kind: string; joint: string }[]; athletes: { playerContact: boolean; segIndex: Map<string, number>; injury: { out: boolean } }[];
    scene: { applyWrench(a: number, seg: number, f: number[], t: number[]): void; athletes: { state: { segPos: Float64Array; segCom: Float64Array; segQuat: Float64Array } }[] } };
  renderer: { render(w: unknown): void; camera: { position: { set(x: number, y: number, z: number): void }; lookAt(x: number, y: number, z: number): void }; effects: { setStyle(id: string): void; break(at: number[], pose: () => unknown, load: number): void; ko(head: () => number[]): void } };
} };

test('a head is knocked out by physics; every effect style renders a break and a knockout', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?scenario=hit&hp=1&gfx=high&skin=voxel');
  await page.waitForFunction(() => (window as unknown as Zs).__zs);
  // run to contact, then a blindside blow to the carrier's helmet (150 N·s)
  const events = await page.evaluate(() => {
    const zs = (window as unknown as Zs).__zs, w = zs.world;
    while (!w.athletes[0].playerContact && w.time < 4) zs.advance(w.dt);
    const head = w.athletes[0].segIndex.get('head')!;
    for (let i = 0; i < 3; i++) { w.scene.applyWrench(0, head, [15000, 0, 0], [0, 0, 0]); zs.advance(w.dt); }
    zs.advance(1.5);
    return w.injuries.map((e) => `${e.kind}:${e.joint}`);
  });
  console.log('injuries:', events);
  expect(events).toContain('ko:head');
  for (const id of ['realistic', 'cartoon', 'comic', 'voxel', 'spray']) {
    await page.evaluate((id) => {
      const zs = (window as unknown as Zs).__zs, w = zs.world, s0 = w.scene.athletes[0].state;
      const k = w.athletes[0].segIndex.get('shankL')!, h = w.athletes[0].segIndex.get('head')!;
      zs.renderer.effects.setStyle(id);
      zs.renderer.effects.break([s0.segPos[3 * k], s0.segPos[3 * k + 1], s0.segPos[3 * k + 2]], () => ({ pos: [s0.segPos[3 * k], s0.segPos[3 * k + 1], s0.segPos[3 * k + 2]], quat: [...s0.segQuat.subarray(4 * k, 4 * k + 4)] }), 0.8);
      zs.renderer.effects.ko(() => [s0.segPos[3 * h], s0.segPos[3 * h + 1] + 0.1, s0.segPos[3 * h + 2]]);
      for (let i = 0; i < 40; i++) zs.advance(1 / 60); // frame by frame, as the game renders
      // a side view of the knocked-out carrier on the turf (the chase camera sits in his back)
      const m = [0, 2].map((j) => s0.segPos[j]);
      zs.renderer.camera.position.set(m[0] + 2.2, 1.4, m[1] + 1.4);
      zs.renderer.camera.lookAt(m[0], 0.2, m[1]);
      zs.renderer.render(w);
    }, id);
    await page.screenshot({ path: `test-results/injury-${id}.png` });
  }
  expect(errors).toEqual([]);
});

test('a broken knee hobbles and a broken elbow hangs floppy (side views of the running carrier)', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?scenario=hit&hp=1&gfx=high');
  await page.waitForFunction(() => (window as unknown as Zs).__zs);
  const clips: string[] = [];
  for (let k = 0; k < 4; k++) {
    clips.push(await page.evaluate((k) => {
      type W = Zs['__zs']['world'] & { breakJoint(ai: number, joint: string, dof: number, end: number, relax: number): void;
        athletes: { muscles: { index(n: string): number }; controller: { debug?(): { clip?: string } } }[] };
      const zs = (window as unknown as Zs).__zs, w = zs.world as W;
      if (k === 0) {
        zs.advance(0.3);
        w.breakJoint(0, 'kneeL', w.athletes[0].muscles.index('kneeL.flex'), -1, 0.9);
        w.breakJoint(0, 'elbowR', w.athletes[0].muscles.index('elbowR.flex'), -1, 1);
        zs.advance(0.6);
      } else zs.advance(0.12);
      const s0 = w.scene.athletes[0].state, m = [0, 2].map((j) => s0.segPos[j]);
      // his left side (the broken knee), then his right (the broken elbow)
      zs.renderer.camera.position.set(m[0] + (k < 2 ? 3.2 : -3.2), 1.1, m[1] + 0.6);
      zs.renderer.camera.lookAt(m[0], 0.8, m[1]);
      zs.renderer.render(w);
      return String(w.athletes[0].controller.debug?.().clip);
    }, k));
    await page.screenshot({ path: `test-results/injury-hobble-${k}.png` });
  }
  console.log('clips:', clips);
  expect(clips.filter((c) => c === 'hobble').length).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});
