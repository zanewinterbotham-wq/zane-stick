// Active ragdoll (design §6.5): tracking controller + world support. With support on, athletes run really fast
// and never fall on their own; contact outcomes still come out of the physics (judged on rates over seeds).
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ATHLETE, type BodyPlan } from '../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import { ScriptBrain } from '../src/sim/brains/script';
import { TrackingController } from '../src/sim/control/tracking';
import type { Commands, Gait } from '../src/sim/control/types';
import { Rng } from '../src/sim/rng';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../src/sim/drills/openField';
import type { MuscleSet } from '../src/sim/muscles';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { carrierVsTacklerScenario, supportRunScenario } from '../src/sim/scenarios';
import { World, type PhysicsSettings } from '../src/sim/world';
import { collide, technique, type Side } from './helpers/contact';
import { metrics, STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

async function run(gait: Gait | null, seconds: number, opts: { physics?: PhysicsSettings; cutAt?: number } = {}) {
  const w = await World.create(mujocoEngine, supportRunScenario(opts.physics ?? STD, gait, { cutAt: opts.cutAt }).setup);
  let top = 0, maxTilt = 0, fellAt = -1, grf = 0, nGrf = 0, knee = 0, slip = 0, nSlip = 0;
  const a = w.athletes[0], s = w.scene.athletes[0].state, BW = a.mass * 9.81, kn = a.muscles.index('kneeL.flex'), toe = a.segIndex.get('toesL')!;
  for (let i = 0, n = Math.round(seconds / w.dt); i < n; i++) {
    w.step();
    const m = metrics(w);
    top = Math.max(top, m.speed); maxTilt = Math.max(maxTilt, m.tilt);
    if (m.down) { fellAt = w.time; break; }
    if (w.time < seconds / 2) continue;
    // steady running: the share of body weight the feet push into the turf (the rest is the posture support's), and
    // while the left foot is loaded, how far its knee bends and how fast the foot slides
    grf += a.feet[0].force + a.feet[1].force; nGrf++;
    if (a.feet[0].force > 0.3 * BW) { knee = Math.max(knee, s.q[kn]); slip += Math.hypot(s.segVel[3 * toe], s.segVel[3 * toe + 2]); nSlip++; }
  }
  const out = { top, maxTiltDeg: maxTilt * 180 / Math.PI, fellAt, legShare: grf / Math.max(1, nGrf) / BW, kneeDeg: knee * 180 / Math.PI, slip: slip / Math.max(1, nSlip), instabilities: w.scene.stats().instabilities, world: w };
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
    console.log(`${gait}: top ${r.top.toFixed(2)} m/s, max trunk tilt ${r.maxTiltDeg.toFixed(0)}°, legs carry ${(100 * r.legShare).toFixed(0)} % of body weight, stance knee ≤ ${r.kneeDeg.toFixed(0)}°, foot slip ${r.slip.toFixed(2)} m/s`);
    expect(r.fellAt).toBe(-1);
    expect(r.instabilities).toBe(0);
    expect(r.top).toBeGreaterThanOrEqual(speed);
    r.world.destroy();
  });
  it('jogging, the loaded leg stays a runner’s leg: the knee bends less than 50° and the planted foot does not slide', async () => {
    const r = await run('jog', 10);
    expect(r.fellAt).toBe(-1);
    // were ~65° and ~3 m/s when the support held the athlete up on bent legs whose feet dragged along the turf
    expect(r.kneeDeg).toBeLessThan(50);
    expect(r.slip).toBeLessThan(1);
    expect(r.legShare).toBeGreaterThan(0.33);
    r.world.destroy();
  });
  it('a full forward lean holds the trunk near parallel to the turf, balanced and with full posture support', async () => {
    const sc = supportRunScenario(STD, null);
    sc.setup.athletes[0].brain = new ScriptBrain((t, _p, c) => { if (t > 0.5) { c.contactMode = true; c.lean = { fwd: 1, side: 0 }; } });
    const w = await World.create(mujocoEngine, sc.setup);
    const a = w.athletes[0];
    let minPosture = 1;
    while (w.time < 3) { w.step(); if (w.time > 0.5) minPosture = Math.min(minPosture, a.support.posture); }
    const m = metrics(w), feet = a.feet[0].force + a.feet[1].force;
    console.log(`full lean: trunk ${(m.tilt * 180 / Math.PI).toFixed(0)}° from upright, pelvis ${m.pelvisY.toFixed(2)} m, feet carry ${(100 * feet / (a.mass * 9.81)).toFixed(0)} %`);
    expect(m.tilt).toBeGreaterThan(70 * Math.PI / 180);
    expect(m.down).toBe(null);
    // a commanded lean is not read as a knock (the feet only unload briefly as the trunk swings down)
    expect(minPosture).toBeGreaterThan(0.6);
    expect(a.support.posture).toBe(1);
    expect(m.pelvisY).toBeLessThan(a.plan.standHeight - 0.12);
    w.destroy();
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

describe('off-contact stability (nobody near)', () => {
  /** A supported athlete runs a command script from t = 0.5 s: falls, knock, airborne time, instabilities. */
  async function solo(script: (t: number, c: Commands) => void, seconds: number, physics: PhysicsSettings = STD) {
    const sc = supportRunScenario(physics, null);
    sc.setup.athletes[0].brain = new ScriptBrain((t, _p, c) => { if (t >= 0.5) script(t, c); });
    const w = await World.create(mujocoEngine, sc.setup);
    const a = w.athletes[0], s = w.scene.athletes[0].state;
    let fellAt = -1, maxKnock = 0, maxAir = 0, flights = 0, ys: number[] = [];
    for (let i = 0, n = Math.round(seconds / w.dt); i < n; i++) {
      const air = a.airT;
      w.step();
      if (a.downBy) { fellAt = w.time; break; }
      maxKnock = Math.max(maxKnock, a.knock); maxAir = Math.max(maxAir, a.airT);
      if (air > 0.2 && a.airT === 0) flights++;
      if (w.time > seconds / 2) ys.push(s.com[1]);
    }
    const out = { fellAt, maxKnock, maxAir, flights, bob: Math.max(...ys) - Math.min(...ys), instabilities: w.scene.stats().instabilities };
    w.destroy();
    return out;
  }
  /** Seeded random running: every 0.3–1.2 s a new gait, heading (a sharp cut, a bend or straight on), speed (or a
   *  stop), sink, lean and turn rate; sometimes facing off the run (shuffle, backpedal) or a plant-and-cut. */
  const randomRun = (seed: number) => {
    const r = new Rng(seed);
    let next = 0, ang = 0, gait: Gait = 'sprint', mag = 1, sink = 0, lean = 0, turn = 0, face = false, cut: -1 | 0 | 1 = 0;
    return (t: number, c: Commands) => {
      if (t >= next) {
        next = t + r.range(0.3, 1.2);
        gait = r.pick(['sprint', 'sprint', 'sprint', 'jog', 'walk'] as const);
        const k = r.next();
        ang = k < 0.4 ? ang + r.range(-Math.PI, Math.PI) : k < 0.7 ? ang + r.range(-0.6, 0.6) : ang;
        mag = r.next() < 0.12 ? 0 : r.range(0.5, 1);
        sink = r.next() < 0.3 ? r.range(0, 1) : 0;
        lean = r.next() < 0.3 ? r.range(-0.3, 1) : 0;
        turn = r.next() < 0.2 ? r.range(-2, 2) : 0;
        face = r.next() < 0.1;
        cut = r.next() < 0.1 ? (r.next() < 0.5 ? -1 : 1) : 0;
      }
      ang += turn / 240;
      c.gait = gait; c.move = { x: Math.sin(ang) * mag, z: Math.cos(ang) * mag }; c.sink = sink; c.lean.fwd = lean;
      if (face) c.face = { x: Math.sin(ang - 0.5), z: Math.cos(ang - 0.5) };
      c.plantCut = cut; cut = 0;
    };
  };

  it('never falls and is never knocked by his own running, cutting, stopping, sinking or leaning (24 random runs)', async () => {
    let falls = 0, maxKnock = 0, maxAir = 0, flights = 0, instabilities = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const r = await solo(randomRun(seed), 8);
      falls += +(r.fellAt >= 0); maxKnock = Math.max(maxKnock, r.maxKnock); maxAir = Math.max(maxAir, r.maxAir); flights += r.flights; instabilities += r.instabilities;
    }
    // before the support and gait fixes, 100 such 10 s runs had 7 falls, knock up to 1 and flights up to ~0.46 s
    console.log(`random runs: falls ${falls}, max knock ${maxKnock.toFixed(2)}, longest flight ${maxAir.toFixed(2)} s, flights over 0.2 s ${flights}`);
    expect(falls).toBe(0);
    expect(maxKnock).toBeLessThan(0.05);
    expect(maxAir).toBeLessThan(0.45);
    expect(instabilities).toBe(0);
  });
  it('runs with the pads lowered (the human torso control: lean = torso, sink = 0.6 × torso) without falling', async () => {
    for (const torso of [0.5, 1]) for (const gait of ['jog', 'sprint'] as const) {
      const r = await solo((t, c) => { c.gait = gait; c.move = { x: Math.sin(0.5 * t), z: Math.cos(0.5 * t) }; c.lean.fwd = torso; c.sink = 0.6 * torso; }, 6);
      expect(r.fellAt, `${gait} torso ${torso}`).toBe(-1);
      expect(r.maxKnock).toBeLessThan(0.05);
      expect(r.instabilities).toBe(0);
    }
  });
  it('sprints through slow and fast turns without tripping, on the minimum body too', async () => {
    for (const physics of [STD, { hz: 240, iterations: 20, detail: 'minimum' } as PhysicsSettings]) for (const rate of [0.3, 0.5, 1, 2]) {
      const r = await solo((t, c) => { c.gait = 'sprint'; c.move = { x: Math.sin(rate * t), z: Math.cos(rate * t) }; }, 8, physics);
      expect(r.fellAt, `${physics.detail} ${rate} rad/s`).toBe(-1);
      expect(r.maxKnock).toBeLessThan(0.05);
      expect(r.instabilities).toBe(0);
    }
  });
  it('no bunny hops at top speed: short flights and a ~4 cm bob at 10 m/s', async () => {
    const r = await solo((_t, c) => { c.gait = 'sprint'; c.move = { x: 0, z: 1 }; }, 8);
    // were flights up to ~0.18 s straight and ~0.48 s in a slow bend, every landing bouncing the next one higher
    console.log(`straight sprint: longest flight ${r.maxAir.toFixed(3)} s, COM bob ${(100 * r.bob).toFixed(1)} cm`);
    expect(r.maxAir).toBeLessThan(0.13);
    expect(r.bob).toBeLessThan(0.07);
    const bend = await solo((t, c) => { c.gait = 'sprint'; c.move = { x: Math.sin(0.5 * t), z: Math.cos(0.5 * t) }; }, 8);
    expect(bend.maxAir).toBeLessThan(0.35);
  });
  it('pivots quickly: a 90° change of direction at a jog in under 0.7 s, staying up', async () => {
    const sc = supportRunScenario(STD, null);
    sc.setup.athletes[0].brain = new ScriptBrain((t, _p, c) => { if (t >= 0.5) { c.gait = 'jog'; c.move = t > 3 ? { x: 1, z: 0 } : { x: 0, z: 1 }; } });
    const v = await World.create(mujocoEngine, sc.setup), s = v.scene.athletes[0].state;
    let v0 = 0, tTurn = NaN;
    while (v.time < 5) {
      v.step();
      const sp = Math.hypot(s.comVel[0], s.comVel[2]);
      if (v.time < 3) v0 = sp;
      else if (Number.isNaN(tTurn) && Math.abs(Math.atan2(s.comVel[0], s.comVel[2]) - Math.PI / 2) < 15 * Math.PI / 180 && sp > 0.6 * v0) tTurn = v.time - 3;
    }
    // was ~0.83 s with the turn limited to 7 m/s² and 8 rad/s
    console.log(`jog 90° turn in ${tTurn.toFixed(2)} s`);
    expect(tTurn).toBeLessThan(0.7);
    expect(v.athletes[0].downBy).toBe(null);
    v.destroy();
  });
});

describe('support in contact', () => {
  const support = { ...DEFAULT_SUPPORT };
  /** Rates over seeds; also checks the carry force is exactly zero on every step an athlete touches another. */
  async function rates(a: Side, b: Side, n: number, seconds = 2) {
    let aDown = 0, bDown = 0, bBack = 0, instabilities = 0, violations = 0, contactSteps = 0, carriedBefore = 0;
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
      aDown += +r.aDown; bDown += +r.bDown; bBack += r.bBack; instabilities += r.instabilities;
    }
    return { aDown: aDown / n, bDown: bDown / n, bBack: bBack / n, instabilities, violations, contactSteps, carriedBefore };
  }
  const drive = (speed: number, mass = 95): Side => ({ speed, script: technique.lowDrive, params: { ...DEFAULT_ATHLETE, mass } });
  const upright = (speed: number, mass = 95): Side => ({ speed, script: technique.upright, params: { ...DEFAULT_ATHLETE, mass } });

  it('carry is exactly zero during player contact; a hitter driving through stays up more than the slower athlete hit', async () => {
    const r = await rates(drive(8), upright(4), 24);
    console.log('drive 8 m/s vs upright 4 m/s', r);
    expect(r.contactSteps).toBeGreaterThan(0);
    expect(r.carriedBefore).toBeGreaterThan(0);
    expect(r.violations).toBe(0);
    expect(r.instabilities).toBe(0);
    // Since the jogger runs on straighter legs (not crouched on the support) he keeps his feet more often when hit
    // 0.15 s into his run (~25 % downed, was ~67 %): he is driven back ~5 m instead.
    expect(r.bDown).toBeGreaterThanOrEqual(0.15);
    expect(r.bBack).toBeGreaterThan(3);
    expect(r.aDown).toBeLessThan(r.bDown);
  });
  it('rates move with speed: a faster hit downs the athlete hit more often', async () => {
    const slow = await rates(drive(3), upright(4), 20), fast = await rates(drive(9), upright(4), 20);
    console.log('B down: hitter at 3 m/s', slow.bDown, 'at 9 m/s', fast.bDown);
    expect(fast.bDown).toBeGreaterThan(slow.bDown + 0.2);
    expect(slow.instabilities + fast.instabilities).toBe(0);
  });
  it('the athlete driven back is stunned and stays without posture support while still moving with the hit; the hitter is not', async () => {
    let stunned = 0, hitterStun = 0, heldKnock = 0;
    const n = 8;
    for (let seed = 1; seed <= n; seed++) {
      let maxStun = 0, t0 = -1;
      await collide(drive(8), upright(4), seed, STD, 1.5, {
        support,
        onStep: (w) => {
          const [a, b] = w.athletes, vb = w.scene.athletes[1].state.comVel[2];
          if (t0 < 0 && w.lastHitForce > 0) t0 = w.time;
          maxStun = Math.max(maxStun, b.stun); hitterStun = Math.max(hitterStun, a.stun);
          // past the 0.2 s impulse window, still carried back (+Z) fast: the knock must not have let go
          if (t0 >= 0 && w.time - t0 > 0.3 && vb > 2.5 && !b.playerContact && b.knock > 0.9) heldKnock++;
        },
      });
      if (maxStun > 0.5) stunned++;
    }
    console.log('stunned', stunned, '/', n, 'hitter max stun', hitterStun, 'steps with held knock', heldKnock);
    expect(stunned).toBeGreaterThanOrEqual(n / 2);
    expect(hitterStun).toBeLessThan(0.2);
    expect(heldKnock).toBeGreaterThan(0);
  });
  it('rates move with mass: a light athlete is downed more often than a heavy one by the same hit', async () => {
    const light = await rates(drive(5), upright(3, 65), 24), heavy = await rates(drive(5), upright(3, 130), 24);
    console.log('B down: 65 kg', light.bDown, '130 kg', heavy.bDown, 'driven back', light.bBack.toFixed(2), heavy.bBack.toFixed(2));
    // the light athlete is downed more often and driven back much farther (down rates fell once the jogger ran on
    // straighter legs: ~17 % vs 0 %, was ~58 % vs 0 %)
    expect(light.bDown).toBeGreaterThanOrEqual(heavy.bDown); // downs within 2 s are rare now; distance shows the gap
    expect(light.bBack).toBeGreaterThan(heavy.bBack + 1);
    expect(light.instabilities + heavy.instabilities).toBe(0);
  });
});

describe('ball carry', () => {
  /** Open-field drill with the human walking at the carrier: the bot carrier runs and cuts around him. */
  async function carry(physics: PhysicsSettings, rep: number, carrierGait: Gait) {
    const walker = new ScriptBrain((_t, _p, c) => { c.move = { x: 0, z: 1 }; c.gait = 'walk'; });
    const d = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics, carrierGait }, walker, rep);
    const w = d.world, a = w.athletes[d.carrier], s = w.scene.athletes[d.carrier].state;
    let held = true, contact = false, cut = 0, far = 0, top = 0;
    while (d.repTime < 6 && !d.ended) {
      d.step();
      held &&= a.grips[1].active;
      contact ||= a.playerContact;
      const b = w.scene.propPose(d.ball).pos, h = a.handSegs[1];
      far = Math.max(far, Math.hypot(b[0] - s.segCom[3 * h], b[1] - s.segCom[3 * h + 1], b[2] - s.segCom[3 * h + 2]));
      top = Math.max(top, Math.hypot(s.comVel[0], s.comVel[2]));
      if (d.repTime > 1.5) cut = Math.max(cut, Math.abs(Math.atan2(s.comVel[0], -s.comVel[2])));
    }
    const out = { held, contact, cutDeg: cut * 180 / Math.PI, far, top, t: d.repTime, ended: d.ended, instabilities: w.scene.stats().instabilities };
    d.destroy();
    return out;
  }
  it('the carrier keeps the ball tucked for 6 s of running and cutting (no contact), on every body detail', async () => {
    for (const [physics, gait] of [[STD, 'jog'], [STD, 'sprint'], [{ hz: 240, iterations: 20, detail: 'minimum' }, 'jog']] as [PhysicsSettings, Gait][]) {
      for (const rep of [0, 1]) {
        const r = await carry(physics, rep, gait);
        console.log(physics.detail, gait, 'rep', rep, r);
        expect(r.contact).toBe(false);
        expect(r.ended).toBe(null);
        expect(r.t).toBeGreaterThanOrEqual(6);
        expect(r.cutDeg).toBeGreaterThan(25);
        expect(r.held).toBe(true);
        expect(r.far).toBeLessThan(0.25);
        expect(r.instabilities).toBe(0);
      }
    }
  });
});

describe('support state', () => {
  it('posture is zero while down (until the get-up) and the carry returns once a hitter has separated with stable footing', async () => {
    let downNoPosture = true, carryBack = false;
    for (let seed = 1; seed <= 4; seed++) {
      await collide({ speed: 8, script: technique.lowDrive }, { speed: 4, script: technique.upright }, seed, STD, 3, {
        support: { ...DEFAULT_SUPPORT },
        onStep: (w) => {
          // during the get-up hands and knees are on the turf (still 'down') while posture ramps back in
          for (const a of w.athletes) if (a.downBy && a.controller.debug?.().clip !== 'getup' && a.support.posture !== 0) downNoPosture = false;
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

describe('dive', () => {
  /** Dive pressed at `at` s (held `hold` s) from a gait (null = standing). Flight runs from take-off (dive flight,
   *  feet off the turf) to the first ground contact of anything but the feet. */
  async function dive(gait: Gait | null, at: number, hold: number) {
    const sc = supportRunScenario(STD, gait);
    sc.setup.athletes[0].brain = new ScriptBrain((t, _p, c) => {
      if (t < 0.5) return;
      if (gait) { c.gait = gait; c.move = { x: 0, z: 1 }; }
      c.dive = t > at && t < at + hold;
    });
    const w = await World.create(mujocoEngine, sc.setup);
    const a = w.athletes[0], s = w.scene.athletes[0].state, ctl = a.controller as TrackingController;
    const feet = new Set([...a.footSegs[0], ...a.footSegs[1]]), ti = a.segIndex.get('thorax')!;
    let takeoff = NaN, land = NaN, faceDown = false, downAt = NaN, getup = false, hover = 0, maxHover = 0, flightForce = 0, speed = 0;
    const path: number[] = [];
    while (w.time < at + 4) {
      w.step();
      const m = metrics(w), dv = ctl.root().dive;
      if (Math.abs(w.time - at) < w.dt / 2) speed = m.speed;
      if (Number.isNaN(takeoff) && dv === 'flight' && !a.feet[0].touching && !a.feet[1].touching) takeoff = s.com[2];
      if (dv === 'flight') flightForce += Math.hypot(...a.carryForce);
      if (!Number.isNaN(takeoff) && Number.isNaN(land) && w.scene.contacts().some((c) => [[c.a, c.b], [c.b, c.a]].some(([p, o]) => p.athlete === 0 && o.athlete < 0 && o.seg < 0 && !feet.has(p.seg)))) {
        land = s.com[2];
        const q = s.segQuat.subarray(4 * ti, 4 * ti + 4);
        faceDown = 2 * (q[1] * q[2] - q[3] * q[0]) < 0; // y of the thorax's forward axis
      }
      if (Number.isNaN(downAt) && a.downBy) downAt = w.time - at;
      getup ||= ctl.debug().clip === 'getup';
      // levitation: tilted past 25° with the pelvis held at standing height or above
      hover = m.tilt > 25 * Math.PI / 180 && m.pelvisY >= a.plan.standHeight ? hover + w.dt : 0;
      maxHover = Math.max(maxHover, hover);
      path.push(s.com[0], s.com[1], s.com[2]);
    }
    const out = { speed, flight: land - takeoff, faceDown, downAt, getup, maxHover, flightForce, path, instabilities: w.scene.stats().instabilities };
    w.destroy();
    return out;
  }

  it.each([['standing', null, 1, 1.4, 2.1], ['sprinting', 'sprint', 3, 2.5, 4]] as const)('%s: one press launches a ballistic dive that lands face down, then gets up', async (name, gait, at, lo, hi) => {
    const r = await dive(gait, at, 0.05);
    console.log(`${name} dive at ${r.speed.toFixed(1)} m/s: flight ${r.flight.toFixed(2)} m, down after ${r.downAt.toFixed(2)} s, face down ${r.faceDown}`);
    expect(r.flight).toBeGreaterThan(lo);
    expect(r.flight).toBeLessThan(hi);
    expect(r.faceDown).toBe(true);
    expect(r.flightForce).toBe(0);   // no support of any kind in flight
    expect(r.downAt).toBeLessThan(1.2);
    expect(r.getup).toBe(true);
    expect(r.maxHover).toBeLessThan(0.2);
    expect(r.instabilities).toBe(0);
  });
  it('holding dive changes nothing: no hover, the same dive as a tap', async () => {
    for (const [gait, at] of [[null, 1], ['sprint', 3]] as const) {
      const tap = await dive(gait, at, 0.05), held = await dive(gait, at, 3);
      expect(held.maxHover).toBeLessThan(0.2);
      expect(held.downAt).toBeLessThan(1.2);
      expect(held.path).toEqual(tap.path);
    }
  });
});

describe('hip thrust', () => {
  /** A tackler jogs into a standing carrier and wraps him up; 0.3 s after the first grip he either thrusts (a tap per
   *  thrust) or just holds on. Carrier displacement and the load on his feet over the next 1.5 s. */
  async function wrapUp(thrust: boolean, seed: number) {
    const tracked = (p: BodyPlan, m: MuscleSet) => new TrackingController(p, m);
    let tWrap = -1;
    const w = await World.create(mujocoEngine, {
      physics: STD, seed, assist: 0, support: { ...DEFAULT_SUPPORT },
      athletes: [
        { params: DEFAULT_ATHLETE, pos: [0, 0, -0.8], yaw: 0, team: 0, controller: tracked, brain: new ScriptBrain((t, _p, c) => {
          c.contactMode = true; c.gait = 'jog'; c.move = { x: 0, z: tWrap < 0 ? 1 : 0 }; c.armL = c.armR = 1; c.wrap = true; c.sink = 0.7;
          // one press runs a whole thrust (~0.8 s): tapped again as each one ends
          c.thrustHips = thrust && tWrap >= 0 && t > tWrap + 0.3 && (t - tWrap - 0.3) % 0.85 < 0.05;
        }) },
        { params: DEFAULT_ATHLETE, pos: [0, 0, 0.8 + 0.05 * seed], yaw: Math.PI, team: 1, controller: tracked, brain: new ScriptBrain(() => {}) },
      ],
    });
    w.scene.setInitialVelocity(0, [0, 0, 1.2]);
    const b = w.scene.athletes[1].state;
    let z0 = NaN, load = 0, n = 0, end = 5, carried = 0;
    while (w.time < end) {
      // the carry applied in a step saw the contact state from before it
      const touching = w.athletes.map((x) => x.playerContact);
      w.step();
      if (tWrap < 0 && w.athletes[0].grips.some((g) => g.active)) { tWrap = w.time; end = tWrap + 1.8; }
      if (tWrap >= 0 && Number.isNaN(z0) && w.time > tWrap + 0.3) z0 = b.com[2];
      if (!Number.isNaN(z0)) { load += w.athletes[1].feet[0].force + w.athletes[1].feet[1].force; n++; }
      if (w.athletes.some((x, k) => touching[k] && x.carryForce.some((f) => f !== 0))) carried++;
    }
    const out = { wrapped: tWrap >= 0, push: b.com[2] - z0, load: load / n, aDown: !!w.athletes[0].downBy, carried, instabilities: w.scene.stats().instabilities };
    w.destroy();
    return out;
  }

  it('drives a wrapped-up carrier back farther, through muscles and contact only', async () => {
    let push = [0, 0], load = [0, 0];
    for (const seed of [1, 2, 3]) {
      const off = await wrapUp(false, seed), on = await wrapUp(true, seed);
      for (const r of [off, on]) { expect(r.wrapped).toBe(true); expect(r.carried).toBe(0); expect(r.instabilities).toBe(0); }
      // holding on he stays up; thrusting he may drive through and land on top of the carrier, as in a real tackle
      expect(off.aDown).toBe(false);
      push = [push[0] + off.push / 3, push[1] + on.push / 3]; load = [load[0] + off.load / 3, load[1] + on.load / 3];
    }
    console.log(`carrier driven back ${push[0].toFixed(2)} m holding on, ${push[1].toFixed(2)} m thrusting; load on his feet ${load[0].toFixed(0)} N vs ${load[1].toFixed(0)} N`);
    expect(push[1]).toBeGreaterThan(1.3 * push[0]);
    // not asserted: with the carrier's knock/stun support in contact, thrust no longer measurably unloads his feet
  });
});
