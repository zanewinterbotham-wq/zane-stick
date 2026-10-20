// Football sense helpers (src/sim/brains/football/sense.ts): geometry and timing cases with known answers.
import { describe, expect, it } from 'vitest';
import { ballAt, DB_REACT, interceptTime, openness, opponents, reachTime, rel, toWorld } from '../src/sim/brains/football/sense';
import type { PlayFrame } from '../src/sim/brains/football/types';
import type { AthleteView, Perception } from '../src/sim/brains/types';
import type { Vec3 } from '../src/sim/math';
import { HALF_WIDTH } from '../src/sim/modes/rules';

/** An athlete on team `team` at ground (x, z) moving at (vx, vz). */
function ath(team: 0 | 1, x: number, z: number, vx = 0, vz = 0, o: Partial<AthleteView> = {}): AthleteView {
  return { com: [x, 1, z], comVel: [vx, 0, vz], pelvis: [x, 1, z], head: [x, 1.7, z], heading: 0, down: false, hasBall: false, team, ...o };
}
const field = { halfWidth: HALF_WIDTH, goalZ: 50, dirZ: 1 as const };
const per = (athletes: AthleteView[], self = 0, time = 0, ball?: Perception['ball']): Perception => ({ time, self, athletes, field, ball });
const F: PlayFrame = { los: 0, dir: 1, halfWidth: HALF_WIDTH, snapTime: 0 };

describe('frame and teams', () => {
  it('rel / toWorld round trip either way the offense attacks', () => {
    for (const f of [F, { ...F, los: 20, dir: -1 as const }]) {
      const w = toWorld(f, 7, -3);
      expect(rel(f, w)).toEqual({ depth: 7, x: -3 });
    }
    expect(toWorld({ ...F, los: 20, dir: -1 }, 5, 0)[2]).toBe(15);
  });

  it('opponents', () => {
    const p = per([ath(0, 0, 0), ath(0, 5, 0), ath(1, 3, 4), ath(1, 1, 0, 0, 0, { down: true })]);
    expect(opponents(p)).toEqual([2, 3]);
  });
});

describe('intercept and reach', () => {
  it('interceptTime: crossing, head on, equal speeds, a faster target', () => {
    // |(10, 6t)| = 10t → t = 1.25
    expect(interceptTime([0, 0, 0], 10, [10, 0, 0], [0, 0, 6])).toBeCloseTo(1.25);
    // equal speeds coming at each other from 10 m: 1 s; running away: never
    expect(interceptTime([0, 0, 0], 5, [0, 0, 10], [0, 0, -5])).toBeCloseTo(1);
    expect(interceptTime([0, 0, 0], 5, [0, 0, 10], [0, 0, 5])).toBe(Infinity);
    // a faster target coming at him: they close at 15 m/s
    expect(interceptTime([0, 0, 0], 5, [0, 0, 10], [0, 0, -10])).toBeCloseTo(10 / 15);
    expect(interceptTime([0, 0, 0], 5, [0, 0, 10], [0, 0, 10])).toBe(Infinity);
    expect(interceptTime([1, 0, 1], 5, [1, 0, 1], [0, 0, 5])).toBe(0);
  });

  it('reachTime: from a stand, coming on at full speed, going the wrong way, already there', () => {
    // standing 10 m off, reach 1: accelerate 8 m/s² to 9 m/s (5.06 m in 1.125 s), then 3.94 m at 9 m/s
    expect(reachTime([0, 0, 0], [0, 0, 0], [0, 0, 10], 0)).toBeCloseTo(1.5625);
    expect(reachTime([0, 0, 0], [0, 0, 0], [0, 0, 10])).toBeCloseTo(1.5625 + DB_REACT);
    // already running at it at 9 m/s: 9 m at 9 m/s
    expect(reachTime([0, 0, 0], [0, 0, 9], [0, 0, 10])).toBeCloseTo(1);
    // running away at 5 m/s: 0.25 s carrying on, 0.625 s stopping, then 11.81 m from a stand
    expect(reachTime([0, 0, 0], [0, 0, -5], [0, 0, 10])).toBeCloseTo(0.25 + 0.625 + 1.125 + 0.75);
    expect(reachTime([0, 0, 0], [0, 0, 0], [0.5, 0, 0])).toBe(0);
    // running across him, he passes within reach while still carrying on
    expect(reachTime([-1, 0, 0.5], [10, 0, 0], [0, 0, 0])).toBeCloseTo((1 - Math.sqrt(0.75)) / 10);
  });
});

describe('openness', () => {
  it('margin of the quickest defender over the ball: standing, closing at full speed, down', () => {
    const at: Vec3 = [0, 1.2, 10];
    // standing 10 m from the spot: 1.8125 s vs a 1 s flight
    expect(openness(per([ath(0, 0, 9), ath(1, 0, 0)]), 0, at, 1)).toBeCloseTo(0.8125);
    // the same man already sprinting at the spot gets there with the ball
    expect(openness(per([ath(0, 0, 9), ath(1, 0, 0, 0, 9)]), 0, at, 1)).toBeCloseTo(0);
    expect(openness(per([ath(0, 0, 9), ath(1, 0, 0, 0, 0, { down: true })]), 0, at, 1)).toBe(1);
    // two defenders (2 v 2): the nearer one decides
    expect(openness(per([ath(0, 0, 9), ath(0, 5, 0), ath(1, 0, 0), ath(1, 0, 8)]), 0, at, 1)).toBe(0);
  });
});

describe('the ball in the air', () => {
  it('ballAt: a ballistic arc (no drag)', () => {
    const b = ballAt({ pos: [0, 1, 0], vel: [2, 9.81, 10] }, 1);
    expect(b.pos[0]).toBeCloseTo(2); expect(b.pos[1]).toBeCloseTo(1 + 9.81 / 2); expect(b.pos[2]).toBeCloseTo(10); expect(b.vel[1]).toBeCloseTo(0);
  });
});
