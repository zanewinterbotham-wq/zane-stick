// Bot QB decisions (src/sim/brains/football/qb.ts) on hand-built Perceptions, and the throw's ballistics (throw.ts):
// the open man is chosen, a covered first read is skipped, a blocked lane gets a lob or the next read, pressure gets
// the hot route / checkdown / a scramble lane / pocket movement, and nothing open late is thrown away.
import { describe, expect, it } from 'vitest';
import type { AthleteView, Perception } from '../src/sim/brains/types';
import type { PlayCall, Read } from '../src/sim/brains/football/types';
import { bestThrow, chooseTarget, laneOpen, pocketStep, releasePoint, sackTime, scrambleLane, throwAway } from '../src/sim/brains/football/qb';
import { leadPoint, THROW, throwVelocity } from '../src/sim/throw';
const ARM_SPEED = THROW.vmax;
import type { Vec3 } from '../src/sim/math';

const HW = 24.38;
/** An athlete standing (or running at vel) at ground point (x, z). */
const ath = (team: 0 | 1, x: number, z: number, vel: Vec3 = [0, 0, 0], hasBall = false): AthleteView =>
  ({ com: [x, 1, z], comVel: vel, pelvis: [x, 1, z], head: [x, 1.75, z], heading: team ? Math.PI : 0, down: false, hasBall, team });
const percept = (athletes: AthleteView[]): Perception => ({ time: 1, self: 0, athletes, field: { halfWidth: HW, goalZ: 50, dirZ: 1 } });
/** QB is athlete 0 at depth −5 behind a LOS at z = 0, attacking +z. */
const call = (reads: Read[], extra: { hot?: number; checkdown?: number; scramble?: boolean } = {}): PlayCall => ({
  frame: { los: 0, dir: 1, halfWidth: HW, snapTime: 0 }, offense: 0,
  assign: [{ kind: 'pass', drop: 5, reads, scramble: extra.scramble ?? true, hot: extra.hot, checkdown: extra.checkdown }],
});
const qb = () => ath(0, 0, -5, [0, 0, 0], true);
const run8: Vec3 = [0, 0, 8];

describe('throw ballistics', () => {
  it('throwVelocity reaches the point within the arm; a bullet is quicker than a lob', () => {
    const from: Vec3 = [0, 1.9, 0], at: Vec3 = [5, 1.2, 25];
    for (const loft of [0, 0.5, 1]) {
      const { vel, time } = throwVelocity(from, at, loft);
      const end = [from[0] + vel[0] * time, from[1] + vel[1] * time - 9.81 * time * time / 2, from[2] + vel[2] * time];
      expect(Math.hypot(end[0] - at[0], end[1] - at[1], end[2] - at[2])).toBeLessThan(1e-6);
      expect(Math.hypot(...vel)).toBeLessThanOrEqual(ARM_SPEED + 1e-6);
    }
    const b = throwVelocity(from, at, 0), l = throwVelocity(from, at, 1);
    console.log(`25 m: bullet ${b.time.toFixed(2)} s at ${Math.hypot(...b.vel).toFixed(1)} m/s, lob ${l.time.toFixed(2)} s at ${Math.hypot(...l.vel).toFixed(1)} m/s`);
    expect(Math.hypot(...b.vel)).toBeCloseTo(ARM_SPEED, 6);
    expect(l.time).toBeGreaterThan(b.time + 0.5);
  });
  it('leadPoint: a receiver running on at his velocity is there when the ball is', () => {
    const from: Vec3 = [0, 1.9, -5], target = { pos: [8, 1.2, 6] as Vec3, vel: [-2, 0, 8] as Vec3 };
    for (const loft of [0, 0.8]) {
      const at = leadPoint(from, target, loft), T = THROW.release + throwVelocity(from, at, loft).time;
      expect(Math.hypot(target.pos[0] + target.vel[0] * T - at[0], target.pos[2] + target.vel[2] * T - at[2])).toBeLessThan(0.01);
    }
  });
});

describe('QB decisions', () => {
  it('the open man is chosen; a covered first read is skipped', () => {
    // WR1 (1) with a man 1 m on his hip; WR2 (2) running free, his man (4) 14 m off
    const p = percept([qb(), ath(0, 10, 6, run8), ath(0, -10, 6, run8), ath(1, 10.5, 5, run8), ath(1, -10, 22)]);
    const c = call([{ target: 1, by: 1.5 }, { target: 2, by: 2.5 }]);
    const t = chooseTarget(p, c, 0)!;
    console.log('progression: WR1 covered (open', bestThrow(p, c, 0, 1, 0)?.open.toFixed(2), '), WR2 open', t.open.toFixed(2), t.kind);
    expect(t.target).toBe(2);
    expect(t.read).toBe(1);
    expect(chooseTarget(p, c, 0, { from: 0, to: 0 })).toBe(null);
    // with WR1 free he is the first read, and is thrown to
    const q = percept([qb(), ath(0, 10, 6, run8), ath(0, -10, 6, run8), ath(1, 10, 24), ath(1, -10, 22)]);
    expect(chooseTarget(q, c, 0)!.target).toBe(1);
  });

  it('an underneath defender in the bullet\'s lane: touch over him; one at the QB\'s face: the next read', () => {
    // WR1 free 15 m downfield; a linebacker standing on the bullet's path 6 m in front of the QB
    const wr = ath(0, 0, 10, [0, 0, 6]);
    const from = releasePoint(qb()), at = leadPoint(from, { pos: [0, 1.2, 10], vel: [0, 0, 6] }, 0);
    const lb = ath(1, 0.2, 1);
    const p = percept([qb(), wr, ath(0, -10, 6, run8), lb, ath(1, -14, 30)]);
    const c = call([{ target: 1, by: 1.5 }, { target: 2, by: 2.5 }]);
    const bv = throwVelocity(from, at, 0);
    expect(laneOpen(p, from, at, bv.vel, bv.time, 0)).toBe(false);
    const t = chooseTarget(p, c, 0)!;
    console.log('LB under the bullet: thrown', t.kind, 'loft', t.loft, 'to', t.target, 'open', t.open.toFixed(2));
    expect(t.target).toBe(1);
    expect(t.loft).toBeGreaterThan(0);
    // the linebacker right in front of the QB (1.5 m) on WR1's line: no arc gets over him to WR1; WR2's lane (25° to the
    // left, passing 1 m from him) is clear
    const q = percept([qb(), wr, ath(0, -10, 6, run8), ath(1, 0.4, -3.5), ath(1, -14, 30)]);
    const u = chooseTarget(q, c, 0, { heat: Infinity })!;
    expect(bestThrow(q, c, 0, 1, 0)).toBe(null);
    expect(u.target).toBe(2);
  });

  it('a man on the deep receiver\'s hip: the back-shoulder ball, short and away from him', () => {
    const wr = ath(0, 12, 16, [0, 0, 9]), cb = ath(1, 11.4, 14.6, [0, 0, 9]);
    const p = percept([qb(), wr, cb]);
    const t = bestThrow(p, call([{ target: 1, by: 2 }]), 0, 1, 0)!;
    console.log('man on the hip: ', t.kind, 'open', t.open.toFixed(2), 'at', t.at.map((v) => v.toFixed(1)).join(', '));
    expect(t.kind).toBe('back-shoulder');
    expect(t.at[0]).toBeGreaterThan(wr.com[0]);
    // a man trailing 4 m: the ball is led in front of the receiver instead
    const q = percept([qb(), wr, ath(1, 12, 12, [0, 0, 9])]);
    const u = bestThrow(q, call([{ target: 1, by: 2 }]), 0, 1, 0)!;
    expect(u.kind).not.toBe('back-shoulder');
    expect(u.at[2]).toBeGreaterThan(wr.com[2] + 5);
  });

  it('pressure: the hot route; covered progression: the checkdown', () => {
    // a blitzer 4 m from the QB closing at 7 m/s; the hot (2) is free on a quick route; the read (1) is covered
    const blitz = ath(1, 3, -2, [-4.2, 0, -5.6]);
    const p = percept([qb(), ath(0, 10, 6, run8), ath(0, -5, 0, [-3, 0, 3]), ath(1, 10.5, 5, run8), blitz]);
    const c = call([{ target: 1, by: 1.5 }], { hot: 2, checkdown: 2 });
    console.log('blitz: sack time', sackTime(p, 0).toFixed(2), 's');
    const h = chooseTarget(p, c, 0, { from: 0, to: 0 })!;
    expect(h.target).toBe(2);
    expect(h.read).toBe(-1);
    // no rush: the covered read gives nothing, the progression exhausted gives the checkdown
    const q = percept([qb(), ath(0, 10, 6, run8), ath(0, -5, 0, [-3, 0, 3]), ath(1, 10.5, 5, run8), ath(1, -12, 18)]);
    expect(chooseTarget(q, c, 0, { from: 0, to: 0 })).toBe(null);
    const k = chooseTarget(q, c, 0, { from: 1, to: 1 })!;
    expect(k.target).toBe(2);
    expect(k.read).toBe(-2);
  });

  it('pocket: steps up against an edge rusher, slides away from one in front; scrambles through an open lane', () => {
    const edge = percept([qb(), ath(1, 3, -6, [-6, 0, 1])]);
    const s = pocketStep(edge, call([]), 0)!;
    expect(s.z).toBeGreaterThan(0.5); // up
    expect(s.x).toBeLessThan(0);      // away from the rusher's side
    const front = percept([qb(), ath(1, 0.5, -2, [0, 0, -6])]);
    const f = pocketStep(front, call([]), 0)!;
    expect(Math.abs(f.x)).toBeGreaterThan(0.9);
    expect(f.z).toBeLessThanOrEqual(0);
    // coverage deep and wide: the middle is open to run; a spy at the LOS in the middle sends him wide or nowhere
    const deep = percept([qb(), ath(0, 15, 12, run8), ath(1, 15, 13, run8)]);
    const lane = scrambleLane(deep, call([]), 0)!;
    expect(lane.z).toBeGreaterThan(0.9);
    const spy = percept([qb(), ath(0, 15, 12, run8), ath(1, 0, 1)]);
    const l2 = scrambleLane(spy, call([]), 0);
    expect(l2 === null || Math.abs(l2.x) > 0.3).toBe(true);
  });

  it('nothing open late: thrown away far beyond the sideline, past every defender', () => {
    const p = percept([ath(0, 6, -5, [0, 0, 0], true), ath(0, 10, 6, run8), ath(1, 10.5, 5, run8)]);
    const a = throwAway(p, call([{ target: 1, by: 1 }]), 0);
    expect(a.target).toBe(-1);
    expect(Math.abs(a.at[0])).toBeGreaterThan(HW + 5);
    expect(a.at[2]).toBeGreaterThan(-5);
  });
});
