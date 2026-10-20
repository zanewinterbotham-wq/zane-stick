// Bot quarterback (docs/passing.md "AI built for 11 on 11"): plays his `pass` assignment. He takes the drop (0/3/5/7
// steps: a back-pedal for 3, turn and run for 5 and 7) and sets his feet, then reads the progression in order on its
// clock (Read.by): each read is scored by the target's openness at the lead point (against every defender, at the
// throw's flight time), the throwing lane (a bullet's flat path or a lob's arc over an underneath defender) and the key
// defender's leverage, and thrown with the loft the window wants (bullet, touch, lob, or back-shoulder against a man on
// his hip). Quick pressure: the hot route. Progression covered: the checkdown. In the pocket he steps up against edge
// pressure and slides away from it; flushed, he scrambles through a lane past the LOS or rolls out toward the sideline
// and throws on the run; late with nothing open he throws it away beyond the sideline. He never throws to a covered man
// unless a rusher is on him. Reads the Perception through a reaction delay (as TacklerBrain); difficulty is only read
// speed, the precision of his lead, and nerves under pressure. Same Commands as a human (Commands.pass).
import { qbTuning, type QbTuning } from './qbTuning';
import { GAIT_SPEED } from '../../control/hand';
import { neutralCommands, type Commands, type PassCmd } from '../../control/types';
import { clamp, wrapAngle, type Vec3 } from '../../math';
import type { Rng } from '../../rng';
import { leadPoint, THROW, throwVelocity } from '../../throw';
import { CarrierBrain, type BotDifficulty } from '../carrier';
import { predict, TacklerBrain, turnRate } from '../tackler';
import type { AthleteView, Brain, Perception } from '../types';
import { ballAt, BREAK_V, carry, CATCH_H, chaseTime, JUKE_REACH, PLANT_ANGLE, DB_SPEED, laneOpen, nearestRush, openness, opponents, REACH, releasePoint, rel, sackTime, toWorld, TURN_BACK } from './sense';
import { routePath, type RoutePath } from './routes';
import type { PassAssign, PlayCall } from './types';

const FULL = GAIT_SPEED.sprint, MOVE_TAU = 0.08;
/** Drop depth behind the QB's start (m) per drop: a 3-step from under centre sets at ~5 yd, a 5-step ~7, a 7-step ~9. */
export const DROP_DEPTH: Record<PassAssign['drop'], number> = { 0: 0, 3: 3.5, 5: 5.5, 7: 7.5 };
/** Drop speed (m/s): a back-pedal, and turning and running; it brakes into the set at DROP_BRAKE m/s². Feet set for
 *  SET s at the top of a drop before the first read. */
const BACKPEDAL_V = 4.5, TURN_RUN_V = 6, DROP_BRAKE = 5, SET = 0.2;
/** Loft per window: a bullet, touch, a lob; each unit of loft costs LOFT_COST of openness (a softer ball hangs, and
 *  is harder to place). */
const LOFTS: [number, ThrowKind][] = [[0, 'bullet'], [0.45, 'touch'], [0.85, 'lob']], LOFT_COST = 0.08;
/** Openness he throws into (0..1, sense.openness: s of margin over the quickest defender); the hot route and the
 *  checkdown are taken a little tighter. Measured on the whole-play tests (tests/qb-plays.test.ts, 2 v 2, 4 sweeps of 48
 *  plays at OPEN 0..0.3, every bot at easy/normal/hard): of 17 throws under 0.3 none was completed (one picked off);
 *  0.3–0.6 17 % and over 0.6 37 % were. */
export const OPEN = 0.3, HOT_K = 0.5, CHECK_K = 0.7;
/** Key defender: ahead of the receiver along his run within LEVER m, he has leverage on the route (openness × LEVER_K);
 *  the ball is placed KEY_AWAY m to the side away from him. */
const LEVER = 3, LEVER_K = 0.5, KEY_AWAY = 0.4;
/** The longest pass he throws (m along the ground, ~55 yd: NFL passes of 50+ air yards are about 1 % of attempts;
 *  assumption, a deep ball's practical range, not the arm's 74 m). */
const MAX_THROW = 50;
/** A lead is settled when the receiver's spot at the ball's arrival is within LEAD_TOL m of where it is thrown. */
const LEAD_TOL = 0.5;
/** Back-shoulder: a receiver deeper than depth (m), running downfield faster than run (m/s), a man within tight m on
 *  his hip (not over the top). Both brake at decel m/s² (~0.7 g); the receiver needs turn s more to turn to the ball,
 *  which comes side m to the side away from the man; the man starts braking react s after the receiver. */
const BS = { depth: 10, run: 5, tight: 2.5, side: 0.8, decel: TURN_BACK.decel, turn: 0.15, react: TURN_BACK.react };
/** A rusher (sense.nearestRush: an opponent closing on him, or near) reaches him in sackTime s.
 *  Below HOT_T the hot route is thrown; below POCKET_T he moves in the pocket; below ESCAPE_T he leaves it (scramble
 *  or roll out); below FORCED_T a rusher is on him: he throws to the best man even if covered, or throws it away. */
const HOT_T = 1.6, POCKET_T = 1.4, ESCAPE_T = 0.8, FORCED_T = 0.35;
/** Scramble: his run speed (m/s), a lane is open when nobody meets him before LOS + SCRAMBLE_GAIN m by SCRAMBLE_MARGIN s
 *  (each seeing it late and braking first if running away, as a back-shoulder man: chaseTime); headings tried off
 *  straight downfield (rad). */
const SCRAMBLE_V = 7, SCRAMBLE_GAIN = 3, SCRAMBLE_MARGIN = 0.3, SCRAMBLE_OFFS = [0, -0.2, 0.2, -0.45, 0.45, -0.7, 0.7, -0.95, 0.95];
/** Pocket: he stays this far (m) behind the LOS when stepping up; rolls out at ROLL_V m/s. */
const POCKET_LOS = 2, POCKET_V = 2.5, ROLL_V = 6;
/** Throw it away: this far (m) beyond the sideline, this far downfield of him. With nothing open LATE s after the last
 *  read's time he throws it away. */
const AWAY_OUT = 8, AWAY_DOWN = 6, LATE = 1;
/** Difficulty: a read takes LOOK + LOOK_K × reaction s; the lead's error is noise × (AIM_0 + AIM_D × distance) m, ×
 *  (1 + NERVES × pressure); each read is misjudged by a gaussian of noise × MISREAD on the openness he throws into
 *  (drawn once per read: a misread is a read, not a flicker). */
// (the numbers are QbTuning's: qbTuning.ts, tunable; these docs name its knobs look, lookK, aim, aimPerM, nerves, misread)
/** A run's change (a burst out of a break) is read over RUN_DT s of what he saw (sense.carry): a stride or more, so
 *  the speed's rise and fall within a stride does not read as one. */
const RUN_DT = 0.3;

export type ThrowKind = 'bullet' | 'touch' | 'lob' | 'back-shoulder' | 'away';
/** A throw decision: the receiver (−1 thrown away), where and how high, its openness, the time from the decision to
 *  the catch (s: the throwing motion's THROW.release and the flight), and which read it came from (index into reads;
 *  −1 the hot route, −2 the checkdown, −3 thrown away). */
export interface ThrowChoice { target: number; at: Vec3; loft: number; kind: ThrowKind; open: number; time: number; read: number }
export type QBPhase = 'pre' | 'drop' | 'read' | 'scramble' | 'thrown';
/** What the bot QB commanded (tests, HUD): the choice, the PassCmd sent (lead noise included), the sim time. */
export interface PassRecord extends ThrowChoice { cmd: PassCmd; t: number; from: Vec3 }

const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const passAssign = (call: PlayCall, self: number) => { const a = call.assign[self]; return a && a.kind === 'pass' ? a : null; };

/** The route paths a QB knows (routes.ts, drawn from where each receiver lined up at the snap), by athlete index. */
export type KnownRoutes = readonly (RoutePath | null | undefined)[];
/** A receiver more than OFF_ROUTE m off his drawn path is adjusting (a release, an option read): led on his velocity. */
const OFF_ROUTE = 2;
/** Which leg he is on: the nearest, with ALIGN m added per unit of (1 − cos) between his run and the leg. */
const ALIGN = 2;
/** How a receiver runs his route (ReceiverBrain's plan, fitted to it: the route tree run by the bot receiver, 22 runs,
 *  predicted 0.8–1.6 s ahead from 0.5–2.9 s after the snap: RMS 0.59 m off where he got to, vs 3.83 m for a lead on
 *  his velocity): he picks up at RUN_A m/s² on the stem and RUN_A2 out of a break, to FULL; brakes at RUN_DECEL m/s² for
 *  a plant at a corner sharper than PLANT_ANGLE, taken at JUKE_REACH / turn m/s (at least BREAK_V) and costing
 *  PLANT_T s (the cut's settle). Stepped STEP_T s. */
const RUN_A = 5, RUN_A2 = 4, RUN_DECEL = 4, PLANT_T = 0.3, STEP_T = 0.05;
/** Where a receiver on route `path` will be `t` s on (a throw on timing: to the spot the route takes him, not where
 *  his run was heading, so a break or a curl after the throw is led): from the nearest point of it to him, run as he
 *  runs it, stopped at a settling route's end. Null when he is off it (OFF_ROUTE). */
export function alongRoute(path: RoutePath, r: AthleteView, t: number): Vec3 | null {
  const P = path.pts, sp = Math.hypot(r.comVel[0], r.comVel[2]);
  let k = -1, u = 0, best = Infinity;
  for (let n = 1; n < P.length; n++) {
    const a = P[n - 1], b = P[n], sx = b[0] - a[0], sz = b[2] - a[2], L2 = sx * sx + sz * sz || 1e-9;
    const w = clamp(((r.com[0] - a[0]) * sx + (r.com[2] - a[2]) * sz) / L2, 0, 1), d = Math.hypot(a[0] + sx * w - r.com[0], a[2] + sz * w - r.com[2]);
    // at a corner the leg he is running along is his (not the next one before he has cut onto it)
    const cost = d + (sp > 2 ? ALIGN * (1 - (r.comVel[0] * sx + r.comVel[2] * sz) / (sp * Math.sqrt(L2))) : 0);
    if (d < OFF_ROUTE && cost < best) { best = cost; k = n; u = w; }
  }
  if (k < 0) return null;
  // the plant speed at corner n (Infinity: no plant there)
  const plantV = (n: number) => {
    if (n >= P.length - 1) return path.settle ? 0 : Infinity;
    const a = P[n - 1], b = P[n], c = P[n + 1], turn = Math.abs(wrapAngle(Math.atan2(c[0] - b[0], c[2] - b[2]) - Math.atan2(b[0] - a[0], b[2] - a[2])));
    return turn > PLANT_ANGLE ? Math.max(BREAK_V, Math.min(FULL, JUKE_REACH / turn)) : Infinity;
  };
  let along = u * flat(P[k - 1], P[k]), v = Math.hypot(r.comVel[0], r.comVel[2]), acc = k > path.brk ? RUN_A2 : RUN_A;
  for (let time = 0; time < t - 1e-9;) {
    const h = Math.min(STEP_T, t - time), L = flat(P[k - 1], P[k]), left = L - along, vb = plantV(k);
    const cap = Math.min(FULL, Math.sqrt(Math.min(vb, FULL) ** 2 + 2 * RUN_DECEL * Math.max(0, left)));
    v = v < cap ? Math.min(cap, v + acc * h) : Math.max(cap, v - RUN_DECEL * h);
    along += v * h; time += h;
    if (along >= L) {
      if (k < P.length - 1) { along -= L; k++; v = Math.min(v, vb); if (vb < Infinity) { time += PLANT_T; acc = RUN_A2; } }
      else if (path.settle) { along = L; v = 0; }
    }
  }
  const a = P[k - 1], b = P[k], L = flat(a, b) || 1e-9, w = along / L;
  return [a[0] + (b[0] - a[0]) * w, CATCH_H, a[2] + (b[2] - a[2]) * w];
}


/** The best throw to `target` (any loft whose lane is open, and a back-shoulder ball when it fits), scored by openness
 *  at the ball's arrival less the loft's cost; null if he is down, out of bounds or no lane is open. */
export function bestThrow(seen: Perception, call: PlayCall, self: number, target: number, read: number, key?: number, routes?: KnownRoutes): ThrowChoice | null {
  // the ball leaves the hand THROW.release s from now (the throwing motion): everyone is judged where he will be then
  const p: Perception = { ...seen, athletes: seen.athletes.map((a) => predict(a, THROW.release)) };
  const me = p.athletes[self], r = p.athletes[target], f = call.frame;
  if (!r || r.down || target === self) return null;
  const from = releasePoint(me), pos: Vec3 = [r.com[0], CATCH_H, r.com[2]];
  const k = key !== undefined ? p.athletes[key] : undefined;
  // the key's leverage: ahead of the receiver along his run, he sits on the route; the ball goes to the side away from him
  let lever = 1, away: [number, number] = [0, 0];
  if (k && !k.down) {
    const rs = Math.hypot(r.comVel[0], r.comVel[2]), kx = k.com[0] - r.com[0], kz = k.com[2] - r.com[2], kd = Math.hypot(kx, kz) || 1e-6;
    if (rs > 1 && kd < LEVER && (kx * r.comVel[0] + kz * r.comVel[2]) / rs > 0) lever = LEVER_K;
    away = [-kx / kd * KEY_AWAY, -kz / kd * KEY_AWAY];
  }
  const inBounds = (at: Vec3) => Math.abs(at[0]) < p.field.halfWidth - 0.5;
  let best: ThrowChoice | null = null;
  const consider = (at: Vec3, loft: number, kind: ThrowKind, open0 = (at: Vec3, T: number) => openness(p, target, at, T), ignore = -1) => {
    if (!inBounds(at)) return;
    const { vel, time } = throwVelocity(from, at, loft), end = ballAt({ pos: from, vel }, time).pos;
    // beyond the arm (it would fall short) or his deep range, or no lane
    if (flat(from, at) > MAX_THROW || Math.hypot(end[0] - at[0], end[1] - at[1], end[2] - at[2]) > LEAD_TOL || !laneOpen(p, from, at, vel, time, me.team, ignore)) return;
    const open = open0(at, time) * lever - LOFT_COST * loft;
    if (!best || open > best.open) best = { target, at, loft, kind, open, time: THROW.release + time, read };
  };
  // the lead: on his route if he is on it (where it takes him by the catch, the motion's time included), else on his run
  const path = routes?.[target], r0 = seen.athletes[target];
  const lead = (loft: number): Vec3 | null => {
    let at = path ? alongRoute(path, r0, THROW.release) : null;
    const where = (T: number) => (at && path ? alongRoute(path, r0, THROW.release + T) : null) ?? [pos[0] + r.comVel[0] * T, CATCH_H, pos[2] + r.comVel[2] * T] as Vec3;
    at ??= leadPoint(from, { pos, vel: r.comVel }, loft, 0);
    for (let n = 0; n < 8; n++) at = where(throwVelocity(from, at, loft).time);
    // a lead that has not settled (a soft ball chasing a receiver as fast as it: beyond the arm) is no throw
    return flat(where(throwVelocity(from, at, loft).time), at) < LEAD_TOL ? at : null;
  };
  for (const [loft, kind] of LOFTS) {
    const at = lead(loft);
    if (at) consider([at[0] + away[0], at[1], at[2] + away[1]], loft, kind);
  }
  // back-shoulder: a deep receiver with a man on his hip (not over the top). He stops (he knows when) and the ball meets
  // him there, to the side away from the man, who sees it late (BS.react) and runs on past before he can come back.
  const rs = Math.hypot(r.comVel[0], r.comVel[2]), run = r.comVel[2] * f.dir, depth = rel(f, r.com).depth;
  let man = -1, md = BS.tight;
  for (const j of opponents(p, target)) if (!p.athletes[j].down && flat(p.athletes[j].com, r.com) < md) { md = flat(p.athletes[j].com, r.com); man = j; }
  if (man >= 0 && depth > BS.depth && run > BS.run && (p.athletes[man].com[2] - r.com[2]) * f.dir < 0.5) {
    const m = p.athletes[man], ux = r.comVel[0] / rs, uz = r.comVel[2] / rs, side = Math.sign(r.com[0] - m.com[0]) || Math.sign(r.com[0]) || 1;
    const stopR = rs * rs / (2 * BS.decel), at: Vec3 = [pos[0] + ux * stopR + side * BS.side, CATCH_H, pos[2] + uz * stopR];
    // the softest throw that gets there no sooner than he has stopped and turned
    let loft = 0;
    while (loft < 1 && throwVelocity(from, at, loft).time < rs / BS.decel + BS.turn) loft += 0.05;
    const ms = Math.max(0, m.comVel[0] * ux + m.comVel[2] * uz), runM = ms * BS.react + ms * ms / (2 * BS.decel);
    const stopM: Vec3 = [m.com[0] + ux * runM, m.com[1], m.com[2] + uz * runM], tM = BS.react + ms / BS.decel;
    const rest = { ...p, athletes: p.athletes.map((a, i) => (i === man ? { ...a, down: true } : a)) };
    consider(at, Math.min(1, loft), 'back-shoulder', (at, T) => Math.min(openness(rest, target, at, T), clamp(tM + Math.max(0, flat(stopM, at) - REACH) / DB_SPEED - T, 0, 1)), man);
  }
  return best;
}

/** Options for chooseTarget: the reads looked at (from..to, indices into reads; past the last read: the checkdown),
 *  the openness he throws into, and the rush (sackTime, computed if absent). */
export interface ReadOpts { from?: number; to?: number; minOpen?: number; heat?: number; routes?: KnownRoutes }

/** The throw the QB makes now, or null: under quick pressure the hot route; else the first open read of the
 *  progression from..to (a covered read is skipped); with the progression exhausted, the checkdown. Never a covered
 *  man (minOpen 0 is the caller forcing it). */
export function chooseTarget(p: Perception, call: PlayCall, self: number, o: ReadOpts = {}): ThrowChoice | null {
  const a = passAssign(call, self);
  if (!a) return null;
  const minOpen = o.minOpen ?? OPEN, heat = o.heat ?? sackTime(p, self), n = a.reads.length;
  if (a.hot !== undefined && heat < HOT_T) {
    const h = bestThrow(p, call, self, a.hot, -1, undefined, o.routes);
    if (h && h.open >= minOpen * HOT_K) return h;
  }
  const from = o.from ?? 0, to = o.to ?? n;
  for (let i = Math.max(0, from); i <= Math.min(to, n - 1); i++) {
    const t = bestThrow(p, call, self, a.reads[i].target, i, a.reads[i].key, o.routes);
    if (t && t.open >= minOpen) return t;
  }
  if (to >= n && a.checkdown !== undefined) {
    const t = bestThrow(p, call, self, a.checkdown, -2, undefined, o.routes);
    if (t && t.open >= minOpen * CHECK_K) return t;
  }
  return null;
}

/** The best throw to anyone on the call (forced: open or not), or null if no lane. */
export function forcedTarget(p: Perception, call: PlayCall, self: number, routes?: KnownRoutes): ThrowChoice | null {
  const a = passAssign(call, self);
  if (!a) return null;
  let best: ThrowChoice | null = null;
  const ts = [...a.reads.map((r, i) => [r.target, i, r.key] as const), ...(a.hot !== undefined ? [[a.hot, -1, undefined] as const] : []), ...(a.checkdown !== undefined ? [[a.checkdown, -2, undefined] as const] : [])];
  for (const [t, i, k] of ts) { const c = bestThrow(p, call, self, t, i, k, routes); if (c && (!best || c.open > best.open)) best = c; }
  return best;
}

/** Throw it away: far beyond the nearer sideline (the other one if an opponent is in that lane), downfield of him. */
export function throwAway(p: Perception, call: PlayCall, self: number): ThrowChoice {
  const me = p.athletes[self], f = call.frame, from = releasePoint(me), sides = [Math.sign(me.com[0]) || 1, -(Math.sign(me.com[0]) || 1)];
  let at: Vec3 = [0, 1, 0], time = 0;
  for (const s of sides) {
    at = [s * (p.field.halfWidth + AWAY_OUT), 1, me.com[2] + f.dir * AWAY_DOWN];
    const tv = throwVelocity(from, at, 0.3);
    time = THROW.release + tv.time;
    if (laneOpen(p, from, at, tv.vel, tv.time, me.team)) break;
  }
  return { target: -1, at, loft: 0.3, kind: 'away', open: 0, time, read: -3 };
}

/** Pocket movement (unit ground direction) against the nearest rusher: from the edge or behind he steps up and away;
 *  from in front he slides away. Never up past POCKET_LOS m behind the LOS. Null with no rusher. */
export function pocketStep(p: Perception, call: PlayCall, self: number): { x: number; z: number } | null {
  const r = nearestRush(p, self).who;
  if (r < 0) return null;
  const me = p.athletes[self], o = p.athletes[r], f = call.frame;
  const lat = o.com[0] - me.com[0], ahead = (o.com[2] - me.com[2]) * f.dir, away = -(Math.sign(lat) || 1);
  const up = rel(f, me.com).depth < -POCKET_LOS ? 1 : 0;
  // edge (more beside or behind him than in front): step up into the pocket, drifting away; in front: slide away
  const [x, z] = Math.abs(lat) > ahead ? [away * 0.5, f.dir * up] : [away, -f.dir * 0.2];
  const n = Math.hypot(x, z) || 1;
  return { x: x / n, z: z / n };
}

/** A scramble lane: the heading (unit ground direction) on which no standing opponent meets him before he is
 *  SCRAMBLE_GAIN m past the LOS (by SCRAMBLE_MARGIN s), the straightest first; null if none. */
export function scrambleLane(p: Perception, call: PlayCall, self: number): { x: number; z: number } | null {
  const me = p.athletes[self], f = call.frame, depth = rel(f, me.com).depth;
  for (const off of SCRAMBLE_OFFS) {
    const u = { x: Math.sin(off) * f.dir, z: Math.cos(off) * f.dir };
    const t = (SCRAMBLE_GAIN - depth) / (Math.cos(off) * SCRAMBLE_V);
    const end = me.com[0] + u.x * SCRAMBLE_V * t;
    if (Math.abs(end) > p.field.halfWidth - 1) continue;
    const vel: Vec3 = [u.x * SCRAMBLE_V, 0, u.z * SCRAMBLE_V];
    if (opponents(p, self).every((j) => p.athletes[j].down || chaseTime(p.athletes[j], me.com, vel) > t + SCRAMBLE_MARGIN)) return u;
  }
  return null;
}


/** Roll out (unit ground direction): toward the sideline away from the nearest rusher, a little back. */
export function rollOut(p: Perception, call: PlayCall, self: number): { x: number; z: number } {
  const me = p.athletes[self], r = nearestRush(p, self).who, f = call.frame;
  const s = r >= 0 ? -(Math.sign(p.athletes[r].com[0] - me.com[0]) || 1) : (Math.sign(me.com[0]) || 1);
  const x = s, z = -f.dir * 0.25, n = Math.hypot(x, z);
  return { x: x / n, z: z / n };
}

export class QBBrain implements Brain {
  private history: Perception[] = [];
  /** Frames seen before the one seen now (RUN_DT s of them): how the runs are changing. */
  private past: Perception[] = [];
  private tackler: TacklerBrain;
  private runner: CarrierBrain | null = null;
  private heading = NaN; private mag = 0;
  private routes: KnownRoutes | null = null;
  private dropSpot: Vec3 | null = null; private setAt = NaN; private lookFrom = NaN;
  private look: number;
  phase: QBPhase = 'pre';
  /** The read his eyes are on (index into reads; reads.length = the checkdown). */
  read = 0;
  private misread = NaN;
  lastPass: PassRecord | null = null;
  private t: QbTuning;
  constructor(private rng: Rng, private diff: BotDifficulty, private call: PlayCall, private self: number, tuning?: Partial<QbTuning>) {
    this.t = qbTuning(tuning);
    this.tackler = new TacklerBrain(rng, diff);
    this.look = this.t.look + this.t.lookK * diff.reaction;
  }

  think(p: Perception, dt = 1 / 240): Commands {
    if (this.runner) return this.runner.think(p, dt);
    const c = neutralCommands(), me = p.athletes[this.self], f = this.call.frame, a = passAssign(this.call, this.self);
    // without the ball (thrown, or picked off) he plays defense as a tackler: pursues an interception, else holds
    if (!me.hasBall || !a) return this.tackler.think(p, dt);
    c.carry = 2; c.gait = 'sprint';
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.past.push(this.history.shift()!);
    while (this.past.length > 1 && this.history[0].time - this.past[1].time >= RUN_DT) this.past.shift();
    if (me.down) return c;
    const old = this.history[0], age = p.time - old.time, pre = this.past[0], dt0 = pre ? old.time - pre.time : 0;
    // the field as seen a reaction ago, carried on with the runs he saw (a receiver bursting out of his break is led
    // at the speed he is getting to); his own body he knows now
    const seen: Perception = { ...p, athletes: old.athletes.map((o, i) => (i === this.self ? me : carry(o, pre?.athletes[i], dt0, age))), ball: p.ball };
    const el = p.time - f.snapTime, down = { x: 0, z: f.dir };
    if (el < 0) { c.face = down; return c; }
    if (this.phase === 'thrown') { const at = this.lastPass!.cmd.at; this.faceTo(me, at, c); return c; }
    // past the line he can no longer throw: a runner
    if (rel(f, me.com).depth > 0) return this.scramble(p, dt);
    const heat = sackTime(seen, this.self), n = a.reads.length;
    // at the snap he knows each route from where its receiver lined up (the play call: the same path the receiver runs)
    this.routes ??= this.call.assign.map((x, i) => (x?.kind === 'route' ? routePath(x, seen.athletes[i].com, f) : null));
    if (this.phase === 'pre') { this.phase = 'drop'; this.dropSpot = toWorld(f, rel(f, me.com).depth - DROP_DEPTH[a.drop], me.com[0]); }
    if (this.phase === 'drop') {
      const s = this.dropSpot!, dx = s[0] - me.com[0], dz = s[2] - me.com[2], d = Math.hypot(dx, dz);
      // quick pressure in the drop: the hot route at once
      const hot = chooseTarget(seen, this.call, this.self, { from: 0, to: -1, heat, routes: this.routes });
      if (hot) return this.pass(p, me, hot, heat, c);
      if (a.drop === 0 || d < 0.3) { this.phase = 'read'; this.setAt = p.time + (a.drop ? SET : 0); }
      else {
        const v = Math.min(a.drop === 3 ? BACKPEDAL_V : TURN_RUN_V, Math.sqrt(2 * DROP_BRAKE * d));
        this.run(me, dx / d * v, dz / d * v, dt, c);
        // a back-pedal faces downfield; turning and running, his front (left) shoulder points downfield
        c.face = a.drop === 3 || d < 1 ? down : { x: -f.dir, z: 0 };
        return c;
      }
    }
    // ---- in the pocket (or on the move): feet, then eyes
    let mv: { x: number; z: number } | null = null, v = 0;
    if (heat < ESCAPE_T) {
      if (a.scramble && scrambleLane(seen, this.call, this.self)) return this.scramble(p, dt);
      mv = rollOut(seen, this.call, this.self); v = ROLL_V;
    } else if (heat < POCKET_T) { mv = pocketStep(seen, this.call, this.self); v = POCKET_V; }
    this.run(me, mv ? mv.x * v : 0, mv ? mv.z * v : 0, dt, c);
    if (mv) c.gait = 'sprint';
    if (p.time < this.setAt) { c.face = down; return c; }
    if (Number.isNaN(this.lookFrom)) this.lookFrom = p.time;
    // the clock: a read whose time is up is left
    while (this.read < n && el > a.reads[this.read].by) this.next(p);
    const looked = p.time - this.lookFrom >= this.look;
    if (Number.isNaN(this.misread)) this.misread = this.rng.gauss() * this.diff.noise * this.t.misread;
    const ch = chooseTarget(seen, this.call, this.self, { from: this.read, to: this.read, minOpen: this.t.open + this.misread, heat, routes: this.routes });
    if (ch && (looked || ch.read === -1)) return this.pass(p, me, ch, heat, c);
    // a rusher on him: the best man even if covered, else away
    if (heat < FORCED_T) {
      const fc = forcedTarget(seen, this.call, this.self, this.routes);
      return this.pass(p, me, fc && fc.open > 0 ? fc : throwAway(seen, this.call, this.self), heat, c);
    }
    if (this.read >= n) {
      // progression covered: run if a lane opens, throw it away when late
      if (a.scramble && scrambleLane(seen, this.call, this.self)) return this.scramble(p, dt);
      if (el > (n ? a.reads[n - 1].by : 0) + LATE) return this.pass(p, me, throwAway(seen, this.call, this.self), heat, c);
    } else if (looked) this.next(p); // covered: on to the next read
    const t = this.read < n ? a.reads[this.read].target : a.checkdown;
    if (t !== undefined) this.faceTo(me, seen.athletes[t].com, c); else c.face = down;
    return c;
  }

  private next(p: Perception) { this.read++; this.lookFrom = p.time; this.misread = NaN; }

  /** Send the throw: the choice's point plus his lead error (difficulty, the distance, and nerves under the rush). */
  private pass(p: Perception, me: AthleteView, ch: ThrowChoice, heat: number, c: Commands): Commands {
    const from = releasePoint(me), pr = clamp(1 - heat / POCKET_T, 0, 1);
    const sd = ch.kind === 'away' ? 0 : this.diff.noise * (this.t.aim + this.t.aimPerM * flat(from, ch.at)) * (1 + this.t.nerves * pr);
    const cmd: PassCmd = { at: [ch.at[0] + this.rng.gauss() * sd, ch.at[1], ch.at[2] + this.rng.gauss() * sd], loft: ch.loft };
    c.pass = cmd; this.faceTo(me, cmd.at, c);
    this.lastPass = { ...ch, cmd, t: p.time, from };
    this.phase = 'thrown';
    return c;
  }

  private scramble(p: Perception, dt: number): Commands {
    this.phase = 'scramble';
    this.runner = new CarrierBrain(this.rng, this.diff, 'sprint', 2);
    return this.runner.think(p, dt);
  }

  private faceTo(me: AthleteView, at: Vec3, c: Commands) {
    const dx = at[0] - me.com[0], dz = at[2] - me.com[2], d = Math.hypot(dx, dz);
    if (d > 0.5) c.face = { x: dx / d, z: dz / d };
  }

  /** Move toward a ground velocity (m/s, world) as the tackler's run: the heading turns as fast as footing allows. */
  private run(me: AthleteView, vx: number, vz: number, dt: number, c: Commands) {
    const n = Math.hypot(vx, vz);
    if (Number.isNaN(this.heading)) this.heading = Math.atan2(vx, vz) || me.heading;
    if (n > 1e-3) {
      const d = wrapAngle(Math.atan2(vx, vz) - this.heading), w = (Math.hypot(me.comVel[0], me.comVel[2]) < 2 ? 6 : turnRate(Math.hypot(me.comVel[0], me.comVel[2]))) * dt;
      this.heading = wrapAngle(this.heading + clamp(d, -w, w));
    }
    this.mag += (Math.min(1, n / FULL) - this.mag) * (1 - Math.exp(-dt / MOVE_TAU));
    c.move = { x: Math.sin(this.heading) * this.mag, z: Math.cos(this.heading) * this.mag };
  }
}
