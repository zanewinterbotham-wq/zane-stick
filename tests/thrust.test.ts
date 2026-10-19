// Hip thrust from the pads' angle (owner request 2026-10-18): from lowered pads the thrust fires out along them and
// keeps the trunk low, and the pads (not the face or chest) take the hit; upright it lunges forward and up as before.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ATHLETE, type BodyPlan } from '../src/sim/anatomy/body';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';
import { ScriptBrain } from '../src/sim/brains/script';
import { leadShoulder } from '../src/sim/brains/types';
import { TrackingController } from '../src/sim/control/tracking';
import type { Commands } from '../src/sim/control/types';
import { qconj, qrot, type Quat, type Vec3 } from '../src/sim/math';
import type { MuscleSet } from '../src/sim/muscles';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { World } from '../src/sim/world';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

const tracked = (p: BodyPlan, m: MuscleSet) => new TrackingController(p, m);
type Part = 'pads' | 'head' | 'chest' | 'arms' | 'body';
const PRESS = 1.2, deg = (x: number) => (x * 180 / Math.PI).toFixed(0);

/** The human brain's mapping of the torso input (sink, lean, the automatic contact mode's ready sink) with one short
 *  thrust press at PRESS s, leading with the near shoulder. */
const hitter = (torso: number, contact: boolean) => new ScriptBrain((t, p, c: Commands) => {
  c.contactMode = contact;
  c.thrustHips = t >= PRESS && t < PRESS + 0.1;
  c.shoulder = leadShoulder(p.athletes[p.self], p.athletes[1 - p.self]);
  c.sink = contact ? Math.max(0.6 * torso, 0.25) : 0.6 * torso;
  c.lean = { fwd: torso, side: 0 };
});

/** Thorax lean forward of vertical (rad; he faces +Z, a side bend left out). */
const lean = (s: { segQuat: Float64Array }, ti: number) => {
  const q = s.segQuat.subarray(4 * ti, 4 * ti + 4), up = qrot([q[0], q[1], q[2], q[3]] as Quat, [0, 1, 0]);
  return Math.atan2(up[2], up[1]);
};

/** A thrust on his own: the trunk's lean at the press and its mean over the thrust's drive (0.1–0.5 s), and the COM
 *  path over the first 0.5 s (rise over forward, and forward m). */
async function solo(torso: number, contact = false) {
  const w = await World.create(mujocoEngine, { physics: STD, seed: 1, assist: 0, support: { ...DEFAULT_SUPPORT },
    athletes: [{ params: DEFAULT_ATHLETE, pos: [0, 0, 0], yaw: 0, team: 0, controller: tracked, brain: hitter(torso, contact) }] });
  const a = w.athletes[0], s = w.scene.athletes[0].state, ti = a.segIndex.get('thorax')!;
  while (w.time < PRESS) w.step();
  const at = lean(s, ti), c0 = [...s.com];
  let sum = 0, n = 0;
  while (w.time < PRESS + 0.5) {
    w.step();
    if (w.time >= PRESS + 0.1) { sum += lean(s, ti); n++; }
  }
  const out = { at, mean: sum / n, rise: (s.com[1] - c0[1]) / (s.com[2] - c0[2]), fwd: s.com[2] - c0[2], down: !!a.downBy, instabilities: w.scene.stats().instabilities };
  w.destroy();
  return out;
}

/** A, in the automatic contact mode, thrusts at PRESS from a set stance into B, `gap` m ahead: standing, or a ball
 *  carrier jogging in at `vB` m/s, `side` m to his left. Returns the contact impulse on A by body part over the 0.3 s after first touch
 *  (N·s), the part that touched first, and per segment pair (A's segment, > B's for a head contact). */
async function hit(torso: number, vB: number, side = 0, far = 0) {
  const gap = (vB ? 2 : 1.5) + far;
  const w = await World.create(mujocoEngine, {
    physics: STD, seed: 1, assist: 0, support: { ...DEFAULT_SUPPORT },
    athletes: [
      { params: DEFAULT_ATHLETE, pos: [0, 0, 0], yaw: 0, team: 0, controller: tracked, brain: hitter(torso, true) },
      { params: DEFAULT_ATHLETE, pos: [side, 0, gap + vB * PRESS], yaw: Math.PI, team: 1, controller: tracked,
        brain: new ScriptBrain((_t, _p, c) => { if (vB > 0) { c.move = { x: 0, z: -vB / 4.2 }; c.gait = 'jog'; c.carry = 2; } }) },
    ],
  });
  const a = w.athletes[0], s = w.scene.athletes[0].state, ti = a.segIndex.get('thorax')!;
  const th = a.plan.segments[ti], pads = th.geoms.find((g) => g.role === 'pad')!;
  const padC: Vec3 = [pads.pos![0] - th.origin[0], pads.pos![1] - th.origin[1], pads.pos![2] - th.origin[2]];
  // a thorax contact inside the pads' box (3 cm margin: the pad contact is soft) is the pads; clavicle and upper arm
  // (the shoulder under the pads' cap) count with them
  const part = (seg: number, p: Vec3): Part => {
    const n = a.plan.segments[seg].name;
    if (n === 'head' || n === 'neck') return 'head';
    if (/^(clavicle|upperArm)/.test(n)) return 'pads';
    if (/^(forearm|hand)/.test(n)) return 'arms';
    if (seg !== ti) return 'body';
    const q = s.segQuat.subarray(4 * ti, 4 * ti + 4), l = qrot(qconj([q[0], q[1], q[2], q[3]] as Quat), [p[0] - s.segPos[3 * ti], p[1] - s.segPos[3 * ti + 1], p[2] - s.segPos[3 * ti + 2]]);
    return [0, 1, 2].every((k) => Math.abs(l[k] - padC[k]) <= pads.size[k] + 0.03) ? 'pads' : 'chest';
  };
  const J: Record<Part, number> = { pads: 0, head: 0, chest: 0, arms: 0, body: 0 }, segJ: Record<string, number> = {};
  let first: Part | null = null, t0 = -1;
  while (w.time < PRESS + 1.2 && (t0 < 0 || w.time < t0 + 0.3)) {
    w.step();
    for (const c of w.time < PRESS ? [] : w.scene.contacts()) {
      const mine = c.a.athlete === 0 && c.b.athlete === 1 ? c.a : c.b.athlete === 0 && c.a.athlete === 1 ? c.b : null;
      if (!mine) continue;
      const k = part(mine.seg, c.pos), other = mine === c.a ? c.b : c.a;
      first ??= k;
      if (t0 < 0) t0 = w.time;
      J[k] += c.force * w.dt;
      const sn = a.plan.segments[mine.seg].name + (k === 'head' ? '>' + w.athletes[1].plan.segments[other.seg].name : '');
      segJ[sn] = (segJ[sn] ?? 0) + c.force * w.dt;
    }
  }
  const total = Object.values(J).reduce((x, y) => x + y, 0) || 1;
  const share = Object.fromEntries(Object.entries(J).map(([k, v]) => [k, +(v / total).toFixed(2)])) as Record<Part, number>;
  const out = { share, total, first, segJ: Object.fromEntries(Object.entries(segJ).map(([k, v]) => [k, +v.toFixed(0)])), instabilities: w.scene.stats().instabilities };
  w.destroy();
  return out;
}

describe('hip thrust follows the pads', () => {
  it('from lowered pads the trunk stays low and the body drives forward, not up; upright it lunges forward and up', async () => {
    const up = await solo(0), mid = await solo(0.6), low = await solo(1);
    for (const [k, r] of Object.entries({ upright: up, 'pads 0.6': mid, 'pads 1': low }))
      console.log(`solo thrust ${k}: lean at press ${deg(r.at)}°, mean through the drive ${deg(r.mean)}°; COM ${r.fwd.toFixed(2)} m forward, rise/forward ${r.rise.toFixed(2)}; down ${r.down}`);
    // upright: the trunk stays up and the lunge carries him forward as before
    expect(up.mean).toBeLessThan(0.2);
    expect(up.fwd).toBeGreaterThan(1);
    for (const r of [mid, low]) {
      // from lowered pads the trunk keeps a good part of their (capped) angle, well forward of the upright thrust's
      // (before: 4° and 16° mean, standing up), and the hips drive forward instead of standing up (before: rise/forward
      // 0.11 and 0.28)
      expect(r.mean).toBeGreaterThan(up.mean + 0.2);
      expect(r.mean).toBeGreaterThan(0.4 * Math.min(r.at, 0.8));
      expect(r.rise).toBeLessThan(0.1);
      expect(r.fwd).toBeGreaterThan(1);
    }
    for (const r of [up, mid, low]) { expect(r.down).toBe(false); expect(r.instabilities).toBe(0); }
  });

  it('thrusting into a standing or oncoming opponent, the pads take most of the hit and the head little', async () => {
    let pads = 0, head = 0, n = 0;
    const by: Record<string, number[]> = {};
    for (const torso of [0, 0.6, 1]) for (const vB of [0, 3]) for (const side of [-0.2, -0.1, 0, 0.1, 0.2]) for (const far of [0, 0.3]) {
      const r = await hit(torso, vB, side, far);
      const b = (by[torso] ??= [0, 0, 0]); b[0] += r.share.pads; b[1] += r.share.head; b[2]++;
      if (process.env.ALL) console.log(`thrust hit, pads ${torso}, opponent ${vB ? 'jogging in' : 'standing'} ${side} m left, ${far} m further: first ${r.first}, ${r.total.toFixed(0)} N·s in 0.3 s, shares`, JSON.stringify(r.share), JSON.stringify(r.segJ));
      expect(r.instabilities).toBe(0);
      pads += r.share.pads; head += r.share.head; n++;
    }
    for (const [k, b] of Object.entries(by)) console.log(`thrust hit from pads ${k}: mean pad share ${(b[0] / b[2]).toFixed(2)}, head ${(b[1] / b[2]).toFixed(2)}`);
    console.log(`thrust hit: mean pad share ${(pads / n).toFixed(2)}, head ${(head / n).toFixed(2)}`);
    // before (the thrust stood him up, arms punching, square): pad share 0.53 / 0.47 / 0.50 from pads 0 / 0.6 / 1,
    // head 0.05 / 0.05 / 0.12; the low ones put the face in the hit
    for (const b of Object.values(by)) { expect(b[0] / b[2]).toBeGreaterThan(0.6); expect(b[1] / b[2]).toBeLessThan(0.05); }
    expect(pads / n).toBeGreaterThan(0.6);
  });
});
