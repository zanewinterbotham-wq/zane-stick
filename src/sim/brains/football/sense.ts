// Football sense shared by the football brains (docs/passing.md): where things are in the play's frame, who is open,
// whether a throwing lane is open, who can get where in time, where a ball comes down and who gets to it. Pure
// functions of the Perception, so every brain reads the field the same way. Unit tests: tests/football-sense.test.ts.
import { GAIT_SPEED } from '../../control/hand';
import { clamp, type Vec3 } from '../../math';
import { fallTime } from '../returner';
import { predict } from '../tackler';
import type { AthleteView, Perception } from '../types';
import type { PlayFrame } from './types';

/** A defensive back's top speed (m/s; NFL DBs ~9.8 at best, docs/realism-sources.md S4 max_sprint_speed_by_position:
 *  9 is a typical one, not the fastest) and his reach for a ball beside him (m, hand to COM along the ground). */
export const DB_SPEED = 9, REACH = 1;
/** His acceleration from a standstill (m/s², CarrierBrain's threat model: with DB_SPEED a 40 yd dash of ~4.6 s vs the
 *  combine DB mean 4.53 s, S4 nfl_combine_40yd_avg_by_position) and how long after the release he keeps running as
 *  he was before he breaks on the ball (s; assumption: a simple visual reaction is ~0.2 s, reading a throw a little
 *  longer). */
export const DB_ACCEL = 8, DB_REACT = 0.25;
/** openness: a time margin this long (s) or more over the ball is wide open (1). */
const OPEN_SPAN = 1;
const G = 9.81;

/** Depth downfield of the LOS (m) and world x of a point. */
export const rel = (f: PlayFrame, p: Vec3) => ({ depth: (p[2] - f.los) * f.dir, x: p[0] });
/** The world point at a depth downfield and world x (on the turf). */
export const toWorld = (f: PlayFrame, depth: number, x: number): Vec3 => [x, 0, f.los + f.dir * depth];

export const opponents = (p: Perception, self = p.self) => p.athletes.map((_, i) => i).filter((i) => p.athletes[i].team !== p.athletes[self].team);

const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

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

/** A ball in flight `t` s on (ballistic, no drag: the scene has none): where it is and how fast. */
export const ballAt = (b: { pos: Vec3; vel: Vec3 }, t: number): { pos: Vec3; vel: Vec3 } =>
  ({ pos: [b.pos[0] + b.vel[0] * t, b.pos[1] + b.vel[1] * t - G * t * t / 2, b.pos[2] + b.vel[2] * t], vel: [b.vel[0], b.vel[1] - G * t, b.vel[2]] });

// ---- the ball in the air, and getting to it (receivers and defensive backs alike)

/** A pass is in the air: the ball loose, above PASS_H m and flying faster than PASS_V m/s. */
const PASS_H = 0.3, PASS_V = 5;
export const inFlight = (p: Perception) => !!p.ball && !p.athletes.some((a) => a.hasBall) && p.ball.pos[1] > PASS_H && Math.hypot(...p.ball.vel) > PASS_V;

/** A ball is aimed (and its landing judged) at chest height (m). */
export const CATCH_H = 1.2;
/** A run's acceleration toward a ball (m/s², the sprint start's: GAIT_ACCEL) and top speed (m/s). */
const RUN_ACCEL = 6, FULL = GAIT_SPEED.sprint;
/** Time (s) to cover d m along the ground from v0 m/s along the way: `turn` s for a first step, then accelerating at
 *  RUN_ACCEL up to `vmax`. */
export function runTime(d: number, v0 = 0, vmax = FULL, turn = 0): number {
  if (d <= 0) return turn;
  const v = clamp(v0, 0, vmax), ta = (vmax - v) / RUN_ACCEL, da = (v + vmax) / 2 * ta;
  return turn + (d <= da ? (-v + Math.sqrt(v * v + 2 * RUN_ACCEL * d)) / RUN_ACCEL : ta + (d - da) / vmax);
}

/** Cuts: a turn sharper than PLANT_ANGLE rad is a plant cut, one plant takes up to JUKE_REACH / speed rad (the
 *  carrier's juke), slower than BREAK_V m/s a turn is a pivot; the rest of a turn is bent in at LAT m/s² sideways
 *  (~0.8 g: a receiver leans into his line harder than a pursuer's ~0.36 g turnRate). */
export const PLANT_ANGLE = 0.5, JUKE_REACH = 5, BREAK_V = 2.5, LAT = 8;
/** Extra time (s) to turn a run onto the way (dx, dz): what one plant cut cannot take is bent in at LAT m/s²; nothing
 *  standing or slow. */
export function turnTime(me: AthleteView, dx: number, dz: number): number {
  const sp = Math.hypot(me.comVel[0], me.comVel[2]), d = Math.hypot(dx, dz);
  if (sp <= BREAK_V || d < 1e-6) return 0;
  const th = Math.acos(clamp((me.comVel[0] * dx + me.comVel[2] * dz) / (sp * d), -1, 1));
  return Math.max(0, th - clamp(JUKE_REACH / sp, PLANT_ANGLE, 1.3)) * sp / LAT;
}

/** Playing a ball in flight: the look-ahead step (s); lower than LOW m it is on the turf for a catch; a jump adds
 *  JUMP_GAIN m of reach; a high point is taken over a comfortable one this much sooner (s); the arm's length from the
 *  shoulders (m). */
const STEP = 1 / 60, LOW = 0.4, JUMP_GAIN = 0.4, HIGH_FIRST = 0.3, ARM_R = 0.6;

/** Where a ball's flight first comes within `r` m (an arm's length) of shoulders at `sh` moving at `v` (ground),
 *  within 1.5 s (`exit`: where it leaves that reach: a ball from behind, dropping in front of him): the arms pointed
 *  there put the hands on its path. Its nearest approach if it never comes that close. */
export function handsPoint(b: { pos: Vec3; vel: Vec3 }, sh: Vec3, v: readonly number[], exit = false, r = ARM_R): Vec3 {
  let near: Vec3 = b.pos, nd = Infinity, last: Vec3 | null = null;
  for (let t = 0; t <= 1.5; t += STEP / 2) {
    const q = ballAt(b, t).pos, d = Math.hypot(q[0] - sh[0] - v[0] * t, q[1] - sh[1], q[2] - sh[2] - v[2] * t);
    if (d <= r) { if (!exit) return q; last = q; } else if (last) return last;
    if (d < nd) { nd = d; near = q; }
    else if (d > nd + 0.5) break; // going away
  }
  return last ?? near;
}

export interface Meet { at: Vec3; t: number; late: number; jump: boolean }
/** Where to meet a ball in flight: the earliest point of its flight he can get to (to an arm's length, `arm` m) in
 *  time from `me` at a height the hands take it running (`face`..LOW: the hands at the face or below); else the
 *  earliest within his reach above that (`reach`, hands at full stretch); else the earliest within a jump's `gain`
 *  above it (a high-point: `jump`); else the one he comes nearest to in time (`late` > 0 s: he cannot make it). */
export function meetPoint(b: { pos: Vec3; vel: Vec3 }, me: AthleteView, face: number, reach: number, gain = JUMP_GAIN, arm = 0.5): Meet | null {
  let best: Meet | null = null, high: Meet | null = null, top: Meet | null = null;
  for (let t = STEP; t < 4; t += STEP) {
    const q = ballAt(b, t).pos;
    if (q[1] < LOW) break;
    if (q[1] > reach + gain) continue;
    const dx = q[0] - me.com[0], dz = q[2] - me.com[2], d = Math.hypot(dx, dz);
    const v0 = d > 1e-6 ? (me.comVel[0] * dx + me.comVel[2] * dz) / d : 0, late = runTime(d - arm, v0) + turnTime(me, dx, dz) - t, jump = q[1] > reach;
    // a high point he can get to well before the comfortable one is taken there (he high-points it, before anyone
    // can undercut it), jumping if need be
    if (late <= 0 && q[1] <= face) return (high ?? top) && t - (high ?? top)!.t > HIGH_FIRST ? (high ?? top)! : { at: q, t, late, jump };
    if (late <= 0 && !jump) high ??= { at: q, t, late, jump };
    if (late <= 0) top ??= { at: q, t, late, jump };
    if (!best || late < best.late) best = { at: q, t, late, jump };
  }
  return high ?? top ?? best;
}

/** A defender's first step toward a ball (s), and the heights (m) a hand of his gets to one between, running. */
export const DB_TURN = 0.15, BALL_H: [number, number] = [0.35, 2.7];
/** Where a defender at `from` (moving at `vel`) gets a hand on a ball in flight: the earliest point of its flight
 *  (within BALL_H) he reaches in time (runTime at DB_SPEED after DB_TURN), and when (s); else (late: true) where it
 *  comes down through catch height. */
export function ballSpot(b: { pos: Vec3; vel: Vec3 }, from: Vec3, vel: Vec3 = [0, 0, 0]): { at: Vec3; t: number; late: boolean } {
  let last: { at: Vec3; t: number } | null = null;
  for (let t = 0; t < 4; t += 0.02) {
    const q = ballAt(b, t).pos;
    if (q[1] < BALL_H[0]) break;
    if (q[1] > BALL_H[1]) continue;
    last = { at: q, t };
    const dx = q[0] - from[0], dz = q[2] - from[2], d = Math.hypot(dx, dz) || 1e-9;
    if (runTime(Math.max(0, d - REACH), (vel[0] * dx + vel[2] * dz) / d, DB_SPEED, DB_TURN) <= t) return { ...last, late: false };
  }
  return { ...(last ?? { at: b.pos, t: 0 }), late: true };
}

/** Where a ball in flight comes down through height `h` (m; on the ground plane, world): where it is if it never
 *  does or already has. */
export function landing(b: { pos: Vec3; vel: Vec3 }, h = CATCH_H): Vec3 {
  const t = Math.max(0, fallTime(b.pos, b.vel, h));
  return [b.pos[0] + b.vel[0] * t, 0, b.pos[2] + b.vel[2] * t];
}

/** The pass is athlete i's to play (his team's: a receiver's to catch, a defender's to pick off or break up): no
 *  standing team mate is nearer where it comes down (landing). `keep` > 0: he had it, and keeps it unless one is
 *  `keep` m nearer; ties go to the lower index, so every team mate's view agrees. `from`: where i is (default: as p
 *  has him). */
export function passIsMine(p: Perception, b: { pos: Vec3; vel: Vec3 }, i: number, keep = 0, from: Vec3 = p.athletes[i].com): boolean {
  const l = landing(b), d = (c: Vec3) => Math.hypot(c[0] - l[0], c[2] - l[2]), dm = d(from), team = p.athletes[i].team;
  return p.athletes.every((a, j) => j === i || a.team !== team || a.down || (keep > 0 ? d(a.com) + keep > dm : d(a.com) > dm || (d(a.com) === dm && j > i)));
}

// ---- the passer: where the ball leaves, the rush, the lanes

/** The ball leaves the hand this far above the head's centre (m). */
const RELEASE_UP = 0.15;
/** Where the ball leaves a passer's hand (m). */
export const releasePoint = (me: AthleteView): Vec3 => [me.com[0], me.head[1] + RELEASE_UP, me.com[2]];

/** A rusher: an opponent closing faster than RUSH_CLOSE m/s, or within RUSH_NEAR m. */
const RUSH_CLOSE = 1.5, RUSH_NEAR = 3;
/** Time (s) opponent o needs to reach me if he is rushing me; else Infinity. */
function rushTime(me: AthleteView, o: AthleteView): number {
  if (o.down) return Infinity;
  const dx = me.com[0] - o.com[0], dz = me.com[2] - o.com[2], d = Math.hypot(dx, dz) || 1e-6;
  // his own speed at me: dropping away from a rusher does not make him less of one
  const close = (o.comVel[0] * dx + o.comVel[2] * dz) / d;
  return close > RUSH_CLOSE || d < RUSH_NEAR ? Math.max(0, d - REACH) / Math.max(close, RUSH_CLOSE) : Infinity;
}

/** The opponent rushing athlete i soonest (−1: none) and when he gets there (s; Infinity: never). */
export function nearestRush(p: Perception, i: number): { who: number; t: number } {
  let who = -1, t = Infinity;
  for (const j of opponents(p, i)) { const tj = rushTime(p.athletes[i], p.athletes[j]); if (tj < t) { t = tj; who = j; } }
  return { who, t };
}
export const sackTime = (p: Perception, i: number) => nearestRush(p, i).t;

/** Throwing lane: a defender this far (m) from the ball's ground path, plus how far he can break on it after his
 *  reaction (LANE_REACT s at LANE_BREAK m/s), stops it while it passes below DEF_REACH (m: a defender's raised hands
 *  and a jump). Defenders within LANE_END m of the catch point are the openness's concern, not the lane's. */
const LANE_R = 0.8, LANE_REACT = 0.3, LANE_BREAK = 5, DEF_REACH = 3.2, LANE_END = 2.5;
/** Whether a throw (launch velocity `vel`, flight `time` s, from → at) gets past every standing opponent of `team`:
 *  one near its ground path (with the break he makes on it before it passes) stops it while it is below his reach. A
 *  lob's arc clears underneath defenders. `ignore`: an athlete judged otherwise (the back-shoulder's man). */
export function laneOpen(p: Perception, from: Vec3, at: Vec3, vel: Vec3, time: number, team: 0 | 1, ignore = -1): boolean {
  const ax = at[0] - from[0], az = at[2] - from[2], L2 = ax * ax + az * az || 1e-9;
  return p.athletes.every((o, i) => {
    if (o.team === team || o.down || i === ignore || flat(o.com, at) < LANE_END) return true;
    const s = clamp(((o.com[0] - from[0]) * ax + (o.com[2] - from[2]) * az) / L2, 0, 1), t = s * time;
    const off = Math.hypot(from[0] + ax * s - o.com[0], from[2] + az * s - o.com[2]);
    const h = from[1] + vel[1] * t - G * t * t / 2;
    return off > LANE_R + LANE_BREAK * Math.max(0, t - LANE_REACT) || h > DEF_REACH;
  });
}

/** A man running one way who has to come back: he sees the change `react` s late and brakes at `decel` m/s² (~0.7 g). */
export const TURN_BACK = { react: 0.3, decel: 7 };
/** When opponent o, seeing it TURN_BACK.react s late, meets a runner leaving `from` at `vel` (s): running away from
 *  him (a man turned downfield with his receiver) he runs on and brakes to a stop first. */
export function chaseTime(o: AthleteView, from: Vec3, vel: Vec3): number {
  const { react, decel } = TURN_BACK, sp = Math.hypot(o.comVel[0], o.comVel[2]), away = o.comVel[0] * (from[0] - o.com[0]) + o.comVel[2] * (from[2] - o.com[2]) < 0;
  const run = away ? sp * react + sp * sp / (2 * decel) : 0, t0 = away ? react + sp / decel : react;
  const start: Vec3 = sp > 0.1 ? [o.com[0] + o.comVel[0] / sp * run, 0, o.com[2] + o.comVel[2] / sp * run] : o.com;
  const at: Vec3 = [from[0] + vel[0] * t0, 0, from[2] + vel[2] * t0];
  return t0 + Math.max(0, interceptTime(start, DB_SPEED, at, vel) - REACH / DB_SPEED);
}

/** An athlete's acceleration is read over ACC_DT s of what was seen, and believed up to ACC_MAX m/s² (a sprint
 *  start's ~6). */
export const ACC_DT = 0.1;
const ACC_MAX = 7;
/** Athlete `a` as seen, carried on `age` s with the velocity and the acceleration seen (`before`: him `dt` s earlier;
 *  without it, the velocity only, as predict): the eye reads a burst off the line or out of a break as well as a
 *  steady run; a change of either is what the reaction delay answers. */
export function carry(a: AthleteView, before: AthleteView | undefined, dt: number, age: number): AthleteView {
  if (!before || dt < 1e-3) return predict(a, age);
  let ax = (a.comVel[0] - before.comVel[0]) / dt, az = (a.comVel[2] - before.comVel[2]) / dt;
  const n = Math.hypot(ax, az);
  if (n > ACC_MAX) { ax *= ACC_MAX / n; az *= ACC_MAX / n; }
  const v: Vec3 = [a.comVel[0] + ax * age, a.comVel[1], a.comVel[2] + az * age], f = (x: Vec3): Vec3 => [x[0] + a.comVel[0] * age + ax * age * age / 2, x[1], x[2] + a.comVel[2] * age + az * age * age / 2];
  return { ...a, com: f(a.com), pelvis: f(a.pelvis), head: f(a.head), comVel: v };
}
