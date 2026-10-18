// Bot tackler: pursues the ball carrier on an intercept course (leading him and staying on his goal side), breaks
// down near contact (sinks and chops the feet so a cut can be mirrored), then strikes: drives through with both
// arms wrapping and gripping and rolls the hips at contact, and dives when the carrier is slipping just out of
// reach. With nobody holding the ball it recovers it by diving on it. Reads the world through a reaction delay;
// difficulty is only that delay, how far ahead it leads, and aim noise. Same Commands as a human.
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type Commands } from '../control/types';
import { clamp, wrapAngle, type Vec3 } from '../math';
import type { Rng } from '../rng';
import type { BotDifficulty } from './carrier';
import type { AthleteView, Brain, Perception } from './types';

/** Speed the intercept is planned at (m/s) and its longest lead (s); aim this far to the carrier's goal side
 *  so a cut-back stays in front (m). */
const PURSUE_V = 9, LEAD_MAX = 2.5, LEVERAGE = 0.7;
/** Break down (under control, closing at BREAK_V) inside BREAK_TTC s of contact, or BREAK_D m, when closing faster
 *  than BREAK_CLOSE m/s (chasing from behind there is nothing to mirror); at most BREAK_MAX s. */
const BREAK_TTC: [number, number] = [0.9, 1.1], BREAK_D = 6, BREAK_CLOSE = 3, BREAK_MAX = 1.5;
/** Strike inside this distance (m, COM to COM), wrap inside WRAP, roll the hips inside THRUST; give up the
 *  strike and pursue again beyond MISS. */
const STRIKE = 1.9, WRAP = 1.3, THRUST = 0.8, MISS = 4.5;
/** Dive at a carrier who is getting away (closing slower than DIVE_CLOSE m/s, or still more than DIVE_MISS m away
 *  0.3 s on) when, DIVE_T s ahead with both running on, he would be DIVE_D m ahead along the run (the dive follows
 *  the run, faster than DIVE_RUN m/s, and lays the body out about that far) and within DIVE_SIDE m of its line. */
const DIVE_D: [number, number] = [0.3, 2.2], DIVE_T = 0.4, DIVE_SIDE = 0.8, DIVE_CLOSE = 1.5, DIVE_MISS = 1.5, DIVE_RUN = 2;
/** Closer to a loose ball than this (m, horizontal), drop the chest onto it rather than dive. */
const BALL_DROP = 1;
/** Closing speed while breaking down and while striking (m/s); the move command's filter time (s). */
const BREAK_V = 3, STRIKE_V = 6, MOVE_TAU = 0.08;
const FULL = GAIT_SPEED.sprint;
/** Plant and cut (as a carrier does) when the wanted direction is PLANT_ANGLE rad off a run faster than
 *  PLANT_RUN m/s; the command is held PLANT_HOLD s, and the next one waits PLANT_GAP s (the cut lasts 0.45 s). */
const PLANT_ANGLE = 0.6, PLANT_RUN = 2.5, PLANT_HOLD = 0.1, PLANT_GAP = 0.6;

/** Sideways acceleration a run can turn with (m/s², ~0.6 g) and the fastest heading change (rad/s): at speed a
 *  heading swung faster than the feet can follow leaves the body facing off its run, and it falls. */
const LAT_ACCEL = 3.5, TURN_MAX = 6;
export const turnRate = (speed: number) => Math.min(TURN_MAX, LAT_ACCEL / Math.max(speed, 1));

type Phase = 'pursue' | 'breakdown' | 'strike';

/** Where an athlete seen `dt` s ago is now if he kept his velocity: the reaction delay is the time to answer a
 *  change, not a lag on steady motion, which a player's eye extrapolates. */
export function predict(a: AthleteView, dt: number): AthleteView {
  const v = a.comVel, f = (x: Vec3): Vec3 => [x[0] + v[0] * dt, x[1], x[2] + v[2] * dt];
  return { ...a, com: f(a.com), pelvis: f(a.pelvis), head: f(a.head) };
}

export class TacklerBrain implements Brain {
  private history: Perception[] = [];
  private heading = NaN; private mag = 0;
  private aimErr = 0; private aimUntil = 0;
  private dived = false; private wasDown = false;
  private plantSide: -1 | 1 = 1; private plantUntil = 0; private plantFree = 0;
  phase: Phase = 'pursue';
  private phaseUntil = 0;
  private breakTtc: number;
  constructor(private rng: Rng, private diff: BotDifficulty) {
    this.breakTtc = rng.range(...BREAK_TTC);
  }

  think(p: Perception, dt = 1 / 240): Commands {
    const c = neutralCommands();
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    const seen = this.history[0], me = p.athletes[p.self];
    // a dive (or being knocked down) is over once back on the feet: another one may follow
    if (me.down) this.wasDown = true;
    else if (this.wasDown) { this.wasDown = false; this.dived = false; }
    const ti = seen.athletes.findIndex((a, i) => i !== p.self && a.hasBall);
    // shortcut: a tackler that recovers the ball just holds still; give it a carrier brain when a drill lets
    // the defence run a recovery back.
    if (me.down || me.hasBall) return c;
    if (ti >= 0) { if (!seen.athletes[ti].down) this.tackle(p, me, predict(seen.athletes[ti], p.time - seen.time), dt, c); }
    else if (seen.ball) this.recover(me, seen.ball, dt, c);
    return c;
  }

  private tackle(p: Perception, me: AthleteView, t: AthleteView, dt: number, c: Commands) {
    const dx = t.com[0] - me.com[0], dz = t.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    const rvx = t.comVel[0] - me.comVel[0], rvz = t.comVel[2] - me.comVel[2];
    const closing = -(rvx * dx + rvz * dz) / d;
    if (p.time >= this.aimUntil) { this.aimErr = this.rng.gauss() * this.diff.noise * 0.8; this.aimUntil = p.time + 0.5; }
    // ---- phase
    // he is in front of the way I am running (striking at someone behind me only trips me up)
    const sp = Math.hypot(me.comVel[0], me.comVel[2]), front = sp < 1 || (me.comVel[0] * dx + me.comVel[2] * dz) / (sp * d) > 0.2;
    if (this.phase === 'pursue') {
      if (closing > BREAK_CLOSE && (d / closing < this.breakTtc || d < BREAK_D)) { this.phase = 'breakdown'; this.phaseUntil = p.time + BREAK_MAX; }
      else if (d < STRIKE && front) this.phase = 'strike';
    } else if (this.phase === 'breakdown') {
      if (d < STRIKE) this.phase = 'strike';
      else if (p.time >= this.phaseUntil || !front) this.phase = 'pursue';
    } else if (this.phase === 'strike' && (d > MISS || (!front && d > 1) || (closing < 0 && d > STRIKE + 0.5))) { this.phase = 'pursue'; if (d > MISS) this.dived = false; }
    // ---- how to run: flat out at the intercept; in close, mirror his movement across the line to him and close
    // on him at the breakdown's or the strike's pace (on top of his own speed away, when chasing)
    const ux = dx / d, uz = dz / d;
    if (this.phase === 'pursue') {
      const lead = this.intercept(dx, dz, t.comVel) * clamp(1 - this.diff.noise, 0.5, 1);
      // the aim error is across the line to him, the leverage toward his goal, both fading in close
      const k = Math.min(1, d / 4);
      const ax = dx + t.comVel[0] * lead - uz * this.aimErr * k, az = dz + t.comVel[2] * lead + ux * this.aimErr * k + p.field.dirZ * LEVERAGE * k;
      const n = Math.hypot(ax, az) || 1e-6;
      this.run(me, ax / n * FULL, az / n * FULL, dt, c);
    } else {
      const along = t.comVel[0] * ux + t.comVel[2] * uz, close = this.phase === 'breakdown' ? BREAK_V : STRIKE_V;
      const mine = Math.max(close, along + close), vx = t.comVel[0] - along * ux + ux * mine, vz = t.comVel[2] - along * uz + uz * mine;
      // a cut needs a cut to mirror it: plant when the way to go has swung well off the run
      const vn = Math.hypot(vx, vz), plant = p.time >= this.plantFree && sp > PLANT_RUN && vn > 1 && (me.comVel[0] * vx + me.comVel[2] * vz) / (sp * vn) < Math.cos(PLANT_ANGLE);
      if (plant) {
        this.plantSide = me.comVel[2] * vx - me.comVel[0] * vz > 0 ? 1 : -1;
        this.plantUntil = p.time + PLANT_HOLD; this.plantFree = p.time + PLANT_GAP;
      }
      if (p.time < this.plantUntil) c.plantCut = this.plantSide;
      this.run(me, vx, vz, dt, c, plant);
    }
    c.gait = 'sprint';
    c.contactMode = d < 4;
    if (this.phase === 'breakdown') {
      c.chopFeet = true; c.sink = 0.45; c.face = { x: dx / d, z: dz / d };
      return;
    }
    if (this.phase !== 'strike') return;
    // drive the legs only once on him: it shortens the stride, so it would slow the last steps in
    c.sink = 0.35; c.lean.fwd = 0.35; c.driveLegs = d < WRAP ? 1 : 0;
    c.armL = c.armR = 1; c.gripL = c.gripR = true; c.wrap = d < WRAP;
    c.aim = [t.pelvis[0], t.pelvis[1] + 0.3, t.pelvis[2]];
    if (d < THRUST) { c.thrustHips = true; c.sink = 0; c.lean.fwd = 0; }
    // slipping away just out of reach: lay out for him
    const later = Math.hypot(dx + rvx * 0.3, dz + rvz * 0.3);
    if (!this.dived && sp > DIVE_RUN && (closing < DIVE_CLOSE || later > DIVE_MISS) && this.onLine(me, dx + rvx * DIVE_T, dz + rvz * DIVE_T, sp)) {
      c.dive = true; this.dived = true;
    }
  }

  /** Run to a loose ball and dive on it (the torso landing on it is what recovers it). */
  private recover(me: AthleteView, ball: { pos: Vec3; vel: Vec3 }, dt: number, c: Commands) {
    const aim: [number, number] = [ball.pos[0] + ball.vel[0] * 0.2, ball.pos[2] + ball.vel[2] * 0.2];
    const dx = aim[0] - me.com[0], dz = aim[1] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    const sp = Math.hypot(me.comVel[0], me.comVel[2]);
    this.phase = 'pursue';
    c.gait = 'sprint';
    c.armL = c.armR = d < 3 ? 1 : 0; c.gripL = c.gripR = d < 2;
    c.aim = [ball.pos[0], ball.pos[1], ball.pos[2]];
    const v = d < BALL_DROP ? 1.5 : d < 4 ? 5 : FULL;
    this.run(me, dx / d * v, dz / d * v, dt, c);
    if (d < BALL_DROP) { c.sink = 1; c.lean.fwd = 1; return; }
    const x = dx + (ball.vel[0] - me.comVel[0]) * DIVE_T, z = dz + (ball.vel[2] - me.comVel[2]) * DIVE_T;
    if (!this.dived && sp > 1 && this.onLine(me, x, z, sp)) { c.dive = true; this.dived = true; }
  }

  /** Whether a point (relative x, z) lies DIVE_D ahead along the current run and within DIVE_SIDE of its line. */
  private onLine(me: AthleteView, x: number, z: number, sp: number) {
    const ux = me.comVel[0] / sp, uz = me.comVel[2] / sp, along = x * ux + z * uz;
    return along > DIVE_D[0] && along < DIVE_D[1] && Math.abs(x * uz - z * ux) < DIVE_SIDE;
  }

  /** Smallest positive time at which running at PURSUE_V meets the target (s), capped at LEAD_MAX. */
  private intercept(dx: number, dz: number, v: Vec3) {
    const a = v[0] * v[0] + v[2] * v[2] - PURSUE_V * PURSUE_V, b = 2 * (dx * v[0] + dz * v[2]), cc = dx * dx + dz * dz;
    if (a >= 0) return LEAD_MAX;
    return Math.min(LEAD_MAX, (-b - Math.sqrt(b * b - 4 * a * cc)) / (2 * a));
  }

  /** Move toward a ground velocity (m/s, world): the heading turns no faster than footing allows at this speed
   *  (or jumps, on a plant) and the magnitude is filtered, so the command does not chatter. */
  private run(me: AthleteView, vx: number, vz: number, dt: number, c: Commands, snap = false) {
    const n = Math.hypot(vx, vz);
    if (Number.isNaN(this.heading)) this.heading = me.heading;
    if (n > 1e-3) {
      const d = wrapAngle(Math.atan2(vx, vz) - this.heading), w = turnRate(Math.hypot(me.comVel[0], me.comVel[2])) * dt;
      this.heading = wrapAngle(this.heading + (snap ? d : clamp(d, -w, w)));
    }
    this.mag += (Math.min(1, n / FULL) - this.mag) * (1 - Math.exp(-dt / MOVE_TAU));
    c.move = { x: Math.sin(this.heading) * this.mag, z: Math.cos(this.heading) * this.mag };
  }
}
