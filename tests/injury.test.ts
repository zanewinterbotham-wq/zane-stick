// Injuries (owner decisions 2026-10-18, design §6.6): joints break under limit loads beyond tolerance (scaled by bone
// strength) and he plays on hurt, hobbling or one-armed; big head blows knock out and keep him down for the rep.
// Same rules for every athlete; physics decides.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ATHLETE } from '../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import { ScriptBrain } from '../src/sim/brains/script';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../src/sim/drills/openField';
import { BREAK, HOBBLE } from '../src/sim/injury';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { supportRunScenario } from '../src/sim/scenarios';
import { World } from '../src/sim/world';
import type { TrackingController } from '../src/sim/control/tracking';
import { SoundCues } from '../src/game/cues';
import { collide, technique } from './helpers/contact';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

/** A standing athlete (tracking controller, world support), with `engaged` an opponent standing chest to chest with
 *  him, and a force on one segment (at its proximal joint, or with `atCom` its centre of mass) for `dur` s from t = 1 s. */
async function blow(seg: string, force: [number, number, number], dur: number, seconds: number, o: { engaged?: boolean; atCom?: boolean }, onStep?: (w: World) => void) {
  const setup = supportRunScenario(STD, null).setup;
  setup.props = [{ name: 'ball', shape: 'ellipsoid', size: [0.085, 0.085, 0.14], mass: 0.4, pos: [3, 0.1, 3] }]; // for the sound cues
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
  it('the knee of an engaged athlete driven backward (200 N·s at the joint) hyper-extends and breaks: weak, dangling, still in play', async () => {
    let minPelvis = 9, minKnee = 0;
    const w = await blow('shankL', [0, 0, -4000], 0.05, 5, { engaged: true }, (w) => {
      const a = w.athletes[0];
      minKnee = Math.min(minKnee, w.scene.athletes[0].state.q[a.muscles.index('kneeL.flex')]);
      if (w.time > 2.5) minPelvis = Math.min(minPelvis, w.scene.athletes[0].state.segPos[3 * a.segIndex.get('pelvis')! + 1]);
    });
    const a = w.athletes[0], ki = a.muscles.index('kneeL.flex');
    console.log('knee blow:', w.injuries.map((e) => `${e.joint} ${e.what} ${e.load.toFixed(0)} N·m at ${e.time.toFixed(3)} s`), `knee hyper-extended to ${(-minKnee * 180 / Math.PI).toFixed(0)}°`);
    expect(w.injuries.filter((e) => e.kind === 'break').map((e) => e.joint)).toContain('kneeL');
    const e = w.injuries.find((x) => x.joint === 'kneeL')!;
    expect(e).toMatchObject({ athlete: 0, what: 'knee', seg: 'shankL', parentSeg: 'thighL' });
    expect(e.load).toBeGreaterThan(BREAK['knee.flex'].torque);
    expect(minKnee).toBeLessThan(a.muscles.lo[ki] - 0.3); // it bends well past where it used to stop
    expect(a.injury.leg).toEqual([true, false]);
    expect(a.injury.tone[ki]).toBe(HOBBLE.legTone);      // the leg's muscles weak, not gone
    expect(a.injury.out).toBe(false);                     // he plays on: this blow left him on his feet
    expect(minPelvis).toBeGreaterThan(0.85);
    expect(String(a.controller.debug?.().clip)).not.toBe('down');
    expect(w.scene.stats().instabilities).toBe(0);
    w.destroy();
  });

  it('a hit that breaks a bone puts him down as physics decides; he gets up and plays on', async () => {
    // a low drive into an upright runner at bone strength 0.3 breaks an arm or a shoulder most runs
    const rows: string[] = [];
    let hurt = 0, up = 0, instabilities = 0;
    for (let seed = 2; seed <= 5; seed++) {
      const st = [0, 1].map(() => ({ down: false, getup: false, clip: '', pelvis: 0, downNow: false }));
      let joints: string[] = [];
      const o = await collide({ speed: 8, script: technique.lowDrive, params: { ...DEFAULT_ATHLETE, mass: 95 } }, { speed: 4, script: technique.upright }, seed, STD, 8, {
        support: { ...DEFAULT_SUPPORT }, boneStrength: 0.3,
        onStep: (w) => {
          joints = w.injuries.map((e) => `${e.athlete}:${e.joint}`);
          w.athletes.forEach((a, i) => {
            const s = w.scene.athletes[i].state;
            st[i].down ||= !!a.downBy; st[i].downNow = !!a.downBy; st[i].getup ||= a.controller.debug?.().clip === 'getup';
            st[i].clip = String(a.controller.debug?.().clip); st[i].pelvis = s.segPos[3 * a.segIndex.get('pelvis')! + 1];
          });
        },
      });
      instabilities += o.instabilities;
      st.forEach((x, i) => {
        if (!joints.some((j) => j.startsWith(`${i}:`))) return;
        hurt++;
        const ok = (!x.down || x.getup) && !x.downNow && x.clip !== 'down' && x.clip !== 'getup';
        up += +ok;
        rows.push(`seed ${seed} athlete ${i} (${joints.filter((j) => j.startsWith(`${i}:`)).join(', ')}): ${x.down ? 'down, ' : ''}${x.getup ? 'got up, ' : ''}ends ${x.clip} at pelvis ${x.pelvis.toFixed(2)} m`);
      });
    }
    console.log('playing on hurt:\n' + rows.join('\n'));
    expect(hurt).toBeGreaterThanOrEqual(3);
    expect(up).toBe(hurt);
    expect(instabilities).toBe(0);
  });

  /** One athlete running at `gait` for 7 s; `joint` ('kneeL.flex' …) broken at the start (by the world's own rule). */
  async function hurtRun(gait: 'jog' | 'sprint', joint: string, each: (w: World) => void) {
    const w = await World.create(mujocoEngine, supportRunScenario(STD, gait).setup);
    if (joint) {
      const a = w.athletes[0], [j, d] = joint.split('.'), r = BREAK[`${j.slice(0, -1)}.${d}`];
      w.breakJoint(0, j, a.muscles.index(joint), r.side < 0 ? -1 : 1, r.relax);
    }
    let downs = 0;
    while (w.time < 7) { w.step(); downs += +(!!w.athletes[0].downBy); if (w.time > 4) each(w); }
    const instabilities = w.scene.stats().instabilities;
    w.destroy();
    return { downs, instabilities };
  }

  it('on a broken leg he hobbles: 30-50 % of his top speed, off the bad leg quickly, on his feet', async () => {
    const rows: string[] = [];
    for (const gait of ['jog', 'sprint'] as const) {
      const speed: Record<string, number> = {};
      for (const joint of ['', 'kneeL.flex', 'ankleR.inv']) {
        let v = 0, n = 0, hobble = 0;
        const foot = [0, 0], load = [0, 0], plan = [0, 0], bad = joint ? (joint.includes('L.') ? 0 : 1) : -1;
        const r = await hurtRun(gait, joint, (w) => {
          const a = w.athletes[0], s = w.scene.athletes[0].state;
          v += Math.hypot(s.comVel[0], s.comVel[2]); n++;
          hobble += +(a.controller.debug?.().clip === 'hobble');
          a.feet.forEach((f, k) => { foot[k] += +f.touching; load[k] += f.force; });
          const pl = (a.controller as TrackingController).frame.planted; plan[0] += +pl[0]; plan[1] += +pl[1];
        });
        speed[joint] = v / n;
        rows.push(`${gait} ${joint || 'sound'}: ${(v / n).toFixed(2)} m/s, feet down ${foot.map((x) => (x / n * 100).toFixed(0)).join(' / ')} % (L / R), planted ${plan.map((x) => (x / n * 100).toFixed(0)).join(' / ')} %, load ${load.map((x) => (x / n).toFixed(0)).join(' / ')} N, hobble ${(hobble / n * 100).toFixed(0)} %`);
        expect(r.downs).toBe(0);
        expect(r.instabilities).toBe(0);
        if (!joint) continue;
        expect(hobble / n).toBeGreaterThan(0.95);
        // a short stance on the bad leg, which bears well under the good one's load (its weak foot may brush the turf
        // through its swing, so the contact time itself says little)
        expect(plan[bad]).toBeLessThan(0.8 * plan[1 - bad]);
        expect(load[bad]).toBeLessThan(0.6 * load[1 - bad]);
        if (gait === 'sprint') { expect(speed[joint] / speed['']).toBeGreaterThan(0.3); expect(speed[joint] / speed['']).toBeLessThan(0.5); }
      }
    }
    console.log('hobble:\n' + rows.join('\n'));
  });

  it('a broken arm hangs floppy: no muscle force, straight under gravity, swinging with the body', async () => {
    const rows: string[] = [];
    for (const joint of ['', 'elbowR.flex', 'shoulderR.flex']) {
      let el = 0, n = 0, maxTorque = 0;
      const fl: number[] = [];
      await hurtRun('sprint', joint, (w) => {
        const a = w.athletes[0], q = w.scene.athletes[0].state.q, m = a.muscles;
        el += q[m.index('elbowR.flex')]; n++; fl.push(q[m.index('shoulderR.flex')]);
        for (let i = 0; i < m.n; i++) if (/^(sc|shoulder|elbow|wrist)R\./.test(m.names[i])) maxTorque = Math.max(maxTorque, Math.abs(m.torque[i]));
      });
      const swing = Math.max(...fl) - Math.min(...fl);
      rows.push(`${joint || 'sound'}: elbow ${(el / n).toFixed(2)} rad on average, shoulder swings ${swing.toFixed(2)} rad, right-arm muscle torque up to ${maxTorque.toFixed(1)} N·m`);
      if (!joint) continue;
      expect(maxTorque).toBe(0);
      expect(el / n).toBeLessThan(0.4);  // hangs nearly straight (a sound running arm is bent ~1.4 rad)
      expect(swing).toBeGreaterThan(0.1); // and swings with the run
    }
    console.log('floppy arm:\n' + rows.join('\n'));
  });

  it('a ball carried in an arm that breaks goes to the other arm; with both broken it comes loose', async () => {
    const dr = await OpenFieldDrill.create(mujocoEngine, { ...DEFAULT_OPEN_FIELD, physics: STD, timeLimit: 8 }, new ScriptBrain(() => {}), 0);
    const w = dr.world, c = dr.carrier, a = w.athletes[c], ball = { athlete: -1, seg: dr.ball };
    const brk = (joint: string) => w.breakJoint(c, joint.split('.')[0], a.muscles.index(joint), -1, 1);
    expect(w.gripping(c, ball)).toBe(1);
    brk('elbowR.flex');
    expect(w.gripping(c, ball)).toBe(0);
    for (let i = 0; i < 480; i++) dr.step();
    expect(dr.fumbles).toBe(0);
    expect(w.gripping(c, ball)).toBe(0);
    expect(a.cmd.carry).toBe(1);
    brk('elbowL.flex');
    dr.step();
    expect(dr.fumbles).toBe(1);
    expect(w.scene.stats().instabilities).toBe(0);
    dr.destroy();
  });

  it('bone strength orders break rates: weaker bones break more often', async () => {
    const counts: Record<number, number> = {};
    for (const bones of [0.3, 0.6, 1, 3]) {
      counts[bones] = 0;
      for (let seed = 1; seed <= 6; seed++) {
        let n = 0;
        await collide({ speed: 8, script: technique.lowDrive, params: { ...DEFAULT_ATHLETE, mass: 95 } }, { speed: 4, script: technique.upright }, seed, STD, 2.5, {
          support: { ...DEFAULT_SUPPORT }, boneStrength: bones, onStep: (w) => { n = new Set(w.injuries.filter((e) => e.kind === 'break').map((e) => e.athlete)).size; },
        });
        counts[bones] += n;
      }
    }
    console.log('athletes with a break in 6 low drives, by bone strength:', counts);
    expect(counts[0.3]).toBeGreaterThan(counts[1]);
    expect(counts[0.3]).toBeGreaterThanOrEqual(counts[0.6]);
    expect(counts[0.6]).toBeGreaterThanOrEqual(counts[1]);
    expect(counts[1]).toBeGreaterThanOrEqual(counts[3]);
    expect(counts[3]).toBe(0);
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
    const cues = new SoundCues(0), heard: string[] = [];
    // 150 N·s on the helmet in 10 ms, from the side (a blindside shot)
    const w = await blow('head', [15000, 0, 0], 0.01, 7, { atCom: true }, (w) => {
      const a = w.athletes[0];
      heard.push(...cues.step(w).map((c) => c.cat));
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
    // the blow lands with a thud and a ringing, then he moans on the turf every few seconds
    expect(heard.filter((c) => c.startsWith('ko_'))).toEqual(['ko_thud', 'ko_ring']);
    expect(heard.filter((c) => c === 'pain_moan').length).toBeGreaterThanOrEqual(1);
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
