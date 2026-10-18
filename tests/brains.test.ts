import { beforeAll, describe, expect, it } from 'vitest';
import { CarrierBrain, DIFFICULTY } from '../src/sim/brains/carrier';
import { ScriptBrain } from '../src/sim/brains/script';
import { TacklerBrain } from '../src/sim/brains/tackler';
import type { AthleteView, Brain, Perception } from '../src/sim/brains/types';
import type { Commands } from '../src/sim/control/types';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../src/sim/drills/openField';
import type { Vec3 } from '../src/sim/math';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { Rng } from '../src/sim/rng';
import type { PhysicsSettings } from '../src/sim/world';

const DT = 1 / 240;
const view = (com: Vec3, vel: Vec3, hasBall = false, heading = 0): AthleteView => ({ com, comVel: vel, pelvis: com, head: [com[0], 1.8, com[2]], heading, down: false, hasBall });
const field = { halfWidth: 24.38, goalZ: -45.72, dirZ: -1 as const };

/** Carrier at the origin running for −Z against a tackler coming straight at him; both move on their own
 *  (the carrier at its commanded velocity, slewed like a body would), for `t` s. */
function approach(brain: CarrierBrain, t = 2.5) {
  let me: Vec3 = [0, 1, 0], v: Vec3 = [0, 0, -4], o: Vec3 = [0, 1, -9];
  const ov: Vec3 = [0, 0, 8], out: Commands[] = [];
  for (let i = 0; i < t / DT; i++) {
    const c = brain.think({ time: i * DT, self: 1, athletes: [view(o, ov), view(me, v, true, Math.PI)], field }, DT);
    out.push(c);
    const sp = c.gait === 'sprint' ? 10.5 : 4.2, a = 8 * DT;
    for (const j of [0, 2]) v[j] += Math.max(-a, Math.min(a, (j ? c.move.z : c.move.x) * sp - v[j]));
    me = [me[0] + v[0] * DT, 1, me[2] + v[2] * DT];
    o = [o[0] + ov[0] * DT, 1, o[2] + ov[2] * DT];
  }
  return out;
}

describe('CarrierBrain', () => {
  it('jukes a tackler coming straight at him with a plant-and-cut, with smooth commands otherwise', () => {
    const b = new CarrierBrain(new Rng(3), DIFFICULTY.normal);
    const cs = approach(b);
    const cuts = cs.filter((c, i) => c.plantCut !== 0 && cs[i - 1]?.plantCut === 0).length;
    const steps = cs.slice(1).map((c, i) => Math.hypot(c.move.x - cs[i].move.x, c.move.z - cs[i].move.z));
    const mean = steps.reduce((a, x) => a + x, 0) / steps.length;
    expect(cuts).toBeGreaterThanOrEqual(1);
    expect(b.jukes).toBe(cuts);
    expect(mean).toBeLessThan(0.006);
    // nothing jumps but the plants and the one switch to the burst gait (made at the same speed): no chatter
    expect(steps.filter((s, i) => s > 0.05 && cs[i + 1].plantCut === 0 && cs[i + 1].gait === cs[i].gait).length).toBe(0);
    expect(Math.max(...cs.map((c) => Math.hypot(c.move.x, c.move.z)))).toBeLessThanOrEqual(1 + 1e-9);
    expect(cs.every((c) => c.carry === 2)).toBe(true);
    expect(cs.some((c) => c.gait === 'sprint')).toBe(true);   // bursts after the move
  });

  it('is deterministic for a seed and varies its moves across seeds', () => {
    const sig = (seed: number) => approach(new CarrierBrain(new Rng(seed), DIFFICULTY.normal)).map((c) => `${c.move.x.toFixed(6)},${c.plantCut}`).join(';');
    expect(sig(5)).toBe(sig(5));
    const sides = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => approach(new CarrierBrain(new Rng(s), DIFFICULTY.normal)).find((c) => c.plantCut !== 0)?.plantCut ?? 0));
    expect(sides.has(1) && sides.has(-1)).toBe(true);
  });

  it('after a fumble defends: no carry, runs at whoever has the ball', () => {
    const b = new CarrierBrain(new Rng(1), DIFFICULTY.normal);
    let c: Commands = b.think({ time: 0, self: 1, athletes: [view([5, 1, 0], [0, 0, 0], true), view([0, 1, 0], [0, 0, 0])], field }, DT);
    for (let i = 1; i < 120; i++) c = b.think({ time: i * DT, self: 1, athletes: [view([5, 1, 0], [0, 0, 0], true), view([0, 1, 0], [0, 0, 0], false, Math.PI / 2)], field }, DT);
    expect(c.carry).toBe(0);
    expect(c.move.x).toBeGreaterThan(0.5);
  });
});

describe('TacklerBrain', () => {
  const run = (b: TacklerBrain, p: (t: number) => Perception, t: number) => { let c!: Commands; for (let i = 0; i < t / DT; i++) c = b.think(p(i * DT), DT); return c; };

  it('leads a crossing carrier instead of chasing where he is', () => {
    const b = new TacklerBrain(new Rng(1), DIFFICULTY.hard);
    const c = run(b, (time) => ({ time, self: 0, athletes: [view([0, 1, 0], [0, 0, 0]), view([-6, 1, 10], [6, 0, 0], true)], field }), 0.5);
    const pursuit = Math.atan2(-6, 10), heading = Math.atan2(c.move.x, c.move.z);
    expect(heading).toBeGreaterThan(pursuit + 0.3);   // toward where he is going (+X)
    expect(c.gait).toBe('sprint');
  });

  it('breaks down, then strikes with both arms gripping, and lays out for a carrier slipping away', () => {
    const b = new TacklerBrain(new Rng(1), DIFFICULTY.hard);
    // closing fast from 5 m: break down
    let c = run(b, (time) => ({ time, self: 0, athletes: [view([0, 1, 0], [0, 0, 7]), view([0, 1, 5], [0, 0, -3], true)], field }), 0.1);
    expect(b.phase).toBe('breakdown');
    expect(c.sink).toBeGreaterThan(0);
    expect(c.chopFeet).toBe(true);
    // 1.5 m: strike
    c = run(b, (time) => ({ time: 1 + time, self: 0, athletes: [view([0, 1, 0], [0, 0, 5]), view([0, 1, 1.5], [0, 0, -2], true)], field }), 0.4);
    expect(b.phase).toBe('strike');
    expect([c.gripL, c.gripR, c.armL, c.armR]).toEqual([true, true, 1, 1]);
    // 2 m ahead and running away as fast as I am: dive, once
    const b2 = new TacklerBrain(new Rng(1), DIFFICULTY.hard);
    const cs: Commands[] = [];
    for (let i = 0; i < 0.5 / DT; i++) cs.push(b2.think({ time: i * DT, self: 0, athletes: [view([0, 1, 0], [0, 0, 7]), view([0, 1, 1.8], [0, 0, 7], true)], field }, DT));
    expect(cs.filter((x) => x.dive).length).toBe(1);
  });

  it('dives on a loose ball rolling away from it, but not on one lying still', () => {
    for (const [vz, dives] of [[1.5, 1], [0, 0]] as const) {
      const b = new TacklerBrain(new Rng(1), DIFFICULTY.normal);
      const p = (time: number): Perception => ({ time, self: 0, athletes: [view([0, 1, 0], [0, 0, 5]), view([3, 1, 8], [0, 0, 0])], field, ball: { pos: [0, 0.1, 2.2], vel: [0, 0, vz] } });
      const cs: Commands[] = [];
      for (let i = 0; i < 0.2 / DT; i++) cs.push(b.think(p(i * DT), DT));
      expect(cs.filter((x) => x.dive).length).toBe(dives);
      expect(cs.at(-1)!.carry).toBe(0);
    }
  });

  it('slows for a loose ball it cannot turn onto at speed, then reaches both hands down to it', () => {
    const b = new TacklerBrain(new Rng(1), DIFFICULTY.normal);
    // running at 9 m/s along +X, the ball 4 m off to the side: a sprint would orbit it
    const side = (time: number): Perception => ({ time, self: 0, athletes: [view([0, 1, 0], [9, 0, 0], false, Math.PI / 2), view([30, 1, 30], [0, 0, 0])], field, ball: { pos: [0, 0.1, 4], vel: [0, 0, 0] } });
    const c = run(b, side, 0.5);
    expect(Math.hypot(c.move.x, c.move.z) * 10).toBeLessThan(4);
    expect(c.dive).toBe(false);
    // standing over it: stoops, both arms and grips on the ball
    const near = (time: number): Perception => ({ time, self: 0, athletes: [view([0, 1, 0], [0, 0, 0]), view([30, 1, 30], [0, 0, 0])], field, ball: { pos: [0, 0.1, 0.5], vel: [0, 0, 0] } });
    const d = run(new TacklerBrain(new Rng(1), DIFFICULTY.normal), near, 0.5);
    expect([d.armL, d.armR, d.gripL, d.gripR]).toEqual([1, 1, true, true]);
    expect(d.aim).toEqual([0, 0.1, 0.5]);
    expect(d.sink).toBeGreaterThan(0);
    expect(d.lean.fwd).toBeGreaterThan(0.5);
  });
});

describe('open field, headless', () => {
  const PH: PhysicsSettings = { hz: 240, iterations: 30, detail: 'standard' };
  beforeAll(() => mujocoEngine.init());
  /** A straight-line tackler: sprints at where the carrier is now, wraps when close. */
  const lazy = () => new ScriptBrain((_t, p, c) => {
    const me = p.athletes[p.self], b = p.athletes[1 - p.self];
    if (me.down) return;
    const dx = b.com[0] - me.com[0], dz = b.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1;
    c.gait = 'sprint'; c.move = { x: dx / d, z: dz / d };
    if (d < 2.5) { c.contactMode = true; c.armL = c.armR = 1; c.gripL = c.gripR = true; c.wrap = d < 1.4; }
  });
  async function reps(n: number, tackler: (rep: number) => Brain) {
    const r = { tackled: 0, escaped: 0, jukes: 0, dMove: 0, steps: 0, fallsNoContact: 0, tackleTime: 0, instabilities: 0 };
    for (let rep = 0; rep < n; rep++) {
      const d = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: PH, timeLimit: 8 }, tackler(rep), rep);
      const w = d.world, car = w.athletes[d.carrier];
      let touched = false, prev = { ...car.cmd.move }, past = false;
      while (!d.ended) {
        d.step();
        touched ||= car.playerContact;
        r.dMove += Math.hypot(car.cmd.move.x - prev.x, car.cmd.move.z - prev.z); prev = { ...car.cmd.move }; r.steps++;
        const cz = w.scene.athletes[d.carrier].state.com[2], tz = w.scene.athletes[d.human].state.com[2];
        past ||= tz - cz > 3 && !car.playerContact;
      }
      if (d.ended === 'down') { if (touched) { r.tackled++; r.tackleTime += d.repTime; } else r.fallsNoContact++; }
      if (past || d.ended === 'touchdown') r.escaped++;
      // the world's brain is the drill's possession wrapper; the bot's own brain lives in d.brains
      r.jukes += (d.brains[d.carrier] as CarrierBrain).jukes ?? 0;
      r.instabilities += w.scene.stats().instabilities;
      d.destroy();
    }
    return { ...r, dMove: r.dMove / r.steps, tackleTime: r.tackled ? r.tackleTime / r.tackled : NaN };
  }

  it('the carrier gets past a straight-line tackler, smoothly and without falling', async () => {
    const r = await reps(6, lazy);
    console.log('carrier vs straight-line tackler', r);
    expect(r.escaped).toBeGreaterThanOrEqual(5);
    expect(r.jukes).toBeGreaterThanOrEqual(3);
    expect(r.fallsNoContact).toBe(0);
    expect(r.dMove).toBeLessThan(0.005);
    expect(r.instabilities).toBe(0);
  });

  it('TacklerBrain takes angles that catch the carrier in a fair share of reps', async () => {
    const r = await reps(8, (rep) => new TacklerBrain(new Rng(rep * 31 + 7), DIFFICULTY.normal));
    console.log('carrier vs TacklerBrain', r);
    expect(r.tackled).toBeGreaterThanOrEqual(2);
    expect(r.fallsNoContact).toBe(0);
    expect(r.instabilities).toBe(0);
  });
});
