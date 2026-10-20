// The defensive back brain (docs/passing.md "AI built for 11 on 11"), headless against scripted receivers and a
// standing QB: man press and off stay on the receiver through his break, zone defenders drop to their landmarks and
// pass crossing receivers off to each other, and a thrown ball gets a hand on it or near it. 1 v 1 and 2 v 2.
import { beforeAll, describe, expect, it } from 'vitest';
import { DIFFICULTY } from '../src/sim/brains/carrier';
import { DefensiveBackBrain, eligible, zoneLandmark } from '../src/sim/brains/football/db';
import { ballSpot, DB_SPEED, DB_TURN, runTime } from '../src/sim/brains/football/sense';
import type { Assignment, ManAssign, PlayCall, PlayFrame, ZoneAssign } from '../src/sim/brains/football/types';
import { ScriptBrain } from '../src/sim/brains/script';
import type { AthleteView, Brain, Perception } from '../src/sim/brains/types';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import type { Vec3 } from '../src/sim/math';
import { Play } from '../src/sim/modes/play';
import { HALF_WIDTH, NFL } from '../src/sim/modes/rules';
import type { ModeDef } from '../src/sim/modes/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const G = 9.81, SNAP = 0.5;
const F: PlayFrame = { los: 0, dir: 1, halfWidth: HALF_WIDTH, snapTime: SNAP };
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;

/** A scripted route from the line (team 0 attacks +z): the stem straight downfield at 85% of a sprint to `brk` m,
 *  then a plant and the break: 'go' runs on, 'slant' 45° inside (toward x = 0), 'out' to the sideline, 'curl' back
 *  1.5 m toward the QB and sits, 'cross' flat across the field to the far side (`dir` −1/+1 in x); 'stand' never
 *  moves. `out.breakAt` is when the plant came (world s). */
type Route = 'go' | 'slant' | 'out' | 'curl' | 'cross' | 'stand';
function route(kind: Route, brk: number, out: { breakAt: number }, xdir?: number): Brain {
  let state: 'stem' | 'break' | 'sit' = 'stem', plantEnd = 0, sitAt: Vec3 | null = null, side: number | undefined;
  return new ScriptBrain((t, p, c) => {
    const me = p.athletes[p.self], b = p.ball;
    if (t < SNAP || kind === 'stand') return;
    // a ball in the air near him: both hands to it (the contest the DB plays against)
    if (b && !p.athletes.some((a) => a.hasBall) && b.pos[1] > 0.3 && Math.hypot(b.pos[0] - me.com[0], b.pos[1] - me.com[1], b.pos[2] - me.com[2]) < 3) {
      c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = [b.pos[0], b.pos[1], b.pos[2]];
    }
    c.gait = 'sprint';
    const inside = (side ??= xdir ?? (-Math.sign(me.com[0]) || 1));
    if (state === 'stem' && me.com[2] >= brk && kind !== 'go') { state = 'break'; out.breakAt = t; plantEnd = t + 0.1; }
    let mx = 0, mz = 1;
    if (state === 'break') {
      if (kind === 'slant') { mx = inside * Math.SQRT1_2; mz = Math.SQRT1_2; }
      else if (kind === 'out') { mx = -inside; mz = 0; }
      else if (kind === 'cross') { mx = inside; mz = 0; }
      else if (kind === 'curl') {
        sitAt ??= [me.com[0] + inside * 0.5, 0, me.com[2] - 1.5];
        const dx = sitAt[0] - me.com[0], dz = sitAt[2] - me.com[2], d = Math.hypot(dx, dz);
        if (d < 0.3) state = 'sit'; else { mx = dx / d; mz = dz / d; }
      }
      if (t < plantEnd) c.plantCut = mx * 1 > 0 ? 1 : -1;
    }
    if (state === 'sit') { mx = 0; mz = 0; c.face = { x: -me.com[0], z: -5 - me.com[2] }; }
    const k = state === 'stem' || state === 'break' && kind !== 'curl' ? 0.85 : 0.5;
    c.move = { x: mx * k, z: mz * k };
  });
}

interface Wr { x: number; route: Route; brk?: number; xdir?: number }
interface Db { at: [number, number]; assign: ManAssign | ZoneAssign }
/** QB (athlete 0, holding the ball 5 m behind the line), the receivers (1..), then the defensive backs. */
async function scene(wrs: Wr[], dbs: Db[], seed = 1, diff = DIFFICULTY.normal) {
  const breaks = wrs.map(() => ({ breakAt: NaN }));
  const assign: Assignment[] = [{ kind: 'pass', drop: 0, reads: [], scramble: false }, ...wrs.map((): Assignment => ({ kind: 'route', route: 'go' })), ...dbs.map((d) => d.assign)];
  const call: PlayCall = { frame: F, offense: 0, assign };
  const db0 = 1 + wrs.length, made = new Map<number, DefensiveBackBrain>();
  const def: ModeDef = {
    id: 'db-test', title: '', pitch: '', preview: '', options: [], athletes: () => assign.length,
    setup: () => ({
      players: [{ team: 0, label: 'QB', pos: [0, -5] }, ...wrs.map((w, k) => ({ team: 0 as const, label: `WR${k}`, pos: [w.x, -0.4] as [number, number] })),
        ...dbs.map((d, k) => ({ team: 1 as const, label: `DB${k}`, pos: d.at }))],
      ball: { holder: 0 },
      rules: { ...NFL, outOfBounds: false, timeLimit: 20 },
      brain: (_play, i, rng) => {
        if (i < db0) return null;
        if (!made.has(i)) made.set(i, new DefensiveBackBrain(rng, diff, call, i));
        return made.get(i)!;
      },
    }),
  };
  const fixed: Brain[] = [new ScriptBrain(() => {}), ...wrs.map((w, k) => route(w.route, w.brk ?? 10, breaks[k], w.xdir))];
  const play = await Play.create(mujocoEngine, { ...base, physics: STD, bot: carrier, seed }, def, {}, null, 0, { human: -1, fixed });
  const brains = dbs.map((_, k) => made.get(db0 + k)!);
  return { play, breaks, brains, db0, w: play.world };
}
const com = (play: Play, i: number) => play.world.scene.athletes[i].state.com;
const flatD = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[2] - b[2]);
function run(play: Play, until: number, each?: () => boolean | void) {
  while (play.world.time < until && !play.ended) { play.step(); if (each?.()) break; }
}
/** The QB lets go of the ball and it flies from beside his head to `at` in T s. */
function throwTo(play: Play, at: Vec3, T: number) {
  const w = play.world, h = w.gripping(0, { athlete: -1, seg: play.ball });
  if (h >= 0) w.releaseGrip(0, h as 0 | 1);
  const q = com(play, 0), from: Vec3 = [q[0], 1.9, q[2] + 0.6];
  w.scene.placeProp(play.ball, from, [0, 0, 0, 1]);
  w.scene.launchProp(play.ball, [(at[0] - from[0]) / T, (at[1] - from[1] + G * T * T / 2) / T, (at[2] - from[2]) / T], [0, 0, 0]);
  play.step();
}
const man = (target: number, press: boolean, leverage: 'inside' | 'outside' = 'inside'): ManAssign => ({ kind: 'man', target, press, leverage, help: 'none' });

/** One man rep: receiver distance (m) from his DB at the plant and 0.5 s on, and whether the physics stayed sane. */
async function manRep(wrs: Wr[], press: boolean, seed = 1) {
  const dbs: Db[] = wrs.map((w, k) => ({ at: [w.x + (w.x > 0 ? -0.7 : 0.7), press ? 1 : 5], assign: man(1 + k, press) }));
  const s = await scene(wrs, dbs, seed);
  const at = wrs.map(() => NaN), after = wrs.map(() => NaN), other = wrs.map(() => Infinity);
  run(s.play, SNAP + 4, () => {
    wrs.forEach((_, k) => {
      const d = flatD(com(s.play, 1 + k), com(s.play, s.db0 + k)), b = s.breaks[k].breakAt, t = s.play.world.time;
      if (Number.isNaN(at[k]) && (t >= b || (wrs[k].route === 'go' && com(s.play, 1 + k)[2] >= 10))) at[k] = d;
      if (Number.isNaN(after[k]) && t >= b + 0.5) after[k] = d;
      // nearer his own man than any other receiver
      wrs.forEach((_, j) => { if (j !== k) other[k] = Math.min(other[k], flatD(com(s.play, 1 + j), com(s.play, s.db0 + k))); });
    });
  });
  wrs.forEach((_, k) => { if (Number.isNaN(at[k])) at[k] = after[k] = flatD(com(s.play, 1 + k), com(s.play, s.db0 + k)); });
  const out = { ended: s.play.ended, t: s.play.world.time, at, after, other, inst: s.w.scene.stats().instabilities, down: s.w.athletes.filter((a) => a.downBy).length, phases: s.brains.map((b) => b.phase) };
  s.play.destroy();
  return out;
}

describe('defensive back helpers (pure)', () => {
  it('zone landmarks sit at their depth and width from the ball, on the side asked, inside the field', () => {
    const flatL = zoneLandmark(F, { kind: 'zone', zone: 'flat', side: 1 }), hookR = zoneLandmark(F, { kind: 'zone', zone: 'hook', side: -1 }, 3);
    const third = zoneLandmark(F, { kind: 'zone', zone: 'deep-third', side: 0 }), back = zoneLandmark({ ...F, dir: -1 }, { kind: 'zone', zone: 'flat', side: 1 });
    expect(flatL.depth).toBeLessThan(6); expect(flatL.x).toBeGreaterThan(12);
    expect(hookR.x).toBeCloseTo(3 - 4.5); expect(third.x).toBe(0); expect(third.depth).toBeGreaterThan(12);
    expect(back.x).toBeLessThan(-12); // the offense's left flips with its direction
    expect(zoneLandmark(F, { kind: 'zone', zone: 'flat', side: 1 }, 20).x).toBeLessThanOrEqual(HALF_WIDTH - 2);
  });

  it('ballSpot: a defender near a pass meets it in the air; one far off is late, at where it comes down', () => {
    const b = { pos: [0, 2, 0] as Vec3, vel: [0, 5, 18] as Vec3 };
    const near = ballSpot(b, [1, 1, 16]), running = ballSpot(b, [1, 1, 10], [0, 0, 9]), far = ballSpot(b, [15, 1, 10]);
    expect(near.late).toBe(false); expect(near.at[2]).toBeGreaterThan(14); expect(near.at[2]).toBeLessThan(18); expect(near.at[1]).toBeLessThan(2.7);
    expect(running.late).toBe(false); // already at speed his way: he gets there, from a stand he would not
    expect(ballSpot(b, [1, 1, 10]).late).toBe(true);
    expect(far.late).toBe(true); expect(far.at[1]).toBeLessThan(0.5);
    const dbRun = (d: number, v0 = 0) => runTime(d, v0, DB_SPEED, DB_TURN);
    expect(dbRun(0)).toBeCloseTo(0.15); expect(dbRun(30)).toBeCloseTo(0.15 + 1.5 + (30 - 6.75) / 9); expect(dbRun(5, 9)).toBeCloseTo(0.15 + 5 / 9);
  });

  it('eligible: the receivers, not the QB with the ball, a teammate, or a man on the turf', () => {
    const v = (team: 0 | 1, hasBall = false, down = false): AthleteView => ({ com: [0, 1, 0], comVel: [0, 0, 0], pelvis: [0, 1, 0], head: [0, 1.8, 0], heading: 0, down, hasBall, team });
    const p: Perception = { time: 0, self: 3, athletes: [v(0, true), v(0), v(0, false, true), v(1), v(0)], field: { halfWidth: HALF_WIDTH, goalZ: 50, dirZ: 1 } };
    const call: PlayCall = { frame: F, offense: 0, assign: [{ kind: 'pass', drop: 0, reads: [], scramble: false }, { kind: 'route', route: 'go' }, { kind: 'route', route: 'go' }, null, { kind: 'block' }] };
    expect([0, 1, 2, 3, 4].filter((i) => eligible(p, call, i, 1))).toEqual([1]);
  });
});

const SEEDS = [1, 2, 3, 4];
const med = (xs: number[]) => { const v = xs.map((x) => (Number.isNaN(x) ? Infinity : x)).sort((a, b) => a - b), n = v.length; return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; };
const f2 = (xs: number[]) => xs.map((x) => x.toFixed(2)).join(' ');

describe('defensive back vs scripted receivers (headless)', () => {
  // one rep is chaotic (a 1 mm difference in the jam decides who comes off it first), so each case is the median of four
  // seeds; the receiver kept from ever reaching his break counts as covered at the distance the rep ends at
  it('man press and man off stay on the receiver through his break (go, slant, out, curl)', async () => {
    const checks: (() => void)[] = [];
    const routes: Wr[] = [{ x: -10, route: 'go' }, { x: -10, route: 'slant', brk: 5 }, { x: -10, route: 'out', brk: 10 }, { x: -10, route: 'curl', brk: 10 }];
    for (const press of [true, false]) for (const r of routes) {
      const ms: Awaited<ReturnType<typeof manRep>>[] = [];
      for (const seed of SEEDS) ms.push(await manRep([r], press, seed));
      const at = ms.map((m) => m.at[0]), after = ms.map((m) => m.after[0]);
      console.log(`man ${press ? 'press' : 'off  '} vs ${r.route.padEnd(5)}: at the break ${f2(at)} m (median ${med(at).toFixed(2)}), 0.5 s on ${f2(after)} m (median ${med(after).toFixed(2)}); down at the end ${ms.map((m) => m.down).join(' ')}`);
      checks.push(() => { for (const m of ms) expect(m.inst).toBe(0); expect(med(at)).toBeLessThan(2); if (r.route !== 'go') expect(med(after)).toBeLessThan(2.2); });
    }
    checks.forEach((c) => c());
  });

  it('2 v 2 man: each defender stays on his own receiver, the routes crossing in front of them', async () => {
    const checks: (() => void)[] = [];
    for (const press of [true, false]) {
      const ms: Awaited<ReturnType<typeof manRep>>[] = [];
      for (const seed of SEEDS) ms.push(await manRep([{ x: -9, route: 'slant', brk: 5 }, { x: 9, route: 'out', brk: 8, xdir: 1 }], press, seed));
      for (const k of [0, 1]) {
        const at = ms.map((m) => m.at[k]), after = ms.map((m) => m.after[k]);
        console.log(`2 v 2 man ${press ? 'press' : 'off  '}, receiver ${k + 1}: at the break ${f2(at)} m (median ${med(at).toFixed(2)}), 0.5 s on ${f2(after)} (median ${med(after).toFixed(2)}); nearest other receiver ${f2(ms.map((m) => m.other[k]))} m`);
        checks.push(() => { expect(med(at)).toBeLessThan(2); expect(med(after)).toBeLessThan(2.2); });
      }
      for (const m of ms) expect(m.inst).toBe(0);
    }
    checks.forEach((c) => c());
  });
  it('zone: each defender drops to his landmark facing the QB (flat, hook, curl, deep third)', async () => {
    const zones: ZoneAssign[] = [{ kind: 'zone', zone: 'flat', side: 1 }, { kind: 'zone', zone: 'hook', side: -1 }, { kind: 'zone', zone: 'curl', side: 1 }, { kind: 'zone', zone: 'deep-third', side: 0 }];
    const starts: [number, number][] = [[8, 6], [-2, 5], [6, 7], [0, 8]];
    const s = await scene([{ x: 8, route: 'stand' }], zones.map((z, k) => ({ at: starts[k], assign: z })));
    run(s.play, SNAP + 3.5);
    const p = s.w.perception(0), qb = com(s.play, 0);
    zones.forEach((z, k) => {
      const L = zoneLandmark(F, z), me = p.athletes[s.db0 + k], d = Math.hypot(me.com[0] - L.x, me.com[2] - L.depth);
      const e = me.heading - Math.atan2(qb[0] - me.com[0], qb[2] - me.com[2]), faceErr = Math.abs(Math.atan2(Math.sin(e), Math.cos(e)));
      console.log(`zone ${z.zone.padEnd(10)} side ${z.side}: landmark (${L.x.toFixed(1)}, ${L.depth.toFixed(1)}) m, at (${me.com[0].toFixed(1)}, ${me.com[2].toFixed(1)}): ${d.toFixed(2)} m off, facing ${(faceErr * 180 / Math.PI).toFixed(0)} deg off the QB, matched [${s.brains[k].matched}]`);
      expect(d).toBeLessThan(1.5);
      expect(faceErr).toBeLessThan(0.6);
      expect(s.brains[k].matched).toEqual([]);
    });
    expect(s.w.scene.stats().instabilities).toBe(0);
    s.play.destroy();
  });

  it('2 v 2 zone: two hook defenders pick up the receiver crossing into their zone and pass him off as he leaves', async () => {
    const hooks: ZoneAssign[] = [{ kind: 'zone', zone: 'hook', side: 1 }, { kind: 'zone', zone: 'hook', side: -1 }];
    let both = 0;
    for (const seed of SEEDS) {
      // receiver 1 starts on the +x side (the hook on side +1 is his first), breaking across at 3 m; receiver 2 from -x at 5 m
      // (the cut from a sprint rounds them off ~4 m deeper)
      const s = await scene([{ x: 10, route: 'cross', brk: 3 }, { x: -10, route: 'cross', brk: 5 }], hooks.map((z, k) => ({ at: [k ? -4 : 4, 6] as [number, number], assign: z })), seed);
      const L = hooks.map((z) => zoneLandmark(F, z)), far = [0, 0];
      run(s.play, SNAP + 5.5, () => {
        hooks.forEach((_, k) => { const c = com(s.play, s.db0 + k); far[k] = Math.max(far[k], Math.hypot(c[0] - L[k].x, c[2] - L[k].depth)); });
      });
      const m = s.brains.map((b) => b.matched);
      console.log(`seed ${seed}: hook +1 matched receivers [${m[0]}], hook -1 matched [${m[1]}]; farthest from the landmark ${f2(far)} m`);
      if (m[0][0] === 1 && m[0].includes(2) && m[1][0] === 2 && m[1].includes(1)) both++;
      for (const k of [0, 1]) expect(far[k]).toBeLessThan(L[k].r + 2.5);
      expect(s.w.scene.stats().instabilities).toBe(0);
      s.play.destroy();
    }
    expect(both).toBeGreaterThanOrEqual(SEEDS.length - 1);
  });

  it('2 v 2 zone, deep halves: each stays over the top of the vertical in his half', async () => {
    const halves: ZoneAssign[] = [{ kind: 'zone', zone: 'deep-half', side: 1 }, { kind: 'zone', zone: 'deep-half', side: -1 }];
    const s = await scene([{ x: 10, route: 'go' }, { x: -10, route: 'go' }], halves.map((z, k) => ({ at: [k ? -9 : 9, 10] as [number, number], assign: z })));
    const over = [Infinity, Infinity];
    run(s.play, SNAP + 3.5, () => { for (const k of [0, 1]) if (com(s.play, 1 + k)[2] > 5) over[k] = Math.min(over[k], com(s.play, s.db0 + k)[2] - com(s.play, 1 + k)[2]); });
    console.log(`deep halves vs two verticals: least depth over the receiver ${f2(over)} m; matched [${s.brains.map((b) => b.matched).join('] [')}]; receivers at ${f2([com(s.play, 1)[2], com(s.play, 2)[2]])} m`);
    for (const k of [0, 1]) { expect(over[k]).toBeGreaterThan(0); expect(s.brains[k].matched[0]).toBe(1 + k); }
    expect(s.w.scene.stats().instabilities).toBe(0);
    s.play.destroy();
  });
});

/** One thrown ball: the QB throws to receiver `to` (1-based) `after` s past his plant, leading him `T` s; how close
 *  the defender `db` gets a hand to it, whether he touches it (a hand, an arm, the body), and how it ends. */
async function throwRep(wrs: Wr[], dbs: Db[], to: number, db: number, seed: number, after = 0.45, T = 0.7) {
  const s = await scene(wrs, dbs, seed), w = s.w, D = s.db0 + db;
  run(s.play, SNAP + 4, () => w.time >= s.breaks[to - 1].breakAt + after);
  const r = w.scene.athletes[to].state;
  throwTo(s.play, [r.com[0] + r.comVel[0] * T, 1.3, r.com[2] + r.comVel[2] * T], T);
  const early = s.brains[db].phase === 'ball';
  let hand = Infinity, wrHand = Infinity, touched = false, turf = false, reacted = NaN;
  const t0 = w.time;
  run(s.play, t0 + 2.5, () => {
    const b = s.play.ballPos();
    for (const h of [0, 1] as const) {
      const q = w.handPoint(w.athletes[D], h), o = w.handPoint(w.athletes[to], h);
      hand = Math.min(hand, Math.hypot(q[0] - b[0], q[1] - b[1], q[2] - b[2])); wrHand = Math.min(wrHand, Math.hypot(o[0] - b[0], o[1] - b[1], o[2] - b[2]));
    }
    for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]]) if (p.athlete < 0 && p.seg === s.play.ball) { if (o.athlete === D) touched = true; if (o.athlete < 0 && o.seg < 0) turf = true; }
    if (Number.isNaN(reacted) && s.brains[db].phase === 'ball') reacted = w.time - t0;
    return turf || w.ballCarrier >= 0;
  });
  const int = w.ballCarrier === D, caught = w.ballCarrier === to;
  // after a catch he tackles (TacklerBrain), with an interception he runs it back
  if (int || caught) run(s.play, w.time + DIFFICULTY.normal.reaction + 0.1);
  const out = { hand, wrHand, touched, reacted, early, int, caught, then: s.brains[db].phase, incomplete: turf && w.ballCarrier < 0, tried: s.play.lastCatch?.athlete === D, inst: w.scene.stats().instabilities };
  s.play.destroy();
  return out;
}

describe('defensive back vs a thrown ball (headless)', () => {
  it('breaks on the throw only after it is released, and gets a hand on it or near it in a fair share of seeds (1 v 1 and 2 v 2)', async () => {
    const cases: { name: string; wrs: Wr[]; dbs: Db[]; to: number; db: number }[] = [
      { name: 'press vs slant', wrs: [{ x: -10, route: 'slant', brk: 5 }], dbs: [{ at: [-9.3, 1], assign: man(1, true) }], to: 1, db: 0 },
      { name: 'off vs curl', wrs: [{ x: -10, route: 'curl', brk: 10 }], dbs: [{ at: [-9.3, 5], assign: man(1, false) }], to: 1, db: 0 },
      { name: '2 v 2 press, to the in', wrs: [{ x: -9, route: 'slant', brk: 5 }, { x: 9, route: 'out', brk: 8, xdir: 1 }], dbs: [{ at: [-8.3, 1], assign: man(1, true) }, { at: [8.3, 1], assign: man(2, true) }], to: 2, db: 1 },
      { name: '2 v 2 hook zones, to the cross', wrs: [{ x: 10, route: 'cross', brk: 3 }, { x: -10, route: 'cross', brk: 5 }], dbs: [{ at: [4, 6], assign: { kind: 'zone', zone: 'hook', side: 1 } }, { at: [-4, 6], assign: { kind: 'zone', zone: 'hook', side: -1 } }], to: 1, db: 0 },
    ];
    let on = 0, n = 0;
    for (const k of cases) {
      const rs: Awaited<ReturnType<typeof throwRep>>[] = [];
      for (const seed of SEEDS) rs.push(await throwRep(k.wrs, k.dbs, k.to, k.db, seed));
      console.log(`${k.name.padEnd(30)}: closest hand ${f2(rs.map((r) => r.hand))} m (the receiver's ${f2(rs.map((r) => r.wrHand))}), touched ${rs.map((r) => +r.touched).join('')}, catch tries ${rs.map((r) => +r.tried).join('')}, broke on it ${f2(rs.map((r) => r.reacted))} s after the release; ` +
        `INT ${rs.filter((r) => r.int).length}, caught ${rs.filter((r) => r.caught).length}, incomplete ${rs.filter((r) => r.incomplete).length}`);
      for (const r of rs) {
        n++; if (r.hand < 0.5 || r.touched || r.tried) on++;
        expect(r.inst).toBe(0);
        expect(r.early).toBe(false); // not on the ball before it is thrown
        expect(r.reacted).toBeGreaterThan(DIFFICULTY.normal.reaction - 0.02);
        if (r.caught) expect(r.then).toBe('tackle');
        if (r.int) expect(r.then).toBe('carry');
      }
    }
    console.log(`a hand (within 0.5 m) or the body on the ball in ${on} of ${n} throws`);
    expect(on / n).toBeGreaterThanOrEqual(0.3);
  });
});
