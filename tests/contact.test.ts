// Contact technique with the active ragdoll (design §6.5): hip thrust, pad level and grabbing. Outcomes come out of
// the physics; these check that the technique a player chooses changes them the way it does on a field.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ATHLETE, type BodyPlan } from '../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import { ScriptBrain } from '../src/sim/brains/script';
import { TrackingController } from '../src/sim/control/tracking';
import type { Commands } from '../src/sim/control/types';
import type { MuscleSet } from '../src/sim/muscles';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { supportRunScenario } from '../src/sim/scenarios';
import { World } from '../src/sim/world';
import { collide, type Side } from './helpers/contact';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

const tracked = (p: BodyPlan, m: MuscleSet) => new TrackingController(p, m);
const support = { ...DEFAULT_SUPPORT };

describe('hip thrust', () => {
  it('from standing, a held thrust lunges the whole body forward', async () => {
    const sc = supportRunScenario(STD, null);
    sc.setup.athletes[0].brain = new ScriptBrain((t, _p, c) => { c.thrustHips = t > 1 && t < 1.5; });
    const w = await World.create(mujocoEngine, sc.setup);
    const s = w.scene.athletes[0].state;
    let z0 = NaN, z1 = NaN;
    while (w.time < 3) {
      w.step();
      if (Number.isNaN(z0) && w.time >= 1) z0 = s.com[2];
      if (Number.isNaN(z1) && w.time >= 1.5) z1 = s.com[2];
    }
    const out = { lunge: z1 - z0, down: !!w.athletes[0].downBy, instabilities: w.scene.stats().instabilities };
    console.log(`standing thrust: COM forward ${out.lunge.toFixed(2)} m in 0.5 s, down after ${out.down}`);
    expect(out.lunge).toBeGreaterThan(1);
    expect(out.instabilities).toBe(0);
    w.destroy();
  });
});

describe('pad level', () => {
  /** Same speed (move scales the sprint), same mass, same hands: only the sink and the lean that goes with it
   *  differ. Scripts are in the athlete's own frame (collide's mirrorB) and the run-up gives time to get low. */
  const low = (speed: number): Side => ({ speed, script: (_t, c) => { c.contactMode = true; c.move = { x: 0, z: speed / 10.5 }; c.gait = 'sprint'; c.driveLegs = 1; c.shoot = true; c.sink = 1; c.lean.fwd = 0.5; } });
  const high = (speed: number): Side => ({ speed, script: (_t, c) => { c.contactMode = true; c.move = { x: 0, z: speed / 10.5 }; c.gait = 'sprint'; c.driveLegs = 1; c.shoot = true; } });
  const target = (speed: number): Side => ({ speed, script: (_t, c) => { c.move = { x: 0, z: speed / 4.2 }; c.gait = 'jog'; } });

  /** Down, and lost balance (support knocked away, knock > 0.9, within 1.5 s of contact), per athlete. */
  async function run(a: Side, b: Side, seed: number) {
    const knock = [0, 0];
    let t0 = -1;
    const r = await collide(a, b, seed, STD, 3, { gap: 9, mirrorB: true, support, onStep: (w) => {
      if (t0 < 0 && w.lastHitForce > 0) t0 = w.time;
      if (t0 >= 0 && w.time < t0 + 1.5) w.athletes.forEach((x, k) => { knock[k] = Math.max(knock[k], x.knock); });
    } });
    return { down: [r.aDown, r.bDown], knock, instabilities: r.instabilities };
  }

  it('a low driver knocks the same target off balance at least as often as an upright one', async () => {
    const rate = async (driver: Side) => {
      let down = 0, lost = 0, driverLost = 0, instabilities = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const r = await run(driver, target(3), seed);
        down += +r.down[1]; lost += +(r.down[1] || r.knock[1] > 0.9); driverLost += +(r.down[0] || r.knock[0] > 0.9); instabilities += r.instabilities;
      }
      return { down, lost, driverLost, instabilities };
    };
    const lo = await rate(low(5)), hi = await rate(high(5));
    console.log('target (jogging in at 3 m/s) hit at 5 m/s, of 12: low driver', lo, 'upright driver', hi);
    // (downs are rare at this speed and swing either way over seeds; losing balance is the outcome measured)
    expect(lo.down + lo.lost).toBeGreaterThanOrEqual(hi.down + hi.lost);
    expect(lo.instabilities + hi.instabilities).toBe(0);
  });
  it('head on at the same speed, the low athlete wins', async () => {
    let wins = 0, n = 0, instabilities = 0;
    // low as A and as B, so neither side of the setup decides it
    for (const lowIsA of [true, false]) for (let seed = 1; seed <= 8; seed++) {
      const r = await run(lowIsA ? low(5) : high(5), lowIsA ? high(5) : low(5), seed);
      const [l, h] = lowIsA ? [0, 1] : [1, 0];
      // a win: the other goes down and you do not; otherwise the other was knocked further off balance
      wins += +(r.down[h] && !r.down[l] || r.down[h] === r.down[l] && r.knock[h] > r.knock[l]); n++;
      instabilities += r.instabilities;
    }
    console.log(`low vs upright head on at 5 m/s each: low wins ${wins}/${n}`);
    expect(wins / n).toBeGreaterThanOrEqual(0.7);
    expect(instabilities).toBe(0);
  });
});

describe('grabbing', () => {
  /** Arms up as the human's arm buttons do it: reach and grip, aimed 1.5 m along the view at chest height. */
  const grabber = (from = 0.3) => new ScriptBrain((t, p, c: Commands) => {
    if (t < from) return;
    c.contactMode = true; c.armL = c.armR = 1; c.gripL = c.gripR = true;
    const h = p.athletes[p.self].head;
    c.aim = [h[0], h[1] - 0.3, h[2] + 1.5];
  });

  /** A runner crossing `ahead` m in front of a standing grabber at 4 m/s: does a hand catch him, does it hold,
   *  and how far does he get in the second after the catch. */
  async function pass(ahead: number, seed: number) {
    const w = await World.create(mujocoEngine, {
      physics: STD, seed, assist: 0, support: { ...DEFAULT_SUPPORT },
      athletes: [
        { params: DEFAULT_ATHLETE, pos: [0, 0, 0], yaw: 0, team: 0, controller: tracked, brain: grabber() },
        { params: DEFAULT_ATHLETE, pos: [-3 - 0.1 * seed, 0, ahead], yaw: Math.PI / 2, team: 1, controller: tracked, brain: new ScriptBrain((_t, _p, c) => { c.move = { x: 1, z: 0 }; c.gait = 'jog'; }) },
      ],
    });
    w.scene.setInitialVelocity(1, [4, 0, 0]);
    const b = w.scene.athletes[1].state, a = w.athletes[0];
    let tGrip = -1, x0 = NaN, force = 0, n = 0;
    while (w.time < 2.5) {
      w.step();
      if (tGrip < 0 && a.grips.some((g) => g.active)) { tGrip = w.time; x0 = b.com[0]; }
      if (tGrip >= 0 && w.time < tGrip + 1) { force += a.grips.reduce((s, g) => s + (g.active ? g.force : 0), 0); n++; }
    }
    const out = { gripped: tGrip >= 0, held: a.grips.some((g) => g.active), runOn: tGrip >= 0 ? b.com[0] - x0 : NaN, force: n ? force / n : 0, instabilities: w.scene.stats().instabilities };
    w.destroy();
    return out;
  }

  it('catches a runner crossing within reach and holds him back', async () => {
    let gripped = 0, held = 0, runOn = 0, force = 0, k = 0, instabilities = 0;
    const aheads = [0.6, 0.7, 0.8, 0.9, 1.0];
    for (const ahead of aheads) for (const seed of [1, 2, 3]) {
      const r = await pass(ahead, seed);
      gripped += +r.gripped; held += +r.held; instabilities += r.instabilities;
      if (r.gripped) { runOn += r.runOn; force += r.force; k++; }
    }
    const n = aheads.length * 3;
    console.log(`grab: caught ${gripped}/${n}, still held after 2.5 s ${held}/${n}; once caught the runner went on ${(runOn / k).toFixed(2)} m in 1 s, mean grip force ${(force / k).toFixed(0)} N`);
    expect(gripped / n).toBeGreaterThanOrEqual(0.8);
    expect(held / n).toBeGreaterThanOrEqual(0.6);
    // unhindered he would cover ~4 m; a hand that tears off at once is dragged along with him (~5 m before)
    expect(runOn / k).toBeLessThan(4.2);
    expect(instabilities).toBe(0);
  });

  it('a raised arm that holds an opponent pulls him in, through the muscles', async () => {
    let gripped = 0, pull = 0, force = 0, carried = 0, instabilities = 0;
    const n = 4;
    for (let seed = 1; seed <= n; seed++) {
      const w = await World.create(mujocoEngine, {
        physics: STD, seed, assist: 0, support: { ...DEFAULT_SUPPORT },
        athletes: [
          { params: DEFAULT_ATHLETE, pos: [0, 0, 0], yaw: 0, team: 0, controller: tracked, brain: grabber(0) },
          { params: DEFAULT_ATHLETE, pos: [0.03 * (seed - 2), 0, 0.75], yaw: Math.PI, team: 1, controller: tracked, brain: new ScriptBrain(() => {}) },
        ],
      });
      const b = w.scene.athletes[1].state, a = w.athletes[0];
      let tGrip = -1, z0 = NaN, f = 0, m = 0;
      while (w.time < 3) {
        const touching = w.athletes.map((x) => x.playerContact);
        w.step();
        if (w.athletes.some((x, k) => touching[k] && x.carryForce.some((v) => v !== 0))) carried++;
        if (tGrip < 0 && a.grips.some((g) => g.active)) { tGrip = w.time; z0 = b.com[2]; }
        if (tGrip >= 0 && w.time < tGrip + 1.5) { f += a.grips.reduce((s, g) => s + (g.active ? g.force : 0), 0); m++; }
        if (tGrip >= 0 && w.time >= tGrip + 1.5) break;
      }
      if (tGrip >= 0) { gripped++; pull += (z0 - b.com[2]) / n; force += f / m / n; }
      instabilities += w.scene.stats().instabilities;
      w.destroy();
    }
    console.log(`pull: gripped ${gripped}/${n}; standing opponent pulled in ${pull.toFixed(2)} m in 1.5 s, mean grip force ${force.toFixed(0)} N`);
    expect(gripped).toBe(n);
    expect(pull).toBeGreaterThan(0.15);
    expect(carried).toBe(0);
    expect(instabilities).toBe(0);
  });
});
