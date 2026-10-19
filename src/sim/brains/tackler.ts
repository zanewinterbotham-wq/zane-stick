// Bot tackler: pursues the ball carrier on an intercept course (leading him and staying on his goal side), breaks
// down near contact (sinks and chops the feet so a cut can be mirrored), then strikes: drives through with both
// arms wrapping and gripping and rolls the hips at contact, and dives when the carrier is slipping just out of
// reach. With nobody holding the ball it runs to it and picks it up by hand. Reads the world through a reaction delay;
// difficulty is only that delay, how far ahead it leads, and aim noise. Same Commands as a human. Hurt, it plays on:
// on a broken leg it plans its angles at a hobble; a broken arm simply does nothing (World), the other one tackles.
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type Commands } from '../control/types';
import { HOBBLE } from '../injury';
import { clamp, wrapAngle, type Vec3 } from '../math';
import type { Rng } from '../rng';
import type { BotDifficulty } from './carrier';
import { blockerInWay, shed, shedSide } from './shed';
import type { AthleteView, Brain, Perception } from './types';

/** Speed the intercept is planned at (m/s) and its longest lead (s); aim this far to the carrier's goal side
 *  so a cut-back stays in front (m). */
const PURSUE_V = 9, LEAD_MAX = 2.5, LEVERAGE = 0.7;
/** With a teammate nearer the carrier, pursue this far (m) to my side of his line, so the two come at different angles. */
const SPREAD = 2;
/** Break down (under control, closing at BREAK_V) inside BREAK_TTC s of contact, or BREAK_D m, when closing faster
 *  than BREAK_CLOSE m/s (chasing from behind there is nothing to mirror); at most BREAK_MAX s. */
const BREAK_TTC: [number, number] = [0.9, 1.1], BREAK_D = 6, BREAK_CLOSE = 3, BREAK_MAX = 1.5;
/** Also break down inside BREAK_NEAR m of a carrier in front who is not running away (coming back on him after a
 *  miss), and never lead him more than OUT_LEAD m out of bounds (the wall is 5 m beyond the sideline). */
const BREAK_NEAR = 3.5, OUT_LEAD = 2;
/** Strike inside this distance (m, COM to COM), wrap inside WRAP, roll the hips inside THRUST; give up the
 *  strike and pursue again beyond MISS. */
const STRIKE = 1.9, WRAP = 1.3, THRUST = 0.8, MISS = 4.5;
/** Dive at a carrier who is getting away (closing slower than DIVE_CLOSE m/s, or still more than DIVE_MISS m away
 *  0.3 s on) when, DIVE_T s ahead with both running on, he would be DIVE_D m ahead along the run (the dive follows
 *  the run, faster than DIVE_RUN m/s, and lays the body out about that far) and within DIVE_SIDE m of its line. */
const DIVE_D: [number, number] = [0.3, 2.2], DIVE_T = 0.4, DIVE_SIDE = 0.8, DIVE_CLOSE = 1.5, DIVE_MISS = 1.5, DIVE_RUN = 2;
/** Loose ball: longest lead on a rolling ball (s), the deceleration the run is planned to stop on it with (m/s²), the
 *  slowest approach (m/s), the distance inside which the hands reach for it, and how far short of it the run stops (m). */
const BALL_LEAD = 0.5, BALL_BRAKE = 5, BALL_V = 1.2, BALL_REACH = 1.6, BALL_SHORT = 0.25;
/** Closing speed while breaking down and while striking (m/s); the move command's filter time (s). */
const BREAK_V = 3, STRIKE_V = 6, MOVE_TAU = 0.08;
const FULL = GAIT_SPEED.sprint;
/** Plant and cut (as a carrier does) when the wanted direction is PLANT_ANGLE rad off a run faster than
 *  PLANT_RUN m/s; the command is held PLANT_HOLD s, and the next one waits PLANT_GAP s (the cut lasts 0.45 s). */
const PLANT_ANGLE = 0.6, PLANT_RUN = 2.5, PLANT_HOLD = 0.1, PLANT_GAP = 0.6;

/** Sideways acceleration a run can turn with (m/s², ~0.6 g) and the fastest heading change (rad/s): at speed a
 *  heading swung faster than the feet can follow leaves the body facing off its run, and it falls. */
const LAT_ACCEL = 3.5, TURN_MAX = 6;
/** AI tackling skill 0..1 (difficulty): how late the tackler sees a cut (reaction, s) and how noisy his angles and
 *  reads are. 0.5 is about the old fixed bot; 1 reads a juke within ~0.12 s. Nothing else about him changes. */
export const tacklerSkill = (k: number): BotDifficulty => ({ reaction: 0.12 + 0.28 * (1 - k), noise: 0.08 + 0.4 * (1 - k) });

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
  private side: -1 | 1 = 1;
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
    const ti = seen.athletes.findIndex((a) => a.hasBall && a.team !== me.team);
    // shortcut: a tackler that recovers the ball, or whose teammate has it, just holds still; the play gives him a
    // carrier or blocker brain on every change of possession.
    if (me.down || me.hasBall || (ti < 0 && seen.athletes.some((a) => a.hasBall))) return c;
    if (ti >= 0) {
      const t = predict(seen.athletes[ti], p.time - seen.time);
      const b = t.down ? null : blockerInWay(seen, me, t);
      if (b) {
        // a blocker between us: get off him first (shed.ts)
        this.side = shedSide(me, b, t, this.side); this.phase = 'pursue';
        const [vx, vz] = shed(me, b, t, this.side, c);
        this.run(me, vx, vz, dt, c);
      } else if (t.down) this.touch(me, t, dt, c); else this.tackle(p, me, t, dt, c);
    }
    else if (seen.ball) this.recover(me, seen.ball, p.time - seen.time, dt, c);
    return c;
  }

  /** A ball carrier on the turf (e.g. after recovering a fumble with a dive) is down once an opponent touches him:
   *  hurry over and reach down to him. */
  private touch(me: AthleteView, t: AthleteView, dt: number, c: Commands) {
    const dx = t.com[0] - me.com[0], dz = t.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    const v = Math.min(FULL, 1.5 + 1.2 * d); // flat out from afar, easing in to land on him under control
    this.run(me, dx / d * v, dz / d * v, dt, c);
    c.gait = 'sprint'; c.contactMode = d < 4; c.face = { x: dx / d, z: dz / d };
    if (d < 2) { c.sink = 0.8; c.lean.fwd = 0.6; c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = t.pelvis; }
  }

  private tackle(p: Perception, me: AthleteView, t: AthleteView, dt: number, c: Commands) {
    const dx = t.com[0] - me.com[0], dz = t.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    const rvx = t.comVel[0] - me.comVel[0], rvz = t.comVel[2] - me.comVel[2];
    const closing = -(rvx * dx + rvz * dz) / d;
    if (p.time >= this.aimUntil) { this.aimErr = this.rng.gauss() * this.diff.noise * 0.8; this.aimUntil = p.time + 0.5; }
    // ---- phase
    // he is in front of the way I am running (striking at someone behind me only trips me up)
    const sp = Math.hypot(me.comVel[0], me.comVel[2]), front = sp < 1 || (me.comVel[0] * dx + me.comVel[2] * dz) / (sp * d) > 0.2;
    // back on him after a miss, slower: in close and not running away from me, break down again before striking
    const near = d < BREAK_NEAR && front && (t.comVel[0] * dx + t.comVel[2] * dz) / d < BREAK_CLOSE;
    if (this.phase === 'pursue') {
      if ((closing > BREAK_CLOSE && (d / closing < this.breakTtc || d < BREAK_D)) || (near && d > STRIKE)) { this.phase = 'breakdown'; this.phaseUntil = p.time + BREAK_MAX; }
      else if (d < STRIKE && front) this.phase = 'strike';
    } else if (this.phase === 'breakdown') {
      if (d < STRIKE) this.phase = 'strike';
      else if (p.time >= this.phaseUntil || !front) this.phase = 'pursue';
    } else if (this.phase === 'strike' && (d > MISS || (!front && d > 1) || (closing < 0 && d > STRIKE + 0.5))) { this.phase = 'pursue'; if (d > MISS) this.dived = false; }
    // ---- how to run: flat out at the intercept; in close, mirror his movement across the line to him and close
    // on him at the breakdown's or the strike's pace (on top of his own speed away, when chasing)
    const ux = dx / d, uz = dz / d;
    if (this.phase === 'pursue') {
      const lead = this.intercept(dx, dz, t.comVel, PURSUE_V * (me.lame ? HOBBLE.speed : 1)) * clamp(1 - this.diff.noise, 0.5, 1);
      // the aim error is across the line to him, the leverage toward his goal, both fading in close
      const k = Math.min(1, d / 4);
      // a teammate nearer him has the straight line: take an angle SPREAD m off it on my side (the cutback lane)
      let mate = -1, md = d, sp = 0;
      p.athletes.forEach((a, i) => { const ad = Math.hypot(t.com[0] - a.com[0], t.com[2] - a.com[2]); if (i !== p.self && a.team === me.team && !a.down && ad < md) { md = ad; mate = i; } });
      if (mate >= 0) sp = (p.athletes[mate].com[0] - me.com[0]) * uz - (p.athletes[mate].com[2] - me.com[2]) * ux > 0 ? -SPREAD : SPREAD;
      let ax = dx + t.comVel[0] * lead - uz * this.aimErr * k + uz * sp * k, az = dz + t.comVel[2] * lead + ux * this.aimErr * k - ux * sp * k + p.field.dirZ * LEVERAGE * k;
      // he cannot run on through the wall: a lead point far out of bounds sent the chase straight into it
      ax = clamp(me.com[0] + ax, -p.field.halfWidth - OUT_LEAD, p.field.halfWidth + OUT_LEAD) - me.com[0];
      const n = Math.hypot(ax, az) || 1e-6;
      this.chase(p, me, ax / n * FULL, az / n * FULL, dt, c);
    } else {
      const along = t.comVel[0] * ux + t.comVel[2] * uz, close = this.phase === 'breakdown' ? BREAK_V : STRIKE_V;
      const mine = Math.max(close, along + close);
      this.chase(p, me, t.comVel[0] - along * ux + ux * mine, t.comVel[2] - along * uz + uz * mine, dt, c);
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

  /** Run to a loose ball and pick it up by hand: flat out only while the way is clear, slowing so the run can still
   *  turn onto the ball (a sprint cannot: it orbits it) and stop on it, then sink and reach down for it. Dives only
   *  at a rolling ball it cannot stop short of. */
  private recover(me: AthleteView, ball: { pos: Vec3; vel: Vec3 }, age: number, dt: number, c: Commands) {
    const bx = ball.pos[0] + ball.vel[0] * age, bz = ball.pos[2] + ball.vel[2] * age;
    const sp = Math.hypot(me.comVel[0], me.comVel[2]);
    // a rolling ball is met where it will be on arrival (it stops soon: the lead is short)
    const t = Math.min(BALL_LEAD, Math.hypot(bx - me.com[0], bz - me.com[2]) / Math.max(sp, 3));
    const dx = bx + ball.vel[0] * t - me.com[0], dz = bz + ball.vel[2] * t - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    this.phase = 'pursue';
    // sine of the angle between the run and the ball (a right angle at most): the arc that meets it has radius d / (2 sin)
    const cos = sp > 1 ? (me.comVel[0] * dx + me.comVel[2] * dz) / (sp * d) : 1, sin = cos < 0 ? 1 : Math.sqrt(1 - cos * cos);
    // stop BALL_SHORT short of it (the stoop reaches that far); on the way slow only as far as needed
    const ds = Math.max(d - BALL_SHORT, 0);
    const v = ds < 0.05 ? 0 : clamp(Math.min(FULL, Math.sqrt(2 * BALL_BRAKE * ds), Math.sqrt(LAT_ACCEL * d / Math.max(2 * sin, 0.3))), ds > 0.8 ? BALL_V : 0.3, FULL);
    this.run(me, dx / d * v, dz / d * v, dt, c);
    c.gait = v > 6 ? 'sprint' : 'jog';
    if (d < BALL_REACH) {
      // hands to the ball, hips down: the world aims each hand at it and closes on it
      const k = clamp((BALL_REACH - d) / 0.6, 0, 1);
      c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = [ball.pos[0], ball.pos[1], ball.pos[2]];
      c.sink = 0.5 * k; c.lean.fwd = k;
    }
    const x = dx + (ball.vel[0] - me.comVel[0]) * DIVE_T, z = dz + (ball.vel[2] - me.comVel[2]) * DIVE_T;
    // only at a ball still rolling away: a dive at one lying still pushes it on and costs the get-up
    const rolling = Math.hypot(ball.vel[0], ball.vel[2]) > 1;
    if (!this.dived && rolling && sp > 4 && sp * sp > 2 * (BALL_BRAKE - 1) * d && this.onLine(me, x, z, sp)) { c.dive = true; this.dived = true; }
  }

  /** Run after the carrier toward a ground velocity: a way to go that swings well off the run (a juke, a miss) is
   *  answered with a plant and cut at speed, and turned to at once when slow, never bent in over a long arc. */
  private chase(p: Perception, me: AthleteView, vx: number, vz: number, dt: number, c: Commands) {
    const sp = Math.hypot(me.comVel[0], me.comVel[2]), vn = Math.hypot(vx, vz);
    const off = vn > 1 && sp > 0.5 && (me.comVel[0] * vx + me.comVel[2] * vz) / (sp * vn) < Math.cos(PLANT_ANGLE);
    const plant = off && sp > PLANT_RUN && p.time >= this.plantFree;
    if (plant) {
      this.plantSide = me.comVel[2] * vx - me.comVel[0] * vz > 0 ? 1 : -1;
      this.plantUntil = p.time + PLANT_HOLD; this.plantFree = p.time + PLANT_GAP;
    }
    if (p.time < this.plantUntil) c.plantCut = this.plantSide;
    this.run(me, vx, vz, dt, c, plant, off && sp <= PLANT_RUN);
  }

  /** Whether a point (relative x, z) lies DIVE_D ahead along the current run and within DIVE_SIDE of its line. */
  private onLine(me: AthleteView, x: number, z: number, sp: number) {
    const ux = me.comVel[0] / sp, uz = me.comVel[2] / sp, along = x * ux + z * uz;
    return along > DIVE_D[0] && along < DIVE_D[1] && Math.abs(x * uz - z * ux) < DIVE_SIDE;
  }

  /** Smallest positive time at which running at `speed` (PURSUE_V, or a hobble) meets the target (s), capped at LEAD_MAX. */
  private intercept(dx: number, dz: number, v: Vec3, speed: number) {
    const a = v[0] * v[0] + v[2] * v[2] - speed * speed, b = 2 * (dx * v[0] + dz * v[2]), cc = dx * dx + dz * dz;
    if (a < 0) return Math.min(LEAD_MAX, (-b - Math.sqrt(b * b - 4 * a * cc)) / (2 * a));
    // he is the faster (a hobbling tackler): still met if he is coming at me, else lead him the most
    const disc = b * b - 4 * a * cc;
    if (b >= 0 || disc < 0) return LEAD_MAX;
    return Math.min(LEAD_MAX, a < 1e-9 ? -cc / b : (-b - Math.sqrt(disc)) / (2 * a));
  }

  /** Move toward a ground velocity (m/s, world): the heading turns no faster than footing allows at this speed
   *  (or jumps, on a plant) and the magnitude is filtered, so the command does not chatter. */
  private run(me: AthleteView, vx: number, vz: number, dt: number, c: Commands, snap = false, pivot = false) {
    const n = Math.hypot(vx, vz);
    if (Number.isNaN(this.heading)) this.heading = me.heading;
    if (n > 1e-3) {
      const d = wrapAngle(Math.atan2(vx, vz) - this.heading), w = (pivot ? TURN_MAX : turnRate(Math.hypot(me.comVel[0], me.comVel[2]))) * dt;
      this.heading = wrapAngle(this.heading + (snap ? d : clamp(d, -w, w)));
    }
    this.mag += (Math.min(1, n / FULL) - this.mag) * (1 - Math.exp(-dt / MOVE_TAU));
    c.move = { x: Math.sin(this.heading) * this.mag, z: Math.cos(this.heading) * this.mag };
  }
}
