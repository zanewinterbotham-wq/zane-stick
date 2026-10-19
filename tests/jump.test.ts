// Jump (Commands.jump): a physics take-off like the dive's, landing on the feet. Standing it rises a football player's
// vertical jump [S4]; from a run it keeps most of the speed and lifts the feet high enough to hurdle a diver.
import { beforeAll, describe, expect, it } from 'vitest';
import { ScriptBrain } from '../src/sim/brains/script';
import type { TrackingController } from '../src/sim/control/tracking';
import type { Gait } from '../src/sim/control/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { supportRunScenario } from '../src/sim/scenarios';
import { World, type PhysicsSettings } from '../src/sim/world';
import { metrics, STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

/** Jump pressed at `at` s (held `hold` s; hold < 0: tapped every 0.1 s from then on) from a gait (null = standing), then
 *  `after` s more of the same running. */
async function jump(gait: Gait | null, at: number, hold = 0.05, after = 2.5, arms = false, physics: PhysicsSettings = STD) {
  const sc = supportRunScenario(physics, gait);
  sc.setup.athletes[0].brain = new ScriptBrain((t, p, c) => {
    if (t < 0.5) return;
    if (gait) { c.gait = gait; c.move = { x: 0, z: 1 }; }
    c.jump = t > at && (hold < 0 ? (t - at) % 0.1 < 0.05 : t < at + hold);
    // both hands up for a ball overhead, a little ahead
    if (arms) { const h = p.athletes[p.self].head; c.armL = c.armR = 1; c.aim = [h[0], h[1] + 1.5, h[2] + 0.5]; }
  });
  const w = await World.create(mujocoEngine, sc.setup);
  const a = w.athletes[0], s = w.scene.athletes[0].state, ctl = a.controller as TrackingController;
  const feet = [...a.footSegs[0], ...a.footSegs[1]];
  let y0 = 0, yMax = -Infinity, v0 = 0, vMin = Infinity, footAtApex = 0, takeoff = NaN, landed = NaN, maxTilt = 0, maxKnock = 0, jumps = 0, prev = 'none', fellAt = -1, flightCarry = 0, landGrf = 0, hands = 0, clear = 0;
  while (w.time < at + after) {
    w.step();
    const m = metrics(w), st = ctl.root().jump;
    if (st !== 'none' && prev === 'none') jumps++;
    if (w.time <= at) { y0 = s.com[1]; v0 = m.speed; }
    else {
      if (s.com[1] > yMax) { yMax = s.com[1]; footAtApex = Math.min(...feet.map((k) => s.segPos[3 * k + 1])); }
      if (Number.isNaN(takeoff) && st === 'flight' && !a.feet[0].touching && !a.feet[1].touching) takeoff = w.time;
      if (!Number.isNaN(takeoff) && Number.isNaN(landed) && st === 'none') landed = w.time;
      if (st === 'flight') { flightCarry += Math.hypot(...a.carryForce); clear = Math.max(clear, Math.min(...feet.map((k) => s.segPos[3 * k + 1]))); }
      if (!Number.isNaN(landed) && w.time < landed + 0.3) landGrf = Math.max(landGrf, (a.feet[0].force + a.feet[1].force) / (a.mass * 9.81));
      hands = Math.max(hands, ...a.handSegs.map((k) => s.segPos[3 * k + 1]));
      if (w.time < at + 1.5) vMin = Math.min(vMin, m.speed);
      maxTilt = Math.max(maxTilt, m.tilt); maxKnock = Math.max(maxKnock, a.knock);
    }
    if (a.downBy && fellAt < 0) fellAt = w.time;
    prev = st;
  }
  const out = { rise: yMax - y0, v0, vMin, vEnd: metrics(w).speed, footAtApex, air: landed - takeoff, maxTiltDeg: maxTilt * 180 / Math.PI, maxKnock, jumps, fellAt, flightCarry, landGrf, hands, clear, broken: a.injury.broken.size,
    standing: metrics(w).pelvisY > 0.85 * a.plan.standHeight, instabilities: w.scene.stats().instabilities };
  w.destroy();
  return out;
}

const fmt = (r: Awaited<ReturnType<typeof jump>>) => `COM rise ${r.rise.toFixed(2)} m, air ${r.air.toFixed(2)} s, feet at ${r.footAtApex.toFixed(2)} m at the apex (${r.clear.toFixed(2)} m at most), speed ${r.v0.toFixed(1)} → min ${r.vMin.toFixed(1)} → ${r.vEnd.toFixed(1)} m/s, tilt ${r.maxTiltDeg.toFixed(0)}°, knock ${r.maxKnock.toFixed(2)}, landing ${r.landGrf.toFixed(1)} BW, hands up to ${r.hands.toFixed(2)} m`;

describe('jump', () => {
  it('standing: one press rises a football player\'s vertical jump and lands upright', async () => {
    const r = await jump(null, 1);
    console.log(`standing jump: ${fmt(r)}`);
    expect(r.rise).toBeGreaterThan(0.55);
    expect(r.rise).toBeLessThan(0.8);
    expect(r.fellAt).toBe(-1);
    expect(r.standing).toBe(true);
    expect(r.flightCarry).toBe(0);   // ballistic: no carry in the air
    expect(r.landGrf).toBeLessThan(6);  // a soft landing on the toes (flat-footed it was ~20 body weights in one step)
    expect(r.maxKnock).toBeLessThan(0.05);
    expect([r.broken, r.instabilities]).toEqual([0, 0]);
  });
  it('running: keeps most of its speed, the feet clear a diver, and he runs on after the landing', async () => {
    const r = await jump('sprint', 3, 0.05, 3);
    console.log(`sprinting jump: ${fmt(r)}`);
    expect(r.v0).toBeGreaterThan(8);
    expect(r.vMin).toBeGreaterThan(0.85 * r.v0);
    // a sprint stride's brief toe contact lifts the body little; the hurdle's tuck lifts the feet over a diver
    // (a body lying on the turf, ~0.3 m of chest and pads)
    expect(r.clear).toBeGreaterThan(0.35);
    expect(r.fellAt).toBe(-1);
    expect(r.vEnd).toBeGreaterThan(0.8 * r.v0);   // running on at speed
    expect(r.maxKnock).toBeLessThan(0.05);
    expect([r.broken, r.instabilities]).toEqual([0, 0]);
  });
  it('jogging, a one-foot take-off with both hands up reaching for a high ball: up, and down on his feet', async () => {
    const r = await jump('jog', 2, 0.05, 3, true), reach = await jump('jog', 2, 0, 3, true);
    console.log(`jogging jump, hands up: ${fmt(r)} (${reach.hands.toFixed(2)} m without the jump)`);
    // a jog stride's one-foot take-off lifts him less than a standing jump does (its contact is brief), but the hands
    // still go higher than they reach without it
    expect(r.rise).toBeGreaterThan(0.12);
    expect(r.hands).toBeGreaterThan(reach.hands + 0.05);
    expect(r.fellAt).toBe(-1);
    expect(r.standing).toBe(true);
    expect([r.broken, r.instabilities]).toEqual([0, 0]);
  });
  it('the same jump on every preset body (minimum detail, 480 Hz)', async () => {
    for (const physics of [{ hz: 240, iterations: 20, detail: 'minimum' }, { hz: 480, iterations: 40, detail: 'standard' }] as PhysicsSettings[]) {
      const r = await jump(null, 1, 0.05, 2.5, false, physics), run = await jump('sprint', 3, 0.05, 3, false, physics);
      console.log(`${physics.detail} ${physics.hz} Hz: standing ${fmt(r)}; sprinting ${fmt(run)}`);
      expect(r.rise, `${physics.detail} ${physics.hz}`).toBeGreaterThan(0.5);
      expect(r.rise).toBeLessThan(0.8);
      for (const x of [r, run]) expect([x.fellAt, x.broken, x.instabilities]).toEqual([-1, 0, 0]);
      expect(r.standing).toBe(true);
    }
  });
  it('holding the button is one jump; it cannot be spammed', async () => {
    const tap = await jump(null, 1, 0.05, 2), held = await jump(null, 1, 2, 2), spam = await jump(null, 1, -1, 3);
    expect(held.jumps).toBe(1);
    expect(held.rise).toBeCloseTo(tap.rise, 6);
    // tapped ten times a second for 3 s: each jump runs to its landing and the cooldown after it (~1.6 s a jump)
    expect(spam.jumps).toBe(2);
    expect([spam.fellAt, spam.instabilities]).toEqual([-1, 0]);
  });
});
