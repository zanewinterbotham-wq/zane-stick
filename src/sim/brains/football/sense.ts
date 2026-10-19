// Football sense shared by every football brain (docs/passing.md): where things are in the play's frame, who is
// open, whether a throwing lane is clear, who can get where in time, how a defender plays a receiver, where a zone
// is, man or zone. Pure functions of the Perception (plus Sight, the reaction delay every brain looks through), so
// every brain reads the field the same way. Unit tests: tests/football-sense.test.ts.
import type { Vec3 } from '../../math';
import { YD } from '../../modes/rules';
import { predict } from '../tackler';
import type { AthleteView, Perception } from '../types';
import type { PlayFrame, ZoneAssign } from './types';

/** A defensive back's top speed (m/s; NFL DBs ~9.8 at best, docs/realism-sources.md S4 max_sprint_speed_by_position:
 *  9 is a typical one, not the fastest) and his reach for a ball beside him (m, hand to COM along the ground). */
export const DB_SPEED = 9, REACH = 1;
/** His acceleration from a standstill (m/s², CarrierBrain's threat model: with DB_SPEED a 40 yd dash of ~4.6 s vs the
 *  combine DB mean 4.53 s, S4 nfl_combine_40yd_avg_by_position) and how long after the release he keeps running as
 *  he was before he breaks on the ball (s; assumption: a simple visual reaction is ~0.2 s, reading a throw a little
 *  longer). */
export const DB_ACCEL = 8, DB_REACT = 0.25;
/** Highest a defender gets a hand to a ball in flight (m): head centre ~1.7 m, the hands OVERHEAD (returner.ts) 0.5 m
 *  above it, and a jump's ~0.7 m COM rise (S4 jump table). */
export const HAND_REACH = 2.9;
/** openness: a time margin this long (s) or more over the ball is wide open (1). */
const OPEN_SPAN = 1;
const G = 9.81;

/** Depth downfield of the LOS (m) and world x of a point. */
export const rel = (f: PlayFrame, p: Vec3) => ({ depth: (p[2] - f.los) * f.dir, x: p[0] });
/** The world point at a depth downfield and world x (on the turf). */
export const toWorld = (f: PlayFrame, depth: number, x: number): Vec3 => [x, 0, f.los + f.dir * depth];

export const opponents = (p: Perception, self = p.self) => p.athletes.map((_, i) => i).filter((i) => p.athletes[i].team !== p.athletes[self].team);
export const mates = (p: Perception, self = p.self) => p.athletes.map((_, i) => i).filter((i) => i !== self && p.athletes[i].team === p.athletes[self].team);

const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Distance (m) from athlete i to the nearest standing opponent. */
export function separation(p: Perception, i: number): number {
  let d = Infinity;
  for (const j of opponents(p, i)) if (!p.athletes[j].down) d = Math.min(d, flat(p.athletes[i].com, p.athletes[j].com));
  return d;
}

/** Time (s) for a chaser at `from` running at `speed` to reach a target moving at `vel` from `at` (Infinity if never;
 *  ground plane). */
export function interceptTime(from: Vec3, speed: number, at: Vec3, vel: Vec3): number {
  const dx = at[0] - from[0], dz = at[2] - from[2], a = vel[0] ** 2 + vel[2] ** 2 - speed ** 2, b = 2 * (dx * vel[0] + dz * vel[2]), c = dx * dx + dz * dz;
  if (Math.abs(a) < 1e-9) return b < 0 ? -c / b : c === 0 ? 0 : Infinity;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const r = [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)].filter((t) => t >= 0);
  return r.length ? Math.min(...r) : Infinity;
}

/** Pursuit angle: where to run (`point`, on the turf), the heading to it (rad, 0 = +Z as AthleteView.heading) and when
 *  he gets there (`time`, s: interceptTime, Infinity if never) for a chaser at `from` at `speed` after a target at
 *  `at` moving at `vel`. A target he cannot catch is led `maxLead` s (s), as TacklerBrain does. */
export function pursuit(from: Vec3, speed: number, at: Vec3, vel: Vec3, maxLead = 2.5): { time: number; point: Vec3; heading: number } {
  const time = interceptTime(from, speed, at, vel), t = Math.min(time, maxLead);
  const point: Vec3 = [at[0] + vel[0] * t, 0, at[2] + vel[2] * t];
  return { time, point, heading: Math.atan2(point[0] - from[0], point[2] - from[2]) };
}

/** Time (s) for an athlete at `from` moving at `vel` to get within `reach` of the ground point `to`: for `react` s he
 *  carries on as he was going (he has not seen the ball yet), then runs straight at it, accelerating at DB_ACCEL from
 *  his speed along the way to it (stopping first if he was going away) up to DB_SPEED (or his own speed, if faster).
 *  shortcut: his speed across the way to it is ignored (no turn time), so a man running across the spot is a little
 *  early; good enough to rank defenders, revisit if a brain needs exact cuts. */
export function reachTime(from: Vec3, vel: Vec3, to: Vec3, react = DB_REACT, reach = REACH): number {
  // still coasting: the first time his straight line comes within reach
  const rx = from[0] - to[0], rz = from[2] - to[2], a = vel[0] ** 2 + vel[2] ** 2, b = 2 * (rx * vel[0] + rz * vel[2]), c = rx * rx + rz * rz - reach * reach;
  if (c <= 0) return 0;
  const disc = b * b - 4 * a * c;
  if (a > 1e-9 && disc >= 0) { const t = (-b - Math.sqrt(disc)) / (2 * a); if (t >= 0 && t <= react) return t; }
  const px = rx + vel[0] * react, pz = rz + vel[2] * react, d = Math.hypot(px, pz);
  let s = d - reach, u = d > 1e-9 ? -(vel[0] * px + vel[2] * pz) / d : 0, t = react;
  if (s <= 0) return react;
  if (u < 0) { t += -u / DB_ACCEL; s += u * u / (2 * DB_ACCEL); u = 0; }
  const vmax = Math.max(DB_SPEED, u), sv = (vmax * vmax - u * u) / (2 * DB_ACCEL);
  return t + (s <= sv ? (-u + Math.sqrt(u * u + 2 * DB_ACCEL * s)) / DB_ACCEL : (vmax - u) / DB_ACCEL + (s - sv) / vmax);
}

/** How open a target is for a ball arriving at `at` in `tFlight` s: 0 (a defender gets there first) .. 1 (nobody
 *  within reach): the time margin of the quickest standing defender over the ball (reachTime: his closing speed and
 *  the way he is running count, and he breaks on the ball only DB_REACT s after the throw), mapped over 0..1 s. */
export function openness(p: Perception, target: number, at: Vec3, tFlight: number): number {
  let margin = Infinity;
  for (const j of opponents(p, target)) {
    const d = p.athletes[j];
    if (!d.down) margin = Math.min(margin, reachTime(d.com, d.comVel, at) - tFlight);
  }
  return Math.max(0, Math.min(1, margin / OPEN_SPAN));
}

/** openness with the ball meeting the target where he will be in `tFlight` s at his own velocity (a receiver
 *  running away from a trailing man opens, one running back into an undercutting man closes). */
export function opennessLed(p: Perception, target: number, tFlight: number): number {
  const r = p.athletes[target];
  return openness(p, target, [r.com[0] + r.comVel[0] * tFlight, r.com[1], r.com[2] + r.comVel[2] * tFlight], tFlight);
}

/** Launch velocity (m/s) that carries a ball from `from` to `at` in `time` s (gravity only). */
export const ballVel = (from: Vec3, at: Vec3, time: number): Vec3 => [(at[0] - from[0]) / time, (at[1] - from[1]) / time + G * time / 2, (at[2] - from[2]) / time];
/** Where a ball launched from `from` at `vel` is after t s. */
export const ballAt = (from: Vec3, vel: Vec3, t: number): Vec3 => [from[0] + vel[0] * t, from[1] + vel[1] * t - G * t * t / 2, from[2] + vel[2] * t];
/** Samples of a throw's flight (s) the lane checks look at; the last is the catch. */
const LANE_SAMPLES = 24;

/** No standing opponent of `team` within `radius` (m) of the ball's path from → to (ground plane; the arc's height is
 *  the caller's concern: a lob clears underneath defenders: arcClear). */
export function laneClear(p: Perception, from: Vec3, to: Vec3, team: 0 | 1, radius = 1): boolean {
  const ax = to[0] - from[0], az = to[2] - from[2], L2 = ax * ax + az * az || 1e-9;
  return p.athletes.every((o: AthleteView) => {
    if (o.team === team || o.down) return true;
    const t = Math.max(0, Math.min(1, ((o.com[0] - from[0]) * ax + (o.com[2] - from[2]) * az) / L2));
    return Math.hypot(from[0] + ax * t - o.com[0], from[2] + az * t - o.com[2]) > radius;
  });
}

/** The lane for a throw from → at taking `tFlight` s (a bullet is quick and flat, a lob slow and high): no standing
 *  opponent of `team`, where he stands now, within `radius` (m) of the ball's ground path where the ball is low
 *  enough to get a hand to (below HAND_REACH). The catch point itself is openness's concern, so the last `radius` m
 *  of the path are left to it. */
export function arcClear(p: Perception, from: Vec3, at: Vec3, tFlight: number, team: 0 | 1, radius = REACH): boolean {
  const v = ballVel(from, at, tFlight), L = flat(from, at);
  for (let k = 1; k < LANE_SAMPLES; k++) {
    const t = tFlight * k / LANE_SAMPLES, b = ballAt(from, v, t);
    if (b[1] > HAND_REACH || L * (1 - k / LANE_SAMPLES) < radius) continue;
    for (const o of p.athletes) if (o.team !== team && !o.down && flat(o.com, b) <= radius) return false;
  }
  return true;
}

/** The throwing window for a throw from → at in `tFlight` s by `team`: the least time margin (s) any standing
 *  opponent has over the ball, anywhere along its flight where it is below HAND_REACH, the catch included (reachTime:
 *  where he is, how he is running, his reaction to the throw). `margin` < 0: he gets a hand to it first (`by`, at
 *  `t` s into the flight); Infinity: nobody can. A defender undercutting the route meets the ball on its way; one
 *  trailing the receiver has to get to the catch point. */
export function throwWindow(p: Perception, from: Vec3, at: Vec3, tFlight: number, team: 0 | 1): { margin: number; by: number; t: number } {
  const v = ballVel(from, at, tFlight), r = { margin: Infinity, by: -1, t: NaN };
  for (let k = 1; k <= LANE_SAMPLES; k++) {
    const t = tFlight * k / LANE_SAMPLES, b = ballAt(from, v, t);
    if (k < LANE_SAMPLES && b[1] > HAND_REACH) continue;
    p.athletes.forEach((o, j) => {
      if (o.team === team || o.down) return;
      const m = reachTime(o.com, o.comVel, b) - t;
      if (m < r.margin) { r.margin = m; r.by = j; r.t = t; }
    });
  }
  return r;
}

/** Pressure on athlete i: 0 (nobody within 4 m) .. 1 (an opponent on him), from the nearest standing opponent. */
export const pressure = (p: Perception, i: number) => Math.max(0, Math.min(1, (4 - separation(p, i)) / 3));

/** Pressure from any direction: standing opponents within `radius` (m) of athlete i (`count`), the nearest of them
 *  (`nearest`, −1 if none; `dist` m), how fast he closes (m/s), when he gets there at that (s; Infinity if he is not
 *  closing), and where from (rad, the bearing in i's own frame: 0 dead ahead, ±π behind him, + to his left). */
export function pressureOn(p: Perception, i: number, radius = 4): { count: number; nearest: number; dist: number; closing: number; ttc: number; from: number } {
  const me = p.athletes[i], r = { count: 0, nearest: -1, dist: Infinity, closing: 0, ttc: Infinity, from: 0 };
  for (const j of opponents(p, i)) {
    const o = p.athletes[j], d = flat(me.com, o.com);
    if (o.down || d > radius) continue;
    r.count++;
    if (d >= r.dist) continue;
    const dx = o.com[0] - me.com[0], dz = o.com[2] - me.com[2], n = d || 1e-9;
    r.nearest = j; r.dist = d;
    r.closing = -((o.comVel[0] - me.comVel[0]) * dx + (o.comVel[2] - me.comVel[2]) * dz) / n;
    r.ttc = r.closing > 1e-6 ? d / r.closing : Infinity;
    // bearing relative to his heading (0 = +Z); +X is the left of someone facing +Z (rules.side)
    r.from = Math.atan2(Math.sin(Math.atan2(dx, dz) - me.heading), Math.cos(Math.atan2(dx, dz) - me.heading));
  }
  return r;
}

/** How defender d plays receiver r in the play frame: `inside` (m) how far he is to the inside (toward world x
 *  `mid`, the ball or the field's middle; − outside), `depth` (m) how far deeper downfield than the receiver he is
 *  (over the top, behind him as the QB sees it; − in front of him, underneath), and the words for both (head-up within
 *  HEAD_UP m). */
export function leverage(f: PlayFrame, d: AthleteView, r: AthleteView, mid = 0): { inside: number; depth: number; side: 'inside' | 'outside' | 'head-up'; over: boolean } {
  const out = Math.sign(r.com[0] - mid) || 1, inside = (r.com[0] - d.com[0]) * out, depth = rel(f, d.com).depth - rel(f, r.com).depth;
  return { inside, depth, side: Math.abs(inside) < HEAD_UP ? 'head-up' : inside > 0 ? 'inside' : 'outside', over: depth > 0 };
}
const HEAD_UP = 0.5;

/** Zone landmarks: the spot a zone defender drops to (world, on the turf) and the radius (m) of the area he owns, for
 *  a zone and side in the play frame (side +1 the offense's left: world +x when it attacks +z). Depths are coaching
 *  convention, not measurement (typical NFL Cover 2 / 3 / 4 teaching): flat 6 yd at the numbers, hook 10 yd at the
 *  hash, curl 12 yd between hash and numbers, the middle hole 12 yd, deep thirds 15 yd (centred in each third of the
 *  width), deep halves 18 yd (each half's middle), deep quarters 12 yd (a quarter's middle: the outside quarter
 *  unless `inside`; side 0: the middle of the field). Field markings (NFL): hashes 18 ft 6 in apart, numbers ~8 yd in
 *  from the sideline (their tops 9 yd in). */
export function zoneSpot(f: PlayFrame, z: ZoneAssign): { at: Vec3; radius: number } {
  const W = f.halfWidth, hash = 9.25 / 3 * YD, numbers = W - 8 * YD, s = z.side * f.dir;
  const [depth, x, radius]: [number, number, number] =
    z.zone === 'flat' ? [6 * YD, numbers, 5 * YD]
    : z.zone === 'hook' ? [10 * YD, hash, 5 * YD]
    : z.zone === 'curl' ? [12 * YD, (hash + numbers) / 2, 5 * YD]
    : z.zone === 'middle' ? [12 * YD, 0, 6 * YD]
    : z.zone === 'deep-third' ? [15 * YD, 2 * W / 3, W / 3]
    : z.zone === 'deep-half' ? [18 * YD, W / 2, W / 2]
    : [12 * YD, z.side === 0 ? 0 : z.inside ? W / 4 : 3 * W / 4, W / 4];
  return { at: toWorld(f, depth, s * x), radius };
}

/** Man or zone? From what a reader saw of defender d since the snap (`seen`, oldest first, over about the first
 *  second): in man he runs with one receiver (his velocity follows that man's, way and speed, and the gap does not
 *  grow); in zone he drops to a spot whoever runs where. `fit` per offensive athlete: the mean, while the receiver runs
 *  (> 1 m/s), of their velocities' dot product over the larger speed squared (1 the same velocity, 0.25 half the speed
 *  his way, < 0 opposite), less a quarter per m the gap grew; man (on `target`) when the best fit reaches MAN_FIT. A
 *  deep zone defender who turns and runs with a go route reads as man: as it does to a real QB. */
export function readCoverage(seen: readonly Perception[], d: number): { kind: 'man' | 'zone'; target: number; fit: number } {
  const r = { kind: 'zone' as 'man' | 'zone', target: -1, fit: -Infinity };
  if (seen.length < 2) return r;
  const first = seen[0], last = seen[seen.length - 1];
  for (const i of opponents(first, d)) {
    let sum = 0, n = 0;
    for (const p of seen) {
      const a = p.athletes[d].comVel, b = p.athletes[i].comVel, vb = Math.hypot(b[0], b[2]);
      if (vb < 1) continue;
      sum += (a[0] * b[0] + a[2] * b[2]) / Math.max(vb, Math.hypot(a[0], a[2])) ** 2; n++;
    }
    if (!n) continue;
    const grew = flat(last.athletes[d].com, last.athletes[i].com) - flat(first.athletes[d].com, first.athletes[i].com);
    const fit = sum / n - Math.max(0, grew) / 4;
    if (fit > r.fit) { r.fit = fit; r.target = i; }
  }
  if (r.fit >= MAN_FIT) r.kind = 'man';
  return r;
}
const MAN_FIT = 0.6;

/** What a brain sees: the Perception as it was `reaction` s ago, every other athlete carried on at his seen velocity
 *  to now (TacklerBrain's predict: the delay is the time to answer a change, not a lag on steady motion) and the ball
 *  too (on a ballistic arc when it is loose, never below the turf), and himself as he is now. Feed it every step. */
export class Sight {
  private history: Perception[] = [];
  constructor(public reaction: number) {}
  /** The raw snapshot behind the last see() (as it was, not carried on). */
  get seen(): Perception | undefined { return this.history[0]; }
  see(p: Perception): Perception {
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.reaction) this.history.shift();
    const s = this.history[0], age = p.time - s.time;
    let ball = s.ball;
    if (ball && age > 0) {
      const g = s.athletes.some((a) => a.hasBall) ? 0 : G, b = ball, at = (k: number) => b.pos[k] + b.vel[k] * age;
      ball = { pos: [at(0), Math.max(0, at(1) - g * age * age / 2), at(2)], vel: [b.vel[0], b.vel[1] - g * age, b.vel[2]] };
    }
    return { ...s, time: p.time, self: p.self, athletes: s.athletes.map((a, i) => (i === p.self ? p.athletes[i] : predict(a, age))), ball };
  }
}
