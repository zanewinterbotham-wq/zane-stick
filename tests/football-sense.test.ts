// Football sense helpers (src/sim/brains/football/sense.ts): geometry and timing cases with known answers.
import { describe, expect, it } from 'vitest';
import {
  arcClear, ballAt, ballVel, DB_REACT, interceptTime, laneClear, leverage, mates, openness, opennessLed, opponents, pressure, pressureOn, pursuit,
  reachTime, readCoverage, rel, separation, Sight, throwWindow, toWorld, zoneSpot,
} from '../src/sim/brains/football/sense';
import type { PlayFrame } from '../src/sim/brains/football/types';
import type { AthleteView, Perception } from '../src/sim/brains/types';
import type { Vec3 } from '../src/sim/math';
import { HALF_WIDTH, YD } from '../src/sim/modes/rules';

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

  it('opponents, mates and separation (a man on the turf does not count)', () => {
    const p = per([ath(0, 0, 0), ath(0, 5, 0), ath(1, 3, 4), ath(1, 1, 0, 0, 0, { down: true })]);
    expect(opponents(p)).toEqual([2, 3]);
    expect(mates(p)).toEqual([1]);
    expect(separation(p, 0)).toBeCloseTo(5);
    expect(separation(p, 1)).toBeCloseTo(Math.hypot(2, 4));
    expect(pressure(p, 0)).toBe(0);
  });
});

describe('intercept and pursuit', () => {
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

  it('pursuit: the 3-4-5 intercept point and its angle; an uncatchable target is led maxLead s', () => {
    const a = pursuit([0, 0, 0], 10, [10, 0, 0], [0, 0, 6]);
    expect(a.time).toBeCloseTo(1.25);
    expect(a.point[0]).toBeCloseTo(10); expect(a.point[2]).toBeCloseTo(7.5);
    expect(a.heading).toBeCloseTo(Math.atan2(10, 7.5));
    const b = pursuit([0, 0, 0], 5, [0, 0, 10], [0, 0, 10]);
    expect(b.time).toBe(Infinity);
    expect(b.point[2]).toBeCloseTo(35); expect(b.heading).toBeCloseTo(0);
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

  it('led: a receiver running away from a trailing man is more open than one running back at him', () => {
    // receiver at 10 m running downfield at 8 m/s with a man 3 m behind him at the same speed
    const away = opennessLed(per([ath(0, 0, 10, 0, 8), ath(1, 0, 7, 0, 8)]), 0, 1);
    // receiver coming back (a comeback) toward a man 3 m in front of him, who is still bailing
    const back = opennessLed(per([ath(0, 0, 10, 0, -4), ath(1, 0, 7, 0, 3)]), 0, 1);
    console.log(`openness led: trailing man ${away.toFixed(3)}, coming back at him ${back.toFixed(3)}`);
    expect(away).toBeGreaterThan(back);
  });
});

describe('throwing lane: bullet vs lob', () => {
  const qb: Vec3 = [0, 1.8, -5], at: Vec3 = [0, 1.2, 15];

  it('ballVel / ballAt land the ball where and when asked', () => {
    const v = ballVel(qb, at, 1.3), b = ballAt({ pos: qb, vel: v }, 1.3).pos;
    for (let k = 0; k < 3; k++) expect(b[k]).toBeCloseTo(at[k]);
  });

  it('laneClear is ground only; arcClear lets a lob over an underneath man but not a bullet', () => {
    const p = per([ath(0, 0, -5), ath(0, 0, 15), ath(1, 0.4, 5)]);
    expect(laneClear(p, qb, at, 0)).toBe(false);
    // bullet, 0.8 s for 20 m: 2.3 m high over him, below a jumping DB's hands
    const vb = ballVel(qb, at, 0.8), hb = ballAt({ pos: qb, vel: vb }, 0.4).pos[1];
    expect(hb).toBeLessThan(2.9);
    expect(arcClear(p, qb, at, 0.8, 0)).toBe(false);
    // lob, 2 s: 6.4 m over him
    expect(ballAt({ pos: qb, vel: ballVel(qb, at, 2) }, 1).pos[1]).toBeGreaterThan(6);
    expect(arcClear(p, qb, at, 2, 0)).toBe(true);
    // out of the way (2 m off the line) both are clear
    expect(arcClear(per([ath(0, 0, -5), ath(0, 0, 15), ath(1, 2, 5)]), qb, at, 0.8, 0)).toBe(true);
  });

  it('throwWindow: the underneath man takes a bullet on its way; a lob is his only if he can run under it', () => {
    const p = per([ath(0, 0, -5), ath(0, 0, 15), ath(1, 0.4, 5)]);
    const bullet = throwWindow(p, qb, at, 0.8, 0);
    expect(bullet.by).toBe(2); expect(bullet.margin).toBeLessThan(0); expect(bullet.t).toBeLessThan(0.8);
    // a 2 s lob 10 m behind him: he gets there first (it lands where he can run to)
    const lob = throwWindow(p, qb, at, 2, 0);
    expect(lob.margin).toBeLessThan(0); expect(lob.t).toBeGreaterThan(1.8);
    // a 2.6 s lob 25 m behind him: over him and away
    const deep: Vec3 = [0, 1.2, 30], far = throwWindow(p, qb, deep, 2.6, 0);
    console.log(`throw window: bullet ${bullet.margin.toFixed(2)} s at ${bullet.t.toFixed(2)} s, short lob ${lob.margin.toFixed(2)} s, deep lob ${far.margin.toFixed(2)} s`);
    expect(far.margin).toBeGreaterThan(0);
  });

  it('an out route: a man trailing the receiver leaves a window, one undercutting it takes the ball on its way', () => {
    // receiver 12 m deep at x = 5 breaking out at 7 m/s; the ball meets him 1 s on at x = 12
    const r = ath(0, 5, 12, 7, 0), catchAt: Vec3 = [12, 1.2, 12];
    const trail = throwWindow(per([ath(0, 0, -5), r, ath(1, 2, 12, 7, 0)]), qb, catchAt, 1, 0);
    const under = throwWindow(per([ath(0, 0, -5), r, ath(1, 5, 9, 7, 0)]), qb, catchAt, 1, 0);
    console.log(`out route: trailing 3 m margin ${trail.margin.toFixed(3)} s, undercutting 3 m margin ${under.margin.toFixed(3)} s at ${under.t.toFixed(2)} s`);
    expect(trail.margin).toBeGreaterThan(0);
    expect(under.margin).toBeLessThan(0);
    expect(under.t).toBeLessThan(1);
    // 2 v 2: a second receiver and defender elsewhere change neither
    const both = throwWindow(per([ath(0, 0, -5), r, ath(0, -10, 8), ath(1, 2, 12, 7, 0), ath(1, -10, 14)]), qb, catchAt, 1, 0);
    expect(both.by).toBe(3); expect(both.margin).toBeCloseTo(trail.margin);
  });
});

describe('pressure from any direction', () => {
  it('counts every standing man within the radius, the nearest first, his bearing and closing', () => {
    const qb = ath(0, 0, 0);
    // blind side 2 m behind (still), 3 m to his left closing at 4 m/s, one far away, one down beside him
    const p = per([qb, ath(1, 0, -2), ath(1, 3, 0, -4, 0), ath(1, 10, 0), ath(1, 1, 1, 0, 0, { down: true })]);
    const a = pressureOn(p, 0);
    expect(a.count).toBe(2); expect(a.nearest).toBe(1); expect(a.dist).toBeCloseTo(2);
    expect(Math.abs(a.from)).toBeCloseTo(Math.PI); expect(a.ttc).toBe(Infinity);
    const b = pressureOn(per([qb, ath(1, 3, 0, -4, 0)]), 0);
    expect(b.nearest).toBe(1); expect(b.closing).toBeCloseTo(4); expect(b.ttc).toBeCloseTo(0.75); expect(b.from).toBeCloseTo(Math.PI / 2);
    // turned to face +x, the same man is dead ahead
    expect(pressureOn(per([ath(0, 0, 0, 0, 0, { heading: Math.PI / 2 }), ath(1, 3, 0)]), 0).from).toBeCloseTo(0);
    expect(pressureOn(per([qb, ath(1, 10, 0)]), 0).nearest).toBe(-1);
  });
});

describe('leverage', () => {
  it('inside / outside toward the middle, over the top / underneath, on either side and either way', () => {
    const r = ath(0, 10, 10);
    expect(leverage(F, ath(1, 9, 12), r)).toEqual({ inside: 1, depth: 2, side: 'inside', over: true });
    const o = leverage(F, ath(1, 11.2, 8), r);
    expect(o.inside).toBeCloseTo(-1.2); expect(o.depth).toBeCloseTo(-2); expect(o.side).toBe('outside'); expect(o.over).toBe(false);
    // mirrored to the other side of the field
    expect(leverage(F, ath(1, -9, 12), ath(0, -10, 10)).side).toBe('inside');
    expect(leverage(F, ath(1, 10.3, 11), r).side).toBe('head-up');
    // the offense attacking −z: deeper is lower z
    expect(leverage({ ...F, dir: -1 }, ath(1, 9, 8), r).depth).toBeCloseTo(2);
    // a slot receiver in the middle with the ball on the −x hash: inside is toward the ball
    expect(leverage(F, ath(1, -1, 10), ath(0, 0, 10), -2.8).side).toBe('inside');
    expect(leverage(F, ath(1, 1, 10), ath(0, 0, 10), -2.8).side).toBe('outside');
  });
});

describe('zone landmarks', () => {
  it('flat at the numbers, hook at the hash, thirds, halves and quarters, mirrored by side and direction', () => {
    const numbers = HALF_WIDTH - 8 * YD, hash = 9.25 / 3 * YD;
    const flat = zoneSpot(F, { kind: 'zone', zone: 'flat', side: 1 });
    expect(flat.at[0]).toBeCloseTo(numbers); expect(flat.at[2]).toBeCloseTo(6 * YD); expect(flat.radius).toBeCloseTo(5 * YD);
    const hook = zoneSpot(F, { kind: 'zone', zone: 'hook', side: -1 });
    expect(hook.at[0]).toBeCloseTo(-hash); expect(hook.at[2]).toBeCloseTo(10 * YD);
    // the offense attacking −z from the 20: his left is −x, depth runs to lower z
    const f2: PlayFrame = { ...F, los: 20, dir: -1 }, flat2 = zoneSpot(f2, { kind: 'zone', zone: 'flat', side: 1 });
    expect(flat2.at[0]).toBeCloseTo(-numbers); expect(flat2.at[2]).toBeCloseTo(20 - 6 * YD);
    const mid = zoneSpot(F, { kind: 'zone', zone: 'deep-third', side: 0 }), out = zoneSpot(F, { kind: 'zone', zone: 'deep-third', side: -1 });
    expect(mid.at[0]).toBeCloseTo(0); expect(out.at[0]).toBeCloseTo(-2 * HALF_WIDTH / 3); expect(mid.radius).toBeCloseTo(HALF_WIDTH / 3);
    // the three thirds tile the width
    expect(out.at[0] - out.radius).toBeCloseTo(-HALF_WIDTH); expect(mid.at[0] - mid.radius).toBeCloseTo(out.at[0] + out.radius);
    expect(zoneSpot(F, { kind: 'zone', zone: 'deep-half', side: 1 }).at).toEqual(toWorld(F, 18 * YD, HALF_WIDTH / 2));
    expect(zoneSpot(F, { kind: 'zone', zone: 'deep-quarter', side: 1, inside: true }).at[0]).toBeCloseTo(HALF_WIDTH / 4);
    expect(zoneSpot(F, { kind: 'zone', zone: 'deep-quarter', side: 1 }).at[0]).toBeCloseTo(3 * HALF_WIDTH / 4);
    expect(zoneSpot(F, { kind: 'zone', zone: 'middle', side: 1 }).at[0]).toBe(0);
  });
});

describe('man or zone', () => {
  /** One second of a play every 0.05 s: athletes from `start` with velocity v(i, t). */
  function film(start: AthleteView[], v: (i: number, t: number) => [number, number]): Perception[] {
    const out: Perception[] = [], now = start.map((a) => ({ ...a, com: [...a.com] as Vec3 }));
    for (let k = 0; k <= 20; k++) {
      const t = k * 0.05;
      now.forEach((a, i) => { const [vx, vz] = v(i, t); a.comVel = [vx, 0, vz]; });
      out.push(per(now.map((a) => ({ ...a, com: [...a.com] as Vec3, comVel: [...a.comVel] as Vec3 })), 3, t));
      now.forEach((a) => { a.com[0] += a.comVel[0] * 0.05; a.com[2] += a.comVel[2] * 0.05; });
    }
    return out;
  }
  // QB 0, an out route (1), a go route (2); defender 3 mirrors the out route 0.1 s late, defender 4 bails to a deep spot
  const start = [ath(0, 0, -5), ath(0, 10, 0), ath(0, -10, 0), ath(1, 9, 5), ath(1, -9, 7)];
  const out = (t: number): [number, number] => (t < 0.5 ? [0, 7] : [6, 2]);
  const seen = film(start, (i, t) => (i === 0 ? [0, -2] : i === 1 ? out(t) : i === 2 ? [0, 8] : i === 3 ? out(Math.max(0, t - 0.1)) : [-1, 2]));

  it('the man with the out route reads as man on him; the bailing defender as zone', () => {
    const m = readCoverage(seen, 3), z = readCoverage(seen, 4);
    console.log(`coverage read: defender 3 ${m.kind} on ${m.target} (fit ${m.fit.toFixed(2)}), defender 4 ${z.kind} (best fit ${z.fit.toFixed(2)})`);
    expect(m).toMatchObject({ kind: 'man', target: 1 });
    expect(z.kind).toBe('zone');
    expect(readCoverage(seen.slice(0, 1), 3).kind).toBe('zone');
  });
});

describe('Sight (reaction delay)', () => {
  it('steady motion is seen where it is; a stop is seen only a reaction time later; himself as he is', () => {
    const s = new Sight(0.2);
    let seen: Perception | undefined;
    // athlete 1 runs +z at 5 m/s and stops dead at t = 1; athlete 0 (self) walks +x
    for (let k = 0; k <= 300; k++) {
      const t = k / 240, z = t < 1 ? 5 * t : 5, v = t < 1 ? 5 : 0;
      seen = s.see(per([ath(0, t, 0, 1, 0), ath(1, 0, z, 0, v)], 0, t));
      if (k === 216) expect(seen.athletes[1].com[2]).toBeCloseTo(5 * t, 1); // 0.9 s: carried on correctly
      if (k === 264) expect(seen.athletes[1].com[2]).toBeGreaterThan(5.4);   // 1.1 s: still thinks he runs
    }
    // 1.25 s: the stop is seen
    expect(seen!.athletes[1].com[2]).toBeCloseTo(5, 5);
    expect(seen!.athletes[0].com[0]).toBeCloseTo(300 / 240);
    expect(seen!.time).toBeCloseTo(300 / 240);
    expect(s.seen!.time).toBeLessThanOrEqual(300 / 240 - 0.2 + 1e-9);
  });

  it('a loose ball falls on its arc meanwhile, a held one is carried', () => {
    const s = new Sight(0.2), a = [ath(0, 0, 0)];
    s.see(per(a, 0, 0, { pos: [0, 5, 0], vel: [0, 0, 10] }));
    const b = s.see(per(a, 0, 0.2, { pos: [0, 0, 0], vel: [0, 0, 0] })).ball!;
    expect(b.pos[1]).toBeCloseTo(5 - 9.81 * 0.02); expect(b.pos[2]).toBeCloseTo(2); expect(b.vel[1]).toBeCloseTo(-9.81 * 0.2);
    const h = new Sight(0.2), held = [ath(0, 0, 0, 0, 0, { hasBall: true })];
    h.see(per(held, 0, 0, { pos: [0, 1, 0], vel: [0, 0, 5] }));
    expect(h.see(per(held, 0, 0.2)).ball!.pos[1]).toBeCloseTo(1);
  });
});
