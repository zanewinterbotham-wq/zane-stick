// Jump (Commands.jump): a physics take-off like the dive's, landing on the feet. Standing, a quick counter-movement jump
// (a deep, slow one rises a football player's vertical jump [S4]); from a run a one-foot take-off off the next foot down
// that keeps most of the speed and lifts the feet high enough to hurdle a diver. The jump tuning's knobs (jump.ts) change
// what they say they change.
import { beforeAll, describe, expect, it } from 'vitest';
import { JUMP_DEFAULTS, type JumpTuning } from '../src/sim/anim/jump';
import { ScriptBrain } from '../src/sim/brains/script';
import type { TrackingController } from '../src/sim/control/tracking';
import type { Gait } from '../src/sim/control/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { supportRunScenario } from '../src/sim/scenarios';
import { World, type PhysicsSettings } from '../src/sim/world';
import { metrics, STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

interface Opts { hold?: number; after?: number; arms?: boolean; physics?: PhysicsSettings; jt?: Partial<JumpTuning>; steer?: boolean }

/** Jump pressed at `at` s (held `hold` s; hold < 0: tapped every 0.1 s from then on) from a gait (null = standing), then
 *  `after` s more of the same running; `steer`: standing, move sideways (+x) from 0.25 s after the press. */
async function jump(gait: Gait | null, at: number, { hold = 0.05, after = 2.5, arms = false, physics = STD, jt, steer = false }: Opts = {}) {
  const sc = supportRunScenario(physics, gait);
  sc.setup.jump = jt;
  sc.setup.athletes[0].brain = new ScriptBrain((t, p, c) => {
    if (t < 0.5) return;
    if (gait) { c.gait = gait; c.move = { x: 0, z: 1 }; }
    if (steer && t > at + 0.25) c.move = { x: 1, z: 0 };
    c.jump = t > at && (hold < 0 ? (t - at) % 0.1 < 0.05 : t < at + hold);
    // both hands up for a ball overhead, a little ahead
    if (arms) { const h = p.athletes[p.self].head; c.armL = c.armR = 1; c.aim = [h[0], h[1] + 1.5, h[2] + 0.5]; }
  });
  const w = await World.create(mujocoEngine, sc.setup);
  const a = w.athletes[0], s = w.scene.athletes[0].state, ctl = a.controller as TrackingController;
  const feet = [...a.footSegs[0], ...a.footSegs[1]];
  let y0 = 0, yMax = -Infinity, v0 = 0, vMin = Infinity, footAtApex = 0, takeoff = NaN, landed = NaN, maxTilt = 0, maxKnock = 0, jumps = 0, prev = 'none', fellAt = -1, flightCarry = 0, landGrf = 0, hands = 0, clear = 0, x0 = 0, shift = 0;
  while (w.time < at + after) {
    w.step();
    const m = metrics(w), st = ctl.root().jump;
    if (st !== 'none' && prev === 'none') jumps++;
    if (w.time <= at) { y0 = s.com[1]; v0 = m.speed; }
    else {
      if (s.com[1] > yMax) { yMax = s.com[1]; footAtApex = Math.min(...feet.map((k) => s.segPos[3 * k + 1])); }
      if (Number.isNaN(takeoff) && st === 'flight' && !a.feet[0].touching && !a.feet[1].touching) { takeoff = w.time; x0 = s.com[0]; }
      if (!Number.isNaN(takeoff) && Number.isNaN(landed) && st === 'none') { landed = w.time; shift = s.com[0] - x0; }
      if (st === 'flight') { flightCarry += Math.hypot(...a.carryForce); clear = Math.max(clear, Math.min(...feet.map((k) => s.segPos[3 * k + 1]))); }
      if (!Number.isNaN(landed) && w.time < landed + 0.3) landGrf = Math.max(landGrf, (a.feet[0].force + a.feet[1].force) / (a.mass * 9.81));
      hands = Math.max(hands, ...a.handSegs.map((k) => s.segPos[3 * k + 1]));
      if (w.time < at + 1.5) vMin = Math.min(vMin, m.speed);
      maxTilt = Math.max(maxTilt, m.tilt); maxKnock = Math.max(maxKnock, a.knock);
    }
    if (a.downBy && fellAt < 0) fellAt = w.time;
    prev = st;
  }
  // delay: from the press to both feet off the turf (s)
  const out = { delay: takeoff - at, rise: yMax - y0, v0, vMin, vEnd: metrics(w).speed, footAtApex, air: landed - takeoff, maxTiltDeg: maxTilt * 180 / Math.PI, maxKnock, jumps, fellAt, flightCarry, landGrf, hands, clear, shift, broken: a.injury.broken.size,
    standing: metrics(w).pelvisY > 0.85 * a.plan.standHeight, instabilities: w.scene.stats().instabilities };
  w.destroy();
  return out;
}

const fmt = (r: Awaited<ReturnType<typeof jump>>) => `take-off ${(r.delay * 1000).toFixed(0)} ms after the press, COM rise ${r.rise.toFixed(2)} m, air ${r.air.toFixed(2)} s, feet at ${r.footAtApex.toFixed(2)} m at the apex (${r.clear.toFixed(2)} m at most), speed ${r.v0.toFixed(1)} → min ${r.vMin.toFixed(1)} → ${r.vEnd.toFixed(1)} m/s, tilt ${r.maxTiltDeg.toFixed(0)}°, knock ${r.maxKnock.toFixed(2)}, landing ${r.landGrf.toFixed(1)} BW, hands up to ${r.hands.toFixed(2)} m`;
const upright = (r: Awaited<ReturnType<typeof jump>>) => [r.fellAt, r.standing, r.broken, r.instabilities];

describe('jump', () => {
  it('standing: one press is a quick jump off the turf in under 0.4 s (0.62 s before 2026-10-19), and lands upright', async () => {
    const r = await jump(null, 1);
    console.log(`standing jump: ${fmt(r)}`);
    expect(r.delay).toBeLessThan(0.4);
    expect(r.rise).toBeGreaterThan(0.3);
    expect(r.rise).toBeLessThan(0.8);
    expect(upright(r)).toEqual([-1, true, 0, 0]);
    expect(r.flightCarry).toBe(0);   // ballistic: no carry in the air
    expect(r.landGrf).toBeLessThan(6);  // a soft landing on the toes (flat-footed it was ~20 body weights in one step)
    expect(r.maxKnock).toBeLessThan(0.05);
  });
  it('standing, a deep slow counter-movement (dip 0.38 m in 0.4 s) rises a football player\'s vertical jump', async () => {
    const r = await jump(null, 1, { jt: { dip: 0.38, load: 0.4, push: 0.24 } });
    console.log(`deep standing jump: ${fmt(r)}`);
    expect(r.rise).toBeGreaterThan(0.55);
    expect(r.rise).toBeLessThan(0.8);
    expect(upright(r)).toEqual([-1, true, 0, 0]);
  });
  it('running: off the next foot down, it rises, keeps most of its speed, the feet clear a diver, and he runs on', async () => {
    const r = await jump('sprint', 3, { after: 3 });
    console.log(`sprinting jump: ${fmt(r)}`);
    expect(r.v0).toBeGreaterThan(8);
    expect(r.delay).toBeLessThan(0.25);
    // a one-foot take-off over a real stance's push: ~0.5 m (0.10 m before 2026-10-19, off the sim's 0.03 s toe-tap)
    expect(r.rise).toBeGreaterThan(0.35);
    expect(r.rise).toBeLessThan(0.8);
    expect(r.vMin).toBeGreaterThan(0.85 * r.v0);
    // the hurdle's tuck lifts the feet over a diver (a body lying on the turf, ~0.3 m of chest and pads)
    expect(r.clear).toBeGreaterThan(0.35);
    expect(r.fellAt).toBe(-1);
    expect(r.vEnd).toBeGreaterThan(0.8 * r.v0);   // running on at speed
    expect(r.maxKnock).toBeLessThan(0.05);
    expect([r.broken, r.instabilities]).toEqual([0, 0]);
  });
  it('jogging, a one-foot take-off with both hands up reaching for a high ball: up, and down on his feet', async () => {
    const r = await jump('jog', 2, { after: 3, arms: true }), reach = await jump('jog', 2, { hold: 0, after: 3, arms: true });
    console.log(`jogging jump, hands up: ${fmt(r)} (${reach.hands.toFixed(2)} m without the jump)`);
    expect(r.rise).toBeGreaterThan(0.12);
    expect(r.hands).toBeGreaterThan(reach.hands + 0.05);
    expect(upright(r)).toEqual([-1, true, 0, 0]);
  });
  it('the same jump on every preset body (minimum detail, 480 Hz)', async () => {
    for (const physics of [{ hz: 240, iterations: 20, detail: 'minimum' }, { hz: 480, iterations: 40, detail: 'standard' }] as PhysicsSettings[]) {
      const r = await jump(null, 1, { physics }), run = await jump('sprint', 3, { after: 3, physics });
      console.log(`${physics.detail} ${physics.hz} Hz: standing ${fmt(r)}; sprinting ${fmt(run)}`);
      expect(r.rise, `${physics.detail} ${physics.hz}`).toBeGreaterThan(0.3);
      expect(r.rise).toBeLessThan(0.8);
      expect(run.rise, `${physics.detail} ${physics.hz}`).toBeGreaterThan(0.3);
      for (const x of [r, run]) expect([x.fellAt, x.broken, x.instabilities]).toEqual([-1, 0, 0]);
      expect(r.standing).toBe(true);
    }
  });
  it('holding the button is one jump; it cannot be spammed', async () => {
    const tap = await jump(null, 1, { after: 2 }), held = await jump(null, 1, { hold: 2, after: 2 }), spam = await jump(null, 1, { hold: -1, after: 3 });
    expect(held.jumps).toBe(1);
    expect(held.rise).toBeCloseTo(tap.rise, 6);
    // tapped ten times a second for 3 s: each jump runs to its landing and the cooldown after it
    console.log(`tapped 10/s for 3 s: ${spam.jumps} jumps (a jump to its landing takes ${(tap.delay + tap.air).toFixed(2)} s)`);
    expect(spam.jumps).toBeGreaterThanOrEqual(2);
    expect(spam.jumps).toBeLessThanOrEqual(Math.ceil(3 / (tap.delay + tap.air + JUMP_DEFAULTS.cooldown)));
    expect([spam.fellAt, spam.instabilities]).toEqual([-1, 0]);
  });
});

describe('jump tuning', () => {
  it('height and running height raise the jump, monotonically', async () => {
    const stand = [], run = [];
    for (const h of [0.5, 1, 1.5]) {
      stand.push((await jump(null, 1, { jt: { height: h } })).rise);
      run.push((await jump('sprint', 3, { after: 2, jt: { runHeight: h } })).rise);
    }
    console.log(`standing rise at height 0.5/1/1.5: ${stand.map((x) => x.toFixed(2)).join(' / ')} m; sprinting at runHeight 0.5/1/1.5: ${run.map((x) => x.toFixed(2)).join(' / ')} m`);
    expect(stand[1]).toBeGreaterThan(stand[0]); expect(stand[2]).toBeGreaterThan(stand[1]);
    expect(run[1]).toBeGreaterThan(run[0]); expect(run[2]).toBeGreaterThan(run[1]);
  });
  it('a shallower, quicker dip leaves the turf sooner', async () => {
    const quick = await jump(null, 1, { jt: { dip: 0.15, load: 0.12 } }), deep = await jump(null, 1, { jt: { dip: 0.38, load: 0.4 } });
    console.log(`take-off after ${(quick.delay * 1000).toFixed(0)} ms (dip 0.15 m in 0.12 s, rise ${quick.rise.toFixed(2)} m) vs ${(deep.delay * 1000).toFixed(0)} ms (0.38 m in 0.4 s, ${deep.rise.toFixed(2)} m)`);
    expect(quick.delay).toBeLessThan(deep.delay - 0.15);
    expect(upright(quick)).toEqual([-1, true, 0, 0]);
  });
  it('charge on: a tap is a weaker jump, holding charges a full one that goes on the release', async () => {
    const jt = { charge: 0.5, chargeMin: 0.4 };
    const tap = await jump(null, 1, { jt }), full = await jump(null, 1, { jt, hold: 0.7 }), off = await jump(null, 1, { hold: 0.7 });
    expect(full.rise).toBeCloseTo(off.rise, 1);         // a full charge is the uncharged jump
    console.log(`charge 0.5 s: tap rise ${tap.rise.toFixed(2)} m (take-off ${(tap.delay * 1000).toFixed(0)} ms), held 0.7 s ${full.rise.toFixed(2)} m (${(full.delay * 1000).toFixed(0)} ms); charge off, held: ${off.rise.toFixed(2)} m`);
    expect(tap.rise).toBeLessThan(full.rise - 0.05);
    expect(full.delay).toBeGreaterThan(0.5);           // it went once the charge was full, not at the press
    expect(full.jumps).toBe(1);
    for (const r of [tap, full]) expect(upright(r)).toEqual([-1, true, 0, 0]);
  });
  it('air control steers a standing jump in the air (none by default: ballistic)', async () => {
    const off = await jump(null, 1, { steer: true }), on = await jump(null, 1, { steer: true, jt: { air: 6 } });
    console.log(`sideways in the air: ${off.shift.toFixed(2)} m ballistic, ${on.shift.toFixed(2)} m with air control 6 m/s²`);
    expect(off.flightCarry).toBe(0);
    expect(on.shift).toBeGreaterThan(off.shift + 0.1);
    expect(upright(on)).toEqual([-1, true, 0, 0]);
  });
});

/** Running (`gait`) at a standing opponent 25 m ahead, jump when `d` m short of him (head to head): knees and shins into
 *  his head and chest. Max trunk tilt (°) within 0.6 s of first contact, and when that contact came. */
async function kneeHit(d: number, gait: Gait = 'sprint', physics = STD) {
  const sc = supportRunScenario(physics, gait);
  sc.setup.athletes[0].brain = new ScriptBrain((t, p, c) => {
    if (t < 0.5) return;
    c.gait = gait; c.move = { x: 0, z: 1 };
    const dz = p.athletes[1 - p.self].head[2] - p.athletes[p.self].head[2];
    c.jump = dz < d && dz > d - 0.6;
  });
  sc.setup.athletes.push({ ...sc.setup.athletes[0], pos: [0, 0, 25], yaw: Math.PI, team: 1, brain: new ScriptBrain(() => {}) });
  const w = await World.create(mujocoEngine, sc.setup);
  const a = w.athletes[0];
  let hitAt = -1, maxTilt = 0;
  while (w.time < 12 && (hitAt < 0 || w.time < hitAt + 0.6)) {
    w.step();
    if (hitAt < 0 && a.playerContact) hitAt = w.time;
    if (hitAt >= 0) maxTilt = Math.max(maxTilt, metrics(w).tilt);
  }
  const out = { hitAt, tiltDeg: maxTilt * 180 / Math.PI, instabilities: w.scene.stats().instabilities };
  w.destroy();
  return out;
}

describe('jump into an opponent', () => {
  // In a jump's flight a contact takes the posture support away: no magic stability in the air. Before 2026-10-21 a
  // sprinter (driving through, his momentum absorbed the hit) stayed upright at ~17°.
  it('sprinting, his legs stopped by a standing opponent mid-air, he pitches forward past 60° within 0.6 s', async () => {
    const r = await kneeHit(4);
    console.log(`sprinting knee hit: contact at ${r.hitAt.toFixed(2)} s, trunk tilt ${r.tiltDeg.toFixed(0)}° within 0.6 s`);
    expect(r.hitAt).toBeGreaterThan(0);
    expect(r.tiltDeg).toBeGreaterThan(60);
    expect(r.instabilities).toBe(0);
  }, 60_000);
  it('jogging, the same contact pitches him forward too (slower: less momentum to turn him)', async () => {
    const r = await kneeHit(1.5, 'jog');
    console.log(`jogging knee hit: contact at ${r.hitAt.toFixed(2)} s, trunk tilt ${r.tiltDeg.toFixed(0)}° within 0.6 s`);
    expect(r.hitAt).toBeGreaterThan(0);
    expect(r.tiltDeg).toBeGreaterThan(30);
    expect(r.instabilities).toBe(0);
  }, 60_000);
});
