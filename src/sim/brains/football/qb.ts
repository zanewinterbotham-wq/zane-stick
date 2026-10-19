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
import { GAIT_SPEED } from '../../control/hand';
import { neutralCommands, type Commands, type PassCmd } from '../../control/types';
import { clamp, wrapAngle, type Vec3 } from '../../math';
import type { Rng } from '../../rng';
import { leadPoint, throwVelocity } from '../../throw';
import { CarrierBrain, type BotDifficulty } from '../carrier';
import { predict, TacklerBrain, turnRate } from '../tackler';
import type { AthleteView, Brain, Perception } from '../types';
import { DB_SPEED, interceptTime, openness, opponents, REACH, rel, toWorld } from './sense';
import type { PassAssign, PlayCall } from './types';

const G = 9.81, FULL = GAIT_SPEED.sprint, MOVE_TAU = 0.08;
/** The ball is aimed to arrive at chest height (m), released this far above the head's centre (m). */
export const CATCH_H = 1.2, RELEASE_UP = 0.15;
/** Drop depth behind the QB's start (m) per drop: a 3-step from under centre sets at ~5 yd, a 5-step ~7, a 7-step ~9. */
export const DROP_DEPTH: Record<PassAssign['drop'], number> = { 0: 0, 3: 3.5, 5: 5.5, 7: 7.5 };
/** Drop speed (m/s): a back-pedal, and turning and running; it brakes into the set at DROP_BRAKE m/s². Feet set for
 *  SET s at the top of a drop before the first read. */
const BACKPEDAL_V = 4.5, TURN_RUN_V = 6, DROP_BRAKE = 5, SET = 0.2;
/** Loft per window: a bullet, touch, a lob; each unit of loft costs LOFT_COST of openness (a softer ball hangs, and
 *  is harder to place). */
const LOFTS: [number, ThrowKind][] = [[0, 'bullet'], [0.45, 'touch'], [0.85, 'lob']], LOFT_COST = 0.08;
/** Openness he throws into (0..1, sense.openness); the hot route and the checkdown are taken a little tighter. */
export const OPEN = 0.15, HOT_K = 0.5, CHECK_K = 0.7;
/** Throwing lane: a defender this far (m) from the ball's ground path, plus how far he can break on it after his
 *  reaction (LANE_REACT s at LANE_BREAK m/s), stops it while it passes below DEF_REACH (m: a defender's raised hands
 *  and a jump). Defenders within LANE_END m of the catch point are the openness's concern, not the lane's. */
const LANE_R = 0.8, LANE_REACT = 0.3, LANE_BREAK = 5, DEF_REACH = 3.2, LANE_END = 2.5;
/** Key defender: ahead of the receiver along his run within LEVER m, he has leverage on the route (openness × LEVER_K);
 *  the ball is placed KEY_AWAY m to the side away from him. */
const LEVER = 3, LEVER_K = 0.5, KEY_AWAY = 0.4;
/** Back-shoulder: a receiver deeper than depth (m), running downfield faster than run (m/s), a man within tight m on
 *  his hip (not over the top). Both brake at decel m/s² (~0.7 g); the receiver needs turn s more to turn to the ball,
 *  which comes side m to the side away from the man; the man starts braking react s after the receiver. */
const BS = { depth: 10, run: 5, tight: 2.5, side: 0.8, decel: 7, turn: 0.15, react: 0.3 };
/** A rusher (an opponent closing on him faster than RUSH_CLOSE m/s, or within RUSH_NEAR m) reaches him in sackTime s.
 *  Below HOT_T the hot route is thrown; below POCKET_T he moves in the pocket; below ESCAPE_T he leaves it (scramble
 *  or roll out); below FORCED_T a rusher is on him: he throws to the best man even if covered, or throws it away. */
const RUSH_CLOSE = 1.5, RUSH_NEAR = 3, HOT_T = 1.6, POCKET_T = 1.4, ESCAPE_T = 0.8, FORCED_T = 0.35;
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
 *  (1 + NERVES × pressure); a misread shifts openness by noise × MISREAD. */
const LOOK = 0.15, LOOK_K = 1.2, AIM_0 = 0.5, AIM_D = 0.04, NERVES = 1.5, MISREAD = 0.15;

export type ThrowKind = 'bullet' | 'touch' | 'lob' | 'back-shoulder' | 'away';
/** A throw decision: the receiver (−1 thrown away), where and how high, its openness and flight time, and which read
 *  it came from (index into reads; −1 the hot route, −2 the checkdown, −3 thrown away). */
export interface ThrowChoice { target: number; at: Vec3; loft: number; kind: ThrowKind; open: number; time: number; read: number }
export type QBPhase = 'pre' | 'drop' | 'read' | 'scramble' | 'thrown';
/** What the bot QB commanded (tests, HUD): the choice, the PassCmd sent (lead noise included), the sim time. */
export interface PassRecord extends ThrowChoice { cmd: PassCmd; t: number; from: Vec3 }

const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const passAssign = (call: PlayCall, self: number) => { const a = call.assign[self]; return a && a.kind === 'pass' ? a : null; };

/** Where the ball leaves his hand (m). */
export const releasePoint = (me: AthleteView): Vec3 => [me.com[0], me.head[1] + RELEASE_UP, me.com[2]];

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

/** Time (s) opponent o needs to reach me if he is rushing me (closing faster than RUSH_CLOSE, or near); else Infinity. */
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

/** The best throw to `target` (any loft whose lane is open, and a back-shoulder ball when it fits), scored by openness
 *  at the ball's arrival less the loft's cost; null if he is down, out of bounds or no lane is open. */
export function bestThrow(p: Perception, call: PlayCall, self: number, target: number, read: number, key?: number): ThrowChoice | null {
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
    const { vel, time } = throwVelocity(from, at, loft);
    if (!laneOpen(p, from, at, vel, time, me.team, ignore)) return;
    const open = open0(at, time) * lever - LOFT_COST * loft;
    if (!best || open > best.open) best = { target, at, loft, kind, open, time, read };
  };
  for (const [loft, kind] of LOFTS) {
    const at = leadPoint(from, { pos, vel: r.comVel }, loft);
    consider([at[0] + away[0], at[1], at[2] + away[1]], loft, kind);
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
export interface ReadOpts { from?: number; to?: number; minOpen?: number; heat?: number }

/** The throw the QB makes now, or null: under quick pressure the hot route; else the first open read of the
 *  progression from..to (a covered read is skipped); with the progression exhausted, the checkdown. Never a covered
 *  man (minOpen 0 is the caller forcing it). */
export function chooseTarget(p: Perception, call: PlayCall, self: number, o: ReadOpts = {}): ThrowChoice | null {
  const a = passAssign(call, self);
  if (!a) return null;
  const minOpen = o.minOpen ?? OPEN, heat = o.heat ?? sackTime(p, self), n = a.reads.length;
  if (a.hot !== undefined && heat < HOT_T) {
    const h = bestThrow(p, call, self, a.hot, -1);
    if (h && h.open >= minOpen * HOT_K) return h;
  }
  const from = o.from ?? 0, to = o.to ?? n;
  for (let i = Math.max(0, from); i <= Math.min(to, n - 1); i++) {
    const t = bestThrow(p, call, self, a.reads[i].target, i, a.reads[i].key);
    if (t && t.open >= minOpen) return t;
  }
  if (to >= n && a.checkdown !== undefined) {
    const t = bestThrow(p, call, self, a.checkdown, -2);
    if (t && t.open >= minOpen * CHECK_K) return t;
  }
  return null;
}

/** The best throw to anyone on the call (forced: open or not), or null if no lane. */
export function forcedTarget(p: Perception, call: PlayCall, self: number): ThrowChoice | null {
  const a = passAssign(call, self);
  if (!a) return null;
  let best: ThrowChoice | null = null;
  const ts = [...a.reads.map((r, i) => [r.target, i, r.key] as const), ...(a.hot !== undefined ? [[a.hot, -1, undefined] as const] : []), ...(a.checkdown !== undefined ? [[a.checkdown, -2, undefined] as const] : [])];
  for (const [t, i, k] of ts) { const c = bestThrow(p, call, self, t, i, k); if (c && (!best || c.open > best.open)) best = c; }
  return best;
}

/** Throw it away: far beyond the nearer sideline (the other one if an opponent is in that lane), downfield of him. */
export function throwAway(p: Perception, call: PlayCall, self: number): ThrowChoice {
  const me = p.athletes[self], f = call.frame, from = releasePoint(me), sides = [Math.sign(me.com[0]) || 1, -(Math.sign(me.com[0]) || 1)];
  let at: Vec3 = [0, 1, 0], time = 0;
  for (const s of sides) {
    at = [s * (p.field.halfWidth + AWAY_OUT), 1, me.com[2] + f.dir * AWAY_DOWN];
    const tv = throwVelocity(from, at, 0.3);
    time = tv.time;
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

/** When opponent o, seeing it BS.react s late, meets a runner leaving `from` at `vel` (s): running away from him (a man
 *  turned downfield with his receiver) he runs on and brakes to a stop first. */
function chaseTime(o: AthleteView, from: Vec3, vel: Vec3): number {
  const sp = Math.hypot(o.comVel[0], o.comVel[2]), away = o.comVel[0] * (from[0] - o.com[0]) + o.comVel[2] * (from[2] - o.com[2]) < 0;
  const run = away ? sp * BS.react + sp * sp / (2 * BS.decel) : 0, t0 = away ? BS.react + sp / BS.decel : BS.react;
  const start: Vec3 = sp > 0.1 ? [o.com[0] + o.comVel[0] / sp * run, 0, o.com[2] + o.comVel[2] / sp * run] : o.com;
  const at: Vec3 = [from[0] + vel[0] * t0, 0, from[2] + vel[2] * t0];
  return t0 + Math.max(0, interceptTime(start, DB_SPEED, at, vel) - REACH / DB_SPEED);
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
  private tackler: TacklerBrain;
  private runner: CarrierBrain | null = null;
  private heading = NaN; private mag = 0;
  private dropSpot: Vec3 | null = null; private setAt = NaN; private lookFrom = NaN;
  private look: number;
  phase: QBPhase = 'pre';
  /** The read his eyes are on (index into reads; reads.length = the checkdown). */
  read = 0;
  lastPass: PassRecord | null = null;
  constructor(private rng: Rng, private diff: BotDifficulty, private call: PlayCall, private self: number) {
    this.tackler = new TacklerBrain(rng, diff);
    this.look = LOOK + LOOK_K * diff.reaction;
  }

  think(p: Perception, dt = 1 / 240): Commands {
    if (this.runner) return this.runner.think(p, dt);
    const c = neutralCommands(), me = p.athletes[this.self], f = this.call.frame, a = passAssign(this.call, this.self);
    // without the ball (thrown, or picked off) he plays defense as a tackler: pursues an interception, else holds
    if (!me.hasBall || !a) return this.tackler.think(p, dt);
    c.carry = 2; c.gait = 'sprint';
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    if (me.down) return c;
    const old = this.history[0], age = p.time - old.time;
    // the field as seen a reaction ago, carried on at what he saw (his own body he knows now)
    const seen: Perception = { ...p, athletes: old.athletes.map((o, i) => (i === this.self ? me : predict(o, age))), ball: p.ball };
    const el = p.time - f.snapTime, down = { x: 0, z: f.dir };
    if (el < 0) { c.face = down; return c; }
    if (this.phase === 'thrown') { const at = this.lastPass!.cmd.at; this.faceTo(me, at, c); return c; }
    // past the line he can no longer throw: a runner
    if (rel(f, me.com).depth > 0) return this.scramble(p, dt);
    const heat = sackTime(seen, this.self), n = a.reads.length;
    if (this.phase === 'pre') { this.phase = 'drop'; this.dropSpot = toWorld(f, rel(f, me.com).depth - DROP_DEPTH[a.drop], me.com[0]); }
    if (this.phase === 'drop') {
      const s = this.dropSpot!, dx = s[0] - me.com[0], dz = s[2] - me.com[2], d = Math.hypot(dx, dz);
      // quick pressure in the drop: the hot route at once
      const hot = chooseTarget(seen, this.call, this.self, { from: 0, to: -1, heat });
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
    const misread = this.rng.gauss() * this.diff.noise * MISREAD;
    const ch = chooseTarget(seen, this.call, this.self, { from: this.read, to: this.read, minOpen: OPEN + misread, heat });
    if (ch && (looked || ch.read === -1)) return this.pass(p, me, ch, heat, c);
    // a rusher on him: the best man even if covered, else away
    if (heat < FORCED_T) {
      const fc = forcedTarget(seen, this.call, this.self);
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

  private next(p: Perception) { this.read++; this.lookFrom = p.time; }

  /** Send the throw: the choice's point plus his lead error (difficulty, the distance, and nerves under the rush). */
  private pass(p: Perception, me: AthleteView, ch: ThrowChoice, heat: number, c: Commands): Commands {
    const from = releasePoint(me), pr = clamp(1 - heat / POCKET_T, 0, 1);
    const sd = ch.kind === 'away' ? 0 : this.diff.noise * (AIM_0 + AIM_D * flat(from, ch.at)) * (1 + NERVES * pr);
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
