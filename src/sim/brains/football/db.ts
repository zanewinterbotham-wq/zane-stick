// Bot defensive back (docs/passing.md "AI built for 11 on 11"): plays the man or zone assignment his play call gives
// him, against however many receivers there are.
// - Man press: squares up on the receiver at the line and jams him (hands punched into his chest) for the first
//   yards, then trails on his hip on the leverage side.
// - Man off: backpedals (shuffles) facing the receiver, keeping the leverage he was given and a cushion that shrinks
//   as the receiver gets deep and grows with his speed; turns and runs when the backpedal cannot keep up; breaks on
//   the receiver's break with a plant and cut, since the spot he keeps is the receiver's.
// - Zone: drops to his zone's landmark (depth and width from the ball) facing the QB; pattern-matches: takes a
//   receiver who enters the zone (underneath: in the throwing lane, between him and the QB; deep: over the top of
//   the deepest threat), and passes him off when he leaves it.
// - The throw: he breaks on the ball only once he sees it in the air (his reaction delay after the release, the
//   difficulty), runs to the earliest point of its flight he can get a hand on, else to where it comes down (the
//   receiver's hands, for a breakup), and raises both hands to it (the play's catch rule: an interception or a
//   muff that knocks it away), jumping for a high one and diving for one just beyond reach. In zone only the defender
//   nearest where it comes down plays it (sense.passIsMine); the others keep their zones.
// - After a catch, or a runner past the line: a tackler (TacklerBrain: pursuit angle, breakdown, strike); with the
//   ball himself (an interception) a carrier; a teammate's interception, a blocker.
// Reads only the Perception through his reaction delay; difficulty is that delay and the noise of his spots. Same
// Commands as a human.
import { GAIT_SPEED } from '../../control/hand';
import { neutralCommands, type Commands } from '../../control/types';
import { clamp, type Vec3 } from '../../math';
import type { Rng } from '../../rng';
import { BlockerBrain } from '../blocker';
import { CarrierBrain, type BotDifficulty } from '../carrier';
import { catchPoint } from '../returner';
import { Steer } from '../steer';
import { TacklerBrain } from '../tackler';
import type { AthleteView, Brain, Perception } from '../types';
import { ballInPlay } from '../steer';
import { ACC_DT, ballAt, ballSpot, carry, inFlight, passIsMine, REACH, rel, toWorld } from './sense';
import type { ManAssign, PlayCall, PlayFrame, ZoneAssign, ZoneKind } from './types';

const FULL = GAIT_SPEED.sprint;
/** Fastest wanted speed (m/s) he backpedals or shuffles at, facing his man or the QB, before he opens his hips and
 *  runs (the animator's backpedal tops out at 6.5 m/s; a DB's at ~5–6). */
const BP_MAX = 5;
/** Press: the jam lasts until JAM_T s after the snap, the receiver is JAM_D m past the line or he is off it downfield
 *  faster than JAM_V m/s; he stands JAM_GAP m in front of him and punches inside PUNCH m (COM to COM). */
const JAM_T = 0.9, JAM_D = 3, JAM_V = 3, JAM_GAP = 0.9, PUNCH = 1.4;
/** Leverage: how far (m) to the leverage side of the receiver he keeps. Trail: the lead on the receiver's run (s) and
 *  how far over the top of him he stays (m), off his line by TRAIL_LEV × LEV (his way past stays open: a man on top
 *  and in his path only collides with him). */
const LEV = 0.7, TRAIL_LEAD = 0.3, TOP = 1, TRAIL_LEV = 1.5;
/** Off cushion (m of depth over the receiver): CUSH_MIN + CUSH0 at the line (~5 yd), the CUSH0 part fading over
 *  CUSH_L m of his depth (at first it shrinks as fast as he comes: the DB sits and reads, then backpedals; it is all but
 *  gone where routes break, ~10 m), plus CUSH_V s of his speed downfield. With deep help he plays tighter (HELP_K). */
const CUSH0 = 4, CUSH_L = 4, CUSH_MIN = 0.5, CUSH_V = 0.05, HELP_K = 0.7;
/** Spot-keeping gain (1/s, on top of the receiver's own velocity) and the deceleration a drop is planned to stop on
 *  its landmark with (m/s²). */
const K_POS = 2.5, BRAKE = 5;
/** Zone: a receiver more than HANDOFF m outside the zone's radius has left it (passed off); underneath he takes the
 *  lane LANE m from the receiver toward the QB, deep he stays DEEP_CUSH m over the top. */
const HANDOFF = 1.5, LANE = 1, DEEP_CUSH = 3;
/** Ball (sense.ballSpot: where he gets a hand on it): the hands go up HANDS_T s before it gets to him (or inside
 *  HANDS_D m); a jump for one above JUMP_H m within JUMP_T s; a dive for one he cannot reach running, DIVE_D m away
 *  (beyond his reach) within DIVE_T s. In zone the pass is his to play when it is his (sense.passIsMine), kept unless
 *  a team mate is MINE m nearer where it comes down. */
const HANDS_T = 0.45, HANDS_D = 2.5, JUMP_H = 2.15, JUMP_T = 0.3, MINE = 2;
const DIVE_D: [number, number] = [0.4, 2], DIVE_T = 0.35;
/** Below this ground speed (m/s) the wanted direction is taken at once. */
const SNAP_V = 2;

/** A zone's landmark: depth past the line (m), world x, and the zone's radius (m) for pattern matching. */
export interface Landmark { depth: number; x: number; r: number }
/** Depth (m), width (m from the ball, or a share of the field's half width when below 1) and radius (m) per zone,
 *  standard spot drops: flats at the numbers ~5 m, hook just outside the hash ~9 m, curl ~11 m, the middle hole,
 *  deep thirds over the numbers ~14 m, halves ~15 m between hash and numbers, quarters ~12 m. */
const ZONES: Record<ZoneKind, [number, number, number]> = {
  flat: [4.5, 0.65, 7], hook: [9, 4.5, 6], curl: [11, 0.45, 6], middle: [10, 0, 6],
  'deep-third': [14, 0.6, 10], 'deep-half': [15, 0.45, 12], 'deep-quarter': [12, 0.6, 9],
};
const DEEP = new Set<ZoneKind>(['deep-third', 'deep-half', 'deep-quarter']);

/** The landmark of zone `z` with the ball at world x `ballX` (side +1: the offense's left). */
export function zoneLandmark(f: PlayFrame, z: ZoneAssign, ballX = 0): Landmark {
  const [depth, w, r] = ZONES[z.zone], wx = w < 1 ? w * f.halfWidth : w;
  return { depth, x: clamp(ballX + z.side * f.dir * wx, -f.halfWidth + 2, f.halfWidth - 2), r };
}

/** Athlete i is a receiver the defense covers: an opponent of `team` running a route (or without an assignment, a
 *  human's) who does not hold the ball. */
export function eligible(p: Perception, call: PlayCall, i: number, team: 0 | 1): boolean {
  const a = p.athletes[i], k = call.assign[i]?.kind;
  return a.team !== team && !a.hasBall && !a.down && (k === undefined || k === 'route');
}

export type DbPhase = 'cover' | 'jam' | 'ball' | 'tackle' | 'carry' | 'block';

export class DefensiveBackBrain implements Brain {
  private history: Perception[] = [];
  /** Frames seen before the one seen now (ACC_DT s of them): how a receiver's run is changing. */
  private past: Perception[] = [];
  private steer = new Steer();
  private tackler: TacklerBrain; private carrier: CarrierBrain; private blocker: BlockerBrain;
  private err: [number, number] = [0, 0]; private errUntil = -Infinity;
  private ballX = NaN;
  private opened = false; private released = false; private thrown = false; private jumped = false; private dived = false; private mine = false;
  /** What he is doing (tests, HUD). */
  phase: DbPhase = 'cover';
  /** The receiver he is on now (man: his man; zone: the one matched in his zone, −1 none), and every receiver he has
   *  matched in zone, in order (tests). */
  match = -1;
  readonly matched: number[] = [];
  constructor(private rng: Rng, private diff: BotDifficulty, readonly call: PlayCall, readonly self: number) {
    this.tackler = new TacklerBrain(rng, diff);
    this.carrier = new CarrierBrain(rng, diff, 'sprint');
    this.blocker = new BlockerBrain(rng, diff);
    const a = call.assign[self];
    if (a?.kind === 'man') this.match = a.target;
  }

  think(p: Perception, dt = 1 / 240): Commands {
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.past.push(this.history.shift()!);
    while (this.past.length > 1 && this.history[0].time - this.past[1].time >= ACC_DT) this.past.shift();
    const seen = this.history[0], age = p.time - seen.time, me = p.athletes[p.self], c = neutralCommands();
    if (me.down) return c;
    if (me.hasBall) { this.phase = 'carry'; return this.carrier.think(p, dt); }
    const hi = seen.athletes.findIndex((a) => a.hasBall), b = seen.ball, f = this.call.frame, as = this.call.assign[this.self];
    const a = as?.kind === 'man' || as?.kind === 'zone' ? as : null;
    if (hi >= 0 && seen.athletes[hi].team === me.team) { this.phase = 'block'; return this.blocker.think(p, dt); }
    if (b && Number.isNaN(this.ballX)) this.ballX = b.pos[0];
    const air = inFlight(seen);
    if (air) this.thrown = true;
    // a catch, a runner (past the line, or my man with the ball), a ball on the turf: football, tackle or recover it
    const runner = hi >= 0 && (this.thrown || rel(f, seen.athletes[hi].com).depth > 0.5 || (a?.kind === 'man' && a.target === hi));
    // (a pass sailing out of play is not played: the tackler leaves a dead or lost ball alone)
    if (runner || (hi < 0 && (!air || !ballInPlay(seen))) || !a) { this.phase = 'tackle'; return this.tackler.think(p, dt); }
    if (p.time >= this.errUntil) { this.err = [this.rng.gauss() * this.diff.noise, this.rng.gauss() * this.diff.noise]; this.errUntil = p.time + 0.6; }
    const ball = air ? ballAt(b!, age) : null;
    // in zone the pass is played by the defender nearest where it comes down; the others stay in their zones
    if (ball && a.kind === 'zone') this.mine = passIsMine(seen, ball, this.self, this.mine ? MINE : 0, me.com);
    if (ball && (a.kind === 'man' || this.mine)) this.playBall(p, ball, me, dt, c);
    else if (a.kind === 'man') this.man(p, seen, age, me, a, dt, c);
    else this.zone(p, seen, age, me, a, dt, c);
    return c;
  }

  /** Athlete i as seen, carried on `age` s with the velocity and acceleration seen (the eye reads a burst off the line
   *  as well as a steady run; a change of either is what the reaction delay answers). */
  private track(seen: Perception, i: number, age: number): AthleteView {
    const o = this.past[0];
    return carry(seen.athletes[i], o?.athletes[i], o ? seen.time - o.time : 0, age);
  }

  /** Inside (toward the ball) from a receiver at world x `rx`: ±1 along x. */
  private inside(rx: number) { const bx = Number.isNaN(this.ballX) ? 0 : this.ballX; return Math.sign(bx - rx) || -Math.sign(rx) || 1; }

  private man(p: Perception, seen: Perception, age: number, me: AthleteView, a: ManAssign, dt: number, c: Commands) {
    const f = this.call.frame, r = this.track(seen, a.target, age), R = rel(f, r.com), t = p.time - f.snapTime;
    const lev = (a.leverage === 'inside' ? 1 : -1) * this.inside(r.com[0]) * LEV, vDown = r.comVel[2] * f.dir;
    const dx = r.com[0] - me.com[0], dz = r.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    let depth: number, x: number, lead = 0;
    if (a.press && !this.released && (t > JAM_T || R.depth > JAM_D || vDown > JAM_V)) this.released = true;
    this.phase = a.press && !this.released ? 'jam' : 'cover';
    if (this.phase === 'jam') {
      // squared up in front of him on the leverage side; hands into his chest once he is on me
      depth = R.depth + JAM_GAP; x = r.com[0] + lev * 0.5; // shaded to the leverage side: his release is the other way
      c.face = { x: dx / d, z: dz / d }; c.contactMode = true; c.sink = 0.3;
      if (d < PUNCH) { c.armL = c.armR = 1; c.shoot = true; c.aim = [r.pelvis[0], r.pelvis[1] + 0.35, r.pelvis[2]]; }
    } else if (a.press) {
      // trail on his hip, on the leverage side: on top of him (TOP m deeper) so his acceleration does not leave me
      // behind, level with deep help over the top; on top only once off his line (in front of him and in his path,
      // his run comes through my back)
      const clear = clamp((Math.abs(me.com[0] - r.com[0]) - 0.5) / 0.5, 0, 1);
      depth = R.depth + (a.help === 'deep' ? 0 : TOP * clear); x = r.com[0] + lev * TRAIL_LEV; lead = TRAIL_LEAD;
    } else {
      const cush = (CUSH_MIN + CUSH0 * Math.exp(-Math.max(0, R.depth) / CUSH_L) + CUSH_V * Math.max(0, vDown)) * (a.help === 'deep' ? HELP_K : 1);
      depth = R.depth + cush; x = r.com[0] + lev;
    }
    c.contactMode ||= d < 2; // braced for the bump of a man at arm's length
    const spot = toWorld(f, depth + this.err[0], x + this.err[1]);
    const vx = r.comVel[0] * (1 + lead * K_POS) + K_POS * (spot[0] - me.com[0]), vz = r.comVel[2] * (1 + lead * K_POS) + K_POS * (spot[2] - me.com[2]);
    // facing him (a backpedal, off the jam too: flipping the hips at once gave him the first steps) until the backpedal
    // cannot keep up; then facing him again in close only once he has stopped (a curl, a comeback)
    if (this.phase === 'cover') this.eyes(vx, vz, dx / d, dz / d, Math.hypot(r.comVel[0], r.comVel[2]) < 3 ? d : Infinity, true, c);
    this.go(p, me, vx, vz, dt, c);
  }

  private zone(p: Perception, seen: Perception, age: number, me: AthleteView, a: ZoneAssign, dt: number, c: Commands) {
    this.phase = 'cover';
    const f = this.call.frame, L = zoneLandmark(f, a, Number.isNaN(this.ballX) ? 0 : this.ballX), deep = DEEP.has(a.zone);
    const off = (v: AthleteView) => { const q = rel(f, v.com); return Math.hypot(q.depth - L.depth, q.x - L.x); };
    const team = me.team;
    // pass off a receiver who has left the zone; take the one in it (deep: the deepest threat; underneath: the nearest)
    if (this.match >= 0 && (!eligible(seen, this.call, this.match, team) || off(seen.athletes[this.match]) > L.r + HANDOFF)) this.match = -1;
    if (this.match < 0) {
      let best = Infinity;
      seen.athletes.forEach((o, i) => {
        if (!eligible(seen, this.call, i, team) || off(o) > L.r) return;
        const k = deep ? -rel(f, o.com).depth : off(o);
        if (k < best) { best = k; this.match = i; }
      });
      if (this.match >= 0 && this.matched[this.matched.length - 1] !== this.match) this.matched.push(this.match);
    }
    let depth = L.depth, x = L.x, vx = 0, vz = 0, edge = false;
    if (this.match >= 0) {
      const r = this.track(seen, this.match, age), R = rel(f, r.com);
      vx = r.comVel[0]; vz = r.comVel[2];
      if (deep) { depth = Math.max(L.depth, R.depth + DEEP_CUSH); x = R.x; }
      else {
        // in the lane from the QB to him (the ball at the snap stands in for a QB out of sight)
        const qb = seen.athletes.find((o) => o.hasBall)?.com ?? toWorld(f, -5, this.ballX || 0), Q = rel(f, qb);
        const ld = Q.depth - R.depth, lx = Q.x - R.x, n = Math.hypot(ld, lx) || 1;
        depth = R.depth + ld / n * LANE; x = R.x + lx / n * LANE;
      }
      // he never chases out of his zone: at its edge he stops and lets him go
      const ed = depth - L.depth, ex = x - L.x, e = Math.hypot(ed, ex);
      if (e > L.r) { depth = L.depth + ed / e * L.r; x = L.x + ex / e * L.r; edge = true; }
    }
    const spot = toWorld(f, depth + this.err[0], x + this.err[1]);
    let gx = spot[0] - me.com[0], gz = spot[2] - me.com[2];
    if (this.match < 0 || edge) {
      // the drop (or to the zone's edge): flat out, planned to stop on the spot
      const g = Math.hypot(gx, gz) || 1e-6, v = Math.min(FULL, Math.sqrt(2 * BRAKE * g));
      gx = gx / g * v; gz = gz / g * v;
    } else { gx = vx + K_POS * gx; gz = vz + K_POS * gz; }
    // eyes on the QB (the ball)
    const ball = seen.ball?.pos ?? toWorld(f, -5, 0), bx = ball[0] - me.com[0], bz = ball[2] - me.com[2], bd = Math.hypot(bx, bz) || 1e-6;
    this.eyes(gx, gz, bx / bd, bz / bd, Infinity, false, c);
    this.go(p, me, gx, gz, dt, c);
  }

  /** Face (ux, uz) while the wanted run (vx, vz) is one a backpedal or shuffle can make; once it is not, open the hips
   *  and run (`sticky`, man: for good, the turn costs a step, facing again only inside 2.5 m (`d`); zone: until the run
   *  slows again). */
  private eyes(vx: number, vz: number, ux: number, uz: number, d: number, sticky: boolean, c: Commands) {
    const v = Math.hypot(vx, vz);
    if (v > BP_MAX && vx * ux + vz * uz < 0.5 * v) this.opened = true;
    else if (!sticky && v < BP_MAX - 1) this.opened = false;
    if (!this.opened || d < 2.5) c.face = { x: ux, z: uz };
  }

  /** The ball in the air (`b`: where it is now, as seen): to the earliest point of its flight he can reach, else to
   *  where it comes down; both hands to it as it comes; a jump for a high one, a dive for one just beyond reach. */
  private playBall(p: Perception, b: { pos: Vec3; vel: Vec3 }, me: AthleteView, dt: number, c: Commands) {
    this.phase = 'ball';
    const s = ballSpot(b, me.com, me.comVel), k = Math.min(1, s.t);
    const tx = s.at[0] + this.err[0] * k, tz = s.at[2] + this.err[1] * k;
    const dx = tx - me.com[0], dz = tz - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    const v = Math.min(FULL, Math.sqrt(2 * 2 * BRAKE * d));
    this.go(p, me, dx / d * v, dz / d * v, dt, c);
    c.contactMode = true;
    const bx = b.pos[0] - me.com[0], bz = b.pos[2] - me.com[2], bd = Math.hypot(bx, bz) || 1e-6;
    // squared up to it once at the spot (facing it on the way would make the run a backpedal)
    if (d < 1.5 || (dx * bx + dz * bz) / (d * bd) > 0.5) c.face = { x: bx / bd, z: bz / bd };
    const chest: Vec3 = [me.head[0], me.head[1] - 0.3, me.head[2]];
    if (s.t < HANDS_T || bd < HANDS_D) { c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = catchPoint(b, chest, 1); }
    if (!this.jumped && !s.late && s.at[1] > JUMP_H && s.t < JUMP_T && d < REACH) { c.jump = true; this.jumped = true; }
    const sp = Math.hypot(me.comVel[0], me.comVel[2]);
    if (!this.dived && s.late && s.t < DIVE_T && sp > 3 && d - REACH > DIVE_D[0] && d - REACH < DIVE_D[1]) { c.dive = true; this.dived = true; }
  }

  /** Toward a ground velocity (m/s, world): a wanted direction well off the run is a plant and cut at speed (the
   *  break on a receiver's break), a pivot when slow; else the heading turns no faster than footing allows, and the
   *  magnitude is filtered (Steer.chase, as the tackler). */
  private go(p: Perception, me: AthleteView, vx: number, vz: number, dt: number, c: Commands) {
    this.steer.chase(p, me, vx, vz, dt, c, SNAP_V);
    c.gait = 'sprint';
  }
}
