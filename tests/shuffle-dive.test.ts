// Side shuffle (shift lock) dive: the dive goes the way he moves while he keeps facing forward. Shuffling backward he
// dives backward and lands on his back; shuffling forward it is the normal dive (lands face down, travels forward).
import { beforeAll, describe, expect, it } from 'vitest';
import { HumanBrain, type HumanInput } from '../src/sim/brains/human';
import type { TrackingController } from '../src/sim/control/tracking';
import { qrot, quatAt } from '../src/sim/math';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { supportRunScenario } from '../src/sim/scenarios';
import { World } from '../src/sim/world';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

/** Shuffle along y (camera forward = +Z, shift lock on) for 1 s, then dive; returns the trunk's front axis as the
 *  flight ends (he lands) and the COM travel along z from the press to there. */
async function shuffleDive(y: number, x = 0) {
  const sc = supportRunScenario(STD, null);
  const brain = new HumanBrain(); brain.steerAssist = 0;
  sc.setup.athletes[0].brain = brain;
  const w = await World.create(mujocoEngine, sc.setup);
  const a = w.athletes[0], s = w.scene.athletes[0].state, ctl = a.controller as TrackingController;
  const input = (dive: boolean): HumanInput => ({ move: { x, y }, torso: 0, sprint: 0, armL: 0, armR: 0, held: new Set(dive ? ['dive'] : []), cameraYaw: 0, aimPitch: 0, shiftLock: true });
  let z0 = 0, x0 = 0, prev = 'none';
  while (w.time < 4) {
    const t = w.time;
    brain.latest = t < 0.5 ? null : input(t >= 1.5 && t < 1.6);
    if (t < 1.5) { z0 = s.com[2]; x0 = s.com[0]; }
    w.step();
    const st = ctl.root().dive;
    if (prev === 'flight' && st !== 'flight') break;
    prev = st;
  }
  return { front: qrot(quatAt(s.segQuat, a.trunkSeg), [0, 0, 1]), travel: s.com[2] - z0, side: s.com[0] - x0, left: qrot(quatAt(s.segQuat, a.trunkSeg), [1, 0, 0]), landed: w.time < 4, instab: w.scene.stats().instabilities };
}

describe('shuffle dive', () => {
  it('shuffling backward: dives backward and lands on his back', async () => {
    const r = await shuffleDive(-1);
    expect(r.landed).toBe(true);
    expect(r.front[1]).toBeGreaterThan(0.8);   // chest facing up
    expect(r.travel).toBeLessThan(-1);
    expect(r.instab).toBe(0);
  });
  it('shuffling left: dives to his left, still facing forward, and lands on his left side', async () => {
    const r = await shuffleDive(0, -1);   // stick left = world +X (camera along +Z)
    expect(r.landed).toBe(true);
    expect(r.left[1]).toBeLessThan(-0.8);  // the trunk's left side down
    expect(r.front[2]).toBeGreaterThan(0.8);
    expect(r.side).toBeGreaterThan(1);
    expect(r.instab).toBe(0);
  });
  it('shuffling forward: the normal dive (forward, face down)', async () => {
    const r = await shuffleDive(1);
    expect(r.landed).toBe(true);
    expect(r.front[1]).toBeLessThan(-0.5);
    expect(r.travel).toBeGreaterThan(1);
    expect(r.instab).toBe(0);
  });
});
