// Active ragdoll (design §6.5): tracking controller + world support. With support on, athletes run really fast
// and never fall on their own; contact outcomes still come out of the physics (judged on rates over seeds).
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ATHLETE } from '../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import type { Gait } from '../src/sim/control/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { carrierVsTacklerScenario, supportRunScenario } from '../src/sim/scenarios';
import { World, type PhysicsSettings } from '../src/sim/world';
import { collide, technique, type Side } from './helpers/contact';
import { metrics, STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

async function run(gait: Gait | null, seconds: number, opts: { physics?: PhysicsSettings; cutAt?: number } = {}) {
  const w = await World.create(mujocoEngine, supportRunScenario(opts.physics ?? STD, gait, { cutAt: opts.cutAt }).setup);
  let top = 0, maxTilt = 0, fellAt = -1;
  for (let i = 0, n = Math.round(seconds / w.dt); i < n; i++) {
    w.step();
    const m = metrics(w);
    top = Math.max(top, m.speed); maxTilt = Math.max(maxTilt, m.tilt);
    if (m.down) { fellAt = w.time; break; }
  }
  const out = { top, maxTiltDeg: maxTilt * 180 / Math.PI, fellAt, instabilities: w.scene.stats().instabilities, world: w };
  return out;
}

describe('supported locomotion', () => {
  it('stands 30 s', async () => {
    const r = await run(null, 30);
    expect(r.fellAt).toBe(-1);
    expect(r.instabilities).toBe(0);
    expect(r.maxTiltDeg).toBeLessThan(5);
    r.world.destroy();
  });
  it.each([['walk', 1.2], ['jog', 3.6], ['sprint', 9]] as const)('%s 10 s without falling, reaching ≥ %s m/s', async (gait, speed) => {
    const r = await run(gait, 10);
    console.log(`${gait}: top ${r.top.toFixed(2)} m/s, max trunk tilt ${r.maxTiltDeg.toFixed(0)}°`);
    expect(r.fellAt).toBe(-1);
    expect(r.instabilities).toBe(0);
    expect(r.top).toBeGreaterThanOrEqual(speed);
    r.world.destroy();
  });
  it('accelerates quickly: 0 → 9 m/s in under 2.5 s from the sprint command', async () => {
    const w = await World.create(mujocoEngine, supportRunScenario(STD, 'sprint').setup);
    let t9 = -1;
    while (w.time < 5 && t9 < 0) { w.step(); if (metrics(w).speed >= 9) t9 = w.time - 0.5; }
    console.log(`0 → 9 m/s in ${t9.toFixed(2)} s`);
    expect(t9).toBeGreaterThan(0);
    expect(t9).toBeLessThan(2.5);
    w.destroy();
  });
  it('sprints and cuts 45° without falling, on the minimum body too', async () => {
    for (const physics of [STD, { hz: 240, iterations: 20, detail: 'minimum' } as PhysicsSettings]) {
      const r = await run('sprint', 6, { physics, cutAt: 3 });
      expect(r.fellAt).toBe(-1);
      expect(r.instabilities).toBe(0);
      expect(r.top).toBeGreaterThanOrEqual(9);
      r.world.destroy();
    }
  });
  it('is deterministic', async () => {
    const state = async () => {
      const r = await run('sprint', 3, { cutAt: 2 });
      const s = r.world.scene.athletes[0].state, v = [...s.segPos, ...s.segQuat, ...s.q, ...s.qd];
      r.world.destroy();
      return v;
    };
    expect(await state()).toEqual(await state());
  });
});

describe('support in contact', () => {
  const support = { ...DEFAULT_SUPPORT };
  /** Rates over seeds; also checks the carry force is exactly zero on every step an athlete touches another. */
  async function rates(a: Side, b: Side, n: number, seconds = 2) {
    let aDown = 0, bDown = 0, instabilities = 0, violations = 0, contactSteps = 0, carriedBefore = 0;
    for (let seed = 1; seed <= n; seed++) {
      // carryForce read before a step is the force applied in the previous one, which saw the previous contact state
      const prev = [false, false];
      const r = await collide(a, b, seed, STD, seconds, {
        support,
        onStep: (w) => w.athletes.forEach((x, k) => {
          const pushed = x.carryForce.some((f) => f !== 0);
          if (prev[k]) { contactSteps++; if (pushed) violations++; } else if (pushed) carriedBefore++;
          prev[k] = x.playerContact;
        }),
      });
      aDown += +r.aDown; bDown += +r.bDown; instabilities += r.instabilities;
    }
    return { aDown: aDown / n, bDown: bDown / n, instabilities, violations, contactSteps, carriedBefore };
  }
  const drive = (speed: number, mass = 95): Side => ({ speed, script: technique.lowDrive, params: { ...DEFAULT_ATHLETE, mass } });
  const upright = (speed: number, mass = 95): Side => ({ speed, script: technique.upright, params: { ...DEFAULT_ATHLETE, mass } });

  it('carry is exactly zero during player contact; a hitter driving through stays up more than the slower athlete hit', async () => {
    const r = await rates(drive(8), upright(4), 12);
    console.log('drive 8 m/s vs upright 4 m/s', r);
    expect(r.contactSteps).toBeGreaterThan(0);
    expect(r.carriedBefore).toBeGreaterThan(0);
    expect(r.violations).toBe(0);
    expect(r.instabilities).toBe(0);
    expect(r.bDown).toBeGreaterThanOrEqual(0.3);
    expect(r.aDown).toBeLessThan(r.bDown);
  });
  it('rates move with speed: a faster hit downs the athlete hit more often', async () => {
    const slow = await rates(drive(3), upright(4), 10), fast = await rates(drive(9), upright(4), 10);
    console.log('B down: hitter at 3 m/s', slow.bDown, 'at 9 m/s', fast.bDown);
    expect(fast.bDown).toBeGreaterThan(slow.bDown + 0.2);
    expect(slow.instabilities + fast.instabilities).toBe(0);
  });
  it('rates move with mass: a light athlete is downed more often than a heavy one by the same hit', async () => {
    const light = await rates(drive(5), upright(3, 65), 12), heavy = await rates(drive(5), upright(3, 130), 12);
    console.log('B down: 65 kg', light.bDown, '130 kg', heavy.bDown);
    expect(light.bDown).toBeGreaterThan(heavy.bDown + 0.3);
    expect(light.instabilities + heavy.instabilities).toBe(0);
  });
});

describe('support state', () => {
  it('posture is zero while down and the carry returns once a hitter has separated with stable footing', async () => {
    let downNoPosture = true, carryBack = false;
    for (let seed = 1; seed <= 4; seed++) {
      await collide({ speed: 8, script: technique.lowDrive }, { speed: 4, script: technique.upright }, seed, STD, 3, {
        support: { ...DEFAULT_SUPPORT },
        onStep: (w) => {
          for (const a of w.athletes) if (a.downBy && a.support.posture !== 0) downNoPosture = false;
          if (w.time > 2.5 && !w.athletes[0].downBy && w.athletes[0].support.carry > 0.9) carryBack = true;
        },
      });
    }
    expect(downNoPosture).toBe(true);
    expect(carryBack).toBe(true);
  });
  it('posture is zero while down and ramps back in over ~1 s once the animator reports the get-up', async () => {
    const w = await World.create(mujocoEngine, supportRunScenario(STD, null).setup);
    const a = w.athletes[0], update = (w as unknown as { updateSupport(a: unknown, dt: number): void }).updateSupport.bind(w);
    w.step();
    let clip = 'idle';
    a.controller.debug = () => ({ clip });
    a.downBy = 'thorax';
    update(a, w.dt);
    expect(a.support.posture).toBe(0);
    expect(a.support.down).toBe(true);
    clip = 'getup';
    for (let i = 0; i < Math.round(0.5 / w.dt); i++) update(a, w.dt);
    expect(a.support.posture).toBeGreaterThan(0.4);
    expect(a.support.posture).toBeLessThan(0.6);
    for (let i = 0; i < Math.round(0.6 / w.dt); i++) update(a, w.dt);
    expect(a.support.posture).toBe(1);
    w.destroy();
  });
  it.each([[0.2, 0], [0, 0.2]])('upright torque restores a tilted pelvis (tilt about x %s rad, about z %s rad)', async (ax, az) => {
    const w = await World.create(mujocoEngine, supportRunScenario(STD, null).setup);
    const a = w.athletes[0], s = w.scene.athletes[0].state, pi = a.segIndex.get('pelvis')!;
    w.step(); // the controller writes its first root target
    const th = Math.hypot(ax, az), n = [ax / th, 0, az / th];
    s.segQuat.set([n[0] * Math.sin(th / 2), 0, n[2] * Math.sin(th / 2), Math.cos(th / 2)], 4 * pi);
    s.segAngVel.fill(0);
    const torques: number[][] = [];
    w.scene.applyWrench = (_ai: number, seg: number, _f: number[], t: number[]) => { if (seg === pi) torques.push(t); };
    (w as unknown as { applySupport(a: unknown): void }).applySupport(a);
    const t = torques.find((x) => x.some((v) => v !== 0))!;
    expect(t[0] * ax + t[2] * az).toBeLessThan(0);
    w.destroy();
  });
  it('carrier versus tackler runs stably and the tackler makes contact', async () => {
    const sc = carrierVsTacklerScenario(STD, { seed: 3 });
    const w = await World.create(mujocoEngine, sc.setup);
    let contact = false, top = 0;
    for (let i = 0, n = Math.round(sc.duration / w.dt); i < n; i++) {
      w.step();
      contact ||= w.lastHitForce > 0;
      top = Math.max(top, metrics(w, 1).speed);
    }
    console.log('carrier vs tackler: tackler top speed', top.toFixed(1), 'peak force', w.impact.peakForce.toFixed(0), 'down', w.athletes.map((a) => a.downBy));
    expect(contact).toBe(true);
    expect(top).toBeGreaterThan(7);
    expect(w.scene.stats().instabilities).toBe(0);
    w.destroy();
  });
});
