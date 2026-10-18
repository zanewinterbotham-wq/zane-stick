// Injuries (owner decision 2026-10-18, design §6.6): joints break under limit loads beyond tolerance, big head blows
// knock out, and either keeps the athlete down for the rep. Same rules for every athlete; physics decides.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ATHLETE } from '../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import { ScriptBrain } from '../src/sim/brains/script';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../src/sim/drills/openField';
import { BREAK } from '../src/sim/injury';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { supportRunScenario } from '../src/sim/scenarios';
import { World } from '../src/sim/world';
import { collide, technique } from './helpers/contact';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

/** A standing athlete (tracking controller, world support), with `engaged` an opponent standing chest to chest with
 *  him, and a force on one segment (at its proximal joint, or with `atCom` its centre of mass) for `dur` s from t = 1 s. */
async function blow(seg: string, force: [number, number, number], dur: number, seconds: number, o: { engaged?: boolean; atCom?: boolean }, onStep?: (w: World) => void) {
  const setup = supportRunScenario(STD, null).setup;
  if (o.engaged) setup.athletes.push({ ...setup.athletes[0], pos: [0, 0, 0.45], yaw: Math.PI, team: 1 });
  const w = await World.create(mujocoEngine, setup);
  const k = w.athletes[0].segIndex.get(seg)!, s = w.scene.athletes[0].state;
  let touched = false;
  for (let i = 0, n = Math.round(seconds / w.dt); i < n; i++) {
    if (w.time >= 1 && w.time < 1 + dur) {
      touched ||= w.athletes[0].playerContact;
      const r = [0, 1, 2].map((j) => o.atCom ? 0 : s.segPos[3 * k + j] - s.segCom[3 * k + j]), F = force;
      w.scene.applyWrench(0, k, F, [r[1] * F[2] - r[2] * F[1], r[2] * F[0] - r[0] * F[2], r[0] * F[1] - r[1] * F[0]]);
    }
    w.step();
    onStep?.(w);
  }
  expect(touched).toBe(!!o.engaged);
  return w;
}

describe('limb breaks', () => {
  it('the knee of an engaged athlete driven backward (200 N·s at the joint) hyper-extends and breaks: limp, dangling, down', async () => {
    let clipAfter = '', maxPelvis = 0, kneeTorque = 0, minKnee = 0;
    const w = await blow('shankL', [0, 0, -4000], 0.05, 5, { engaged: true }, (w) => {
      const a = w.athletes[0];
      minKnee = Math.min(minKnee, w.scene.athletes[0].state.q[a.muscles.index('kneeL.flex')]);
      if (w.time < 2.5) return;
      clipAfter = String(a.controller.debug?.().clip);
      maxPelvis = Math.max(maxPelvis, w.scene.athletes[0].state.segPos[3 * a.segIndex.get('pelvis')! + 1]);
      kneeTorque = Math.max(kneeTorque, Math.abs(a.muscles.torque[a.muscles.index('kneeL.flex')]));
    });
    const a = w.athletes[0], ki = a.muscles.index('kneeL.flex');
    console.log('knee blow:', w.injuries.map((e) => `${e.joint} ${e.what} ${e.load.toFixed(0)} N·m at ${e.time.toFixed(3)} s`), `knee hyper-extended to ${(-minKnee * 180 / Math.PI).toFixed(0)}°`);
    expect(w.injuries.filter((e) => e.kind === 'break').map((e) => e.joint)).toContain('kneeL');
    const e = w.injuries.find((x) => x.joint === 'kneeL')!;
    expect(e).toMatchObject({ athlete: 0, what: 'knee', seg: 'shankL', parentSeg: 'thighL' });
    expect(e.load).toBeGreaterThan(BREAK['knee.flex'].torque);
    expect(a.injury.out).toBe(true);
    expect(kneeTorque).toBe(0);                       // the broken knee's muscles give nothing
    expect(minKnee).toBeLessThan(a.muscles.lo[ki] - 0.3); // and it bends well past where it used to stop
    expect(clipAfter).toBe('down');                   // no get-up
    expect(maxPelvis).toBeLessThan(0.6);              // he stays on the turf
    expect(w.scene.stats().instabilities).toBe(0);
    w.destroy();
  });

  it('ordinary tackles break nothing and knock nobody out', async () => {
    const found: string[] = [];
    let instabilities = 0;
    for (let rep = 0; rep < 3; rep++) {
      const chaser = new ScriptBrain((_t, p, c) => {
        const me = p.athletes[p.self], b = p.athletes[1 - p.self], dx = b.com[0] - me.com[0], dz = b.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1;
        if (me.down) return;
        c.gait = 'sprint'; c.move = { x: dx / d, z: dz / d };
        if (d < 2.5) { c.contactMode = true; c.armL = c.armR = 1; c.gripL = c.gripR = true; c.wrap = d < 1.4; c.sink = 0.5; c.driveLegs = 1; }
      });
      const dr = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD, timeLimit: 8 }, chaser, rep);
      while (!dr.ended) dr.step();
      for (let i = 0; i < 240; i++) dr.step();
      found.push(...dr.world.injuries.map((e) => `drill rep ${rep}: ${e.joint}`));
      instabilities += dr.world.scene.stats().instabilities;
      dr.destroy();
    }
    for (let seed = 1; seed <= 3; seed++) {
      await collide({ speed: 6, script: technique.wrapLow }, { speed: 6, script: technique.carry }, seed, STD, 2.5, {
        support: { ...DEFAULT_SUPPORT }, onStep: (w) => { if (w.injuries.length && !found.some((f) => f.startsWith(`wrap ${seed}`))) found.push(`wrap ${seed}: ${w.injuries[0].joint}`); },
      });
      await collide({ speed: 8, script: technique.lowDrive, params: { ...DEFAULT_ATHLETE, mass: 95 } }, { speed: 4, script: technique.upright }, seed, STD, 2.5, {
        support: { ...DEFAULT_SUPPORT }, onStep: (w) => { if (w.injuries.length && !found.some((f) => f.startsWith(`drive ${seed}`))) found.push(`drive ${seed}: ${w.injuries[0].joint}`); },
      });
    }
    expect(found).toEqual([]);
    expect(instabilities).toBe(0);
  });
});

describe('knockout', () => {
  it('a hard blow to the head knocks him out: no get-up, no support, limp, for the rest of the rep', async () => {
    let posture = 0, getup = false, maxPelvis = 0;
    // 150 N·s on the helmet in 10 ms, from the side (a blindside shot)
    const w = await blow('head', [15000, 0, 0], 0.01, 7, { atCom: true }, (w) => {
      const a = w.athletes[0];
      if (w.time < 1.05) return;
      posture = Math.max(posture, w.view(a).support!.posture);
      getup ||= a.controller.debug?.().clip === 'getup';
      if (w.time > 3) maxPelvis = Math.max(maxPelvis, w.scene.athletes[0].state.segPos[3 * a.segIndex.get('pelvis')! + 1]);
    });
    console.log('head blow:', w.injuries.map((e) => `${e.kind} ${e.load.toFixed(1)} m/s at ${e.time.toFixed(3)} s`), `peak head dV ${w.athletes[0].injury.peakDv.toFixed(1)} m/s`);
    expect(w.injuries.map((e) => e.kind)).toContain('ko');
    expect(w.athletes[0].injury.ko).toBe(true);
    expect(posture).toBe(0);
    expect(getup).toBe(false);
    expect(maxPelvis).toBeLessThan(0.5);
    expect(w.scene.stats().instabilities).toBe(0);
    w.destroy();
  });
});

describe('brutal hits and determinism', () => {
  /** Head-on: a 110 kg hitter at 9.5 m/s low into a carrier sprinting at 9 m/s. */
  const headOn = async (seed: number, hitPower: number) => {
    const states: number[] = [];
    let injuries: string[] = [], instabilities = 0;
    await collide({ speed: 9.5, script: technique.lowDrive, params: { ...DEFAULT_ATHLETE, mass: 110 } }, { speed: 9, script: technique.carry }, seed, STD, 2, {
      support: { ...DEFAULT_SUPPORT }, hitPower,
      onStep: (w) => { for (const a of w.scene.athletes) states.push(...a.state.segPos); injuries = w.injuries.map((e) => `${e.athlete}:${e.joint}@${e.time.toFixed(4)}`); instabilities = w.scene.stats().instabilities; },
    });
    return { states, injuries, instabilities };
  };

  it('full-sprint head-on hits at hit power 2.5 injure someone most times, reproducibly', async () => {
    let injured = 0;
    const n = 4;
    for (let seed = 1; seed <= n; seed++) {
      const r = await headOn(seed, 2.5);
      injured += +(r.injuries.length > 0);
      expect(r.instabilities).toBe(0);
      if (seed === 1) {
        const again = await headOn(seed, 2.5);
        expect(again.injuries).toEqual(r.injuries);
        expect(again.states).toEqual(r.states);
      }
      console.log(`head-on sprint at hit power 2.5, seed ${seed}:`, r.injuries);
    }
    expect(injured).toBeGreaterThanOrEqual(n / 2);
  });
});
