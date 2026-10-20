// Bot ball carrier: runs for the goal line and reads the tackler (position, velocity, pursuit angle) through a
// reaction delay. It scores candidate paths by how far they stay from where the tackler can get to, commits to
// one for a minimum time, and executes it with smooth bends, or a plant-and-cut (juke) plus a burst when the
// tackler is close; a stutter (hesitation, chopped feet) baits a squared-up tackler first. Difficulty is only
// reaction delay, decision noise, aim noise and juke skill (when the move is made, how hard he bursts out of it).
// Issues ordinary Commands. Without the ball it is a tackler.
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type Commands, type Gait } from '../control/types';
import { HOBBLE } from '../injury';
import { clamp, wrapAngle } from '../math';
import type { Rng } from '../rng';
import { turnRate } from './steer';
import { predict, TacklerBrain } from './tackler';
import type { AthleteView, Brain, Perception } from './types';

/** reaction: delay before the bot sees a change (s); noise: decision and aim noise; juke: 0..1 skill of a carrier's
 *  moves (timing and the burst after them), absent = 1. */
export interface BotDifficulty { reaction: number; noise: number; juke?: number }
export const DIFFICULTY: Record<'easy' | 'normal' | 'hard', BotDifficulty> = {
  easy: { reaction: 0.35, noise: 0.35 }, normal: { reaction: 0.25, noise: 0.2 }, hard: { reaction: 0.15, noise: 0.1 },
};
/** The "AI juking" setting 0..1 as a bot skill: 1 = DIFFICULTY.normal with full moves (the carrier that escapes a
 *  straight-line tackler most reps), 0 = slower to read the tackler, noisier, makes his move too early (the tackler
 *  has time to answer it) and hardly bursts out of it. */
export const carrierSkill = (k: number): BotDifficulty => ({ reaction: 0.25 + JUKE_SKILL.reaction * (1 - k), noise: 0.2 + JUKE_SKILL.noise * (1 - k), juke: k });
/** At juking 0: extra reaction delay (s), extra noise, how much earlier the move is made (s of time to contact), and
 *  the burst share of the sprint speed (the jog's own share: no burst). */
const JUKE_SKILL = { reaction: 0.2, noise: 0.3, early: 0.8, burst: GAIT_SPEED.jog / GAIT_SPEED.sprint };

/** The threat model of a tackler: reach from his COM to a carrier's COM (m), his acceleration (m/s²), top speed
 *  (m/s) and the time before he answers a move (s). Path look-ahead and its step (s). */
const THREAT = { reach: 1.1, accel: 8, vmax: 9.5, react: 0.2 }, HORIZON = 2, PLAN_DT = 0.05;
/** Candidate path headings off the goal direction (rad). */
const OFFSETS = [-1.4, -1.05, -0.7, -0.45, -0.22, 0, 0.22, 0.45, 0.7, 1.05, 1.4];
/** Score weights: margin is worth up to MARGIN_CAP m, progress toward the goal PROGRESS per unit cosine. */
const MARGIN_CAP = 2.5, PROGRESS = 2;
/** A new plan must beat the current one by this much (hysteresis), and is kept at least this long (s). */
const SWITCH = 0.4, COMMIT: [number, number] = [0.45, 0.75];
/** Share of the sprint speed a burst runs at (a cruise gait faster than that is kept): at full sprint a
 *  juked tackler of the same speed could never run him down, however good his angle. */
const BURST = 0.8;
/** Engaged (moves allowed, bursts to a sprint) inside this distance (m) or time to contact (s). */
const ENGAGE_D = 9, ENGAGE_TTC = 1.6;
/** A heading change larger than this (rad) at speed is done as a plant-and-cut; smaller ones are bent in at
 *  BEND rad/s. The cut command is held PLANT s (the animator reads its rising edge), the lean LEAN s. */
const JUKE = 0.5, BEND = 2, PLANT = 0.12, LEAN = 0.45;
/** Largest heading change one plant takes: JUKE_REACH / speed (rad), at most JUKE_MAX. */
const JUKE_REACH = 5, JUKE_MAX = 1.3;
/** Juke trigger: time to contact (s) or distance (m); a stutter's length (s) and chance per approach. */
const JUKE_TTC: [number, number] = [0.55, 0.9], JUKE_D = 4, STUTTER: [number, number] = [0.25, 0.4], STUTTER_P = 0.35;
/** An opponent with a blocker of mine within HELD m (COM to COM) is engaged: HELD_COST m less of a threat. */
const HELD = 1.2, HELD_COST = 4;
/** A path that runs within MATE_CLEAR m (COM to COM) of a standing team mate costs MATE_COST per m short of it: he
 *  runs off his blocker's hip, not into his back (a bump strips the ball as well as a hit does). */
const MATE_CLEAR = 0.85, MATE_COST = 6;
/** Pressing the block: a team mate within MATE_AHEAD m ahead along the run and MATE_SIDE m of its line slows the
 *  carrier (to MATE_SLOW of his pace at MATE_CLEAR m), so a block driven back does not meet him at full speed. */
const MATE_AHEAD = 3.2, MATE_SIDE = 0.9, MATE_SLOW = 0.2;

export type CarrierMove = 'run' | 'bend' | 'cut' | 'cutback' | 'sideline' | 'stutter' | 'past';

export class CarrierBrain implements Brain {
  private history: Perception[] = [];
  /** Committed plan: heading offset from the goal direction, until when it is kept, and whether it is a move. */
  private plan = { off: 0, until: 0, juked: false };
  private heading = NaN;          // commanded heading, ramped (rad, 0 = +Z)
  private mag = 0;
  private plantUntil = 0; private plantSide: -1 | 0 | 1 = 0; private leanUntil = 0;
  private stutterUntil = -Infinity; private stuttered = false;
  private burst = false; private burstK = NaN;
  private trigger = NaN;
  private tackler: TacklerBrain;
  /** The move being run (HUD, tests). */
  move: CarrierMove = 'run';
  /** Number of plant-and-cuts made (tests, benchmarks). */
  jukes = 0;
  private skill: number;
  constructor(private rng: Rng, private diff: BotDifficulty, private gait: Gait = 'jog', private carryArm: 1 | 2 = 2) {
    this.tackler = new TacklerBrain(rng, diff);
    this.skill = diff.juke ?? 1;
  }

  think(p: Perception, dt = 1 / 240): Commands {
    const me = p.athletes[p.self];
    // a fumble turns the carrier into a defender: recover the ball, or tackle whoever has it
    if (!me.hasBall) return this.tackler.think(p, dt);
    const c = neutralCommands();
    c.carry = this.carryArm;
    c.gait = this.gait;
    this.history.push(p);
    // what the carrier "sees" is the world as it was a reaction time ago
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    const seen = this.history[0];
    const goalH = p.field.dirZ > 0 ? 0 : Math.PI;
    if (Number.isNaN(this.heading)) this.heading = goalH;
    if (me.down) return c;
    // nearest standing opponent as seen; one locked up with a blocker of mine counts HELD_COST m farther, so the run
    // follows the block (hits the hole beside it) and reads the free man
    let opp: AthleteView | null = null, best = Infinity;
    seen.athletes.forEach((a, i) => {
      if (a.team === me.team || a.down) return;
      const held = seen.athletes.some((b, j) => j !== p.self && b.team === me.team && !b.down && Math.hypot(b.com[0] - a.com[0], b.com[2] - a.com[2]) < HELD);
      const d = Math.hypot(a.com[0] - me.com[0], a.com[2] - me.com[2]) + (held ? HELD_COST : 0);
      if (d < best) { best = d; opp = predict(a, p.time - seen.time); }
    });
    let target = goalH, magT = 1, sprint = this.burst;
    if (opp) {
      const o = opp as AthleteView, dx = o.com[0] - me.com[0], dz = o.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1;
      const ahead = dz * p.field.dirZ;
      const closing = -((o.comVel[0] - me.comVel[0]) * dx + (o.comVel[2] - me.comVel[2]) * dz) / d;
      const ttc = d / Math.max(closing, 0.5);
      if (ahead < -1) {
        this.move = 'past'; sprint = this.burst = true;
        this.plan.off = 0;
      } else {
        const engaged = d < ENGAGE_D || ttc < ENGAGE_TTC;
        // a squared-up tackler closing fast is baited once with a stutter
        const lateral = Math.abs(dx * Math.cos(goalH) - dz * Math.sin(goalH));
        if (engaged && Number.isNaN(this.trigger)) this.trigger = this.rng.range(...JUKE_TTC) + this.diff.noise * this.rng.gauss() * 0.2 + JUKE_SKILL.early * (1 - this.skill);
        if (engaged && !this.stuttered && d > 5 && lateral < 1.5 && closing > 5) {
          this.stuttered = true;
          if (this.rng.next() < STUTTER_P) this.stutterUntil = p.time + this.rng.range(...STUTTER);
        }
        if (p.time < this.stutterUntil) {
          this.move = 'stutter';
          magT = 0.3; c.chopFeet = true; c.lean.fwd = 0.15;
        } else {
          const moveNow = engaged && (ttc < this.trigger || d < JUKE_D);
          if (p.time >= this.plan.until || (moveNow && !this.plan.juked)) this.decide(p, me, o, goalH, moveNow);
          if (engaged) sprint = this.burst = this.burst || this.plan.juked;
        }
        target = goalH + this.plan.off;
      }
    }
    // press the block: ease off behind a team mate in the way until the path the planner picks gets round him
    const hx = Math.sin(this.heading), hz = Math.cos(this.heading);
    for (const [j, b] of p.athletes.entries()) {
      if (j === p.self || b.team !== me.team || b.down) continue;
      const rx = b.com[0] - me.com[0], rz = b.com[2] - me.com[2], along = rx * hx + rz * hz, side = Math.abs(rx * hz - rz * hx);
      if (along > 0 && along < MATE_AHEAD && side < MATE_SIDE) magT = Math.min(magT, clamp(MATE_SLOW + (1 - MATE_SLOW) * (along - MATE_CLEAR) / (MATE_AHEAD - MATE_CLEAR), MATE_SLOW, 1));
    }
    // stay in bounds: past the tackler nothing else steers, so the sideline does
    const margin = p.field.halfWidth - Math.abs(me.com[0]);
    if (margin < 4) target = wrapAngle(target - Math.sign(me.com[0]) * Math.sign(Math.cos(goalH)) * (4 - margin) * 0.25);
    this.steer(p, me, target, dt, c);
    this.mag += (magT - this.mag) * (1 - Math.exp(-dt / 0.15));
    c.move = { x: Math.sin(this.heading) * this.mag, z: Math.cos(this.heading) * this.mag };
    if (sprint) {
      // the burst's speed ramps up from the cruise speed (the gait switch alone keeps the speed)
      const k0 = GAIT_SPEED[this.gait] / GAIT_SPEED.sprint, k1 = Math.max(k0, BURST - (BURST - JUKE_SKILL.burst) * (1 - this.skill));
      this.burstK = Number.isNaN(this.burstK) ? k0 : this.burstK + (k1 - this.burstK) * (1 - Math.exp(-dt / 0.3));
      c.gait = 'sprint'; c.move.x *= this.burstK; c.move.z *= this.burstK;
    }
    return c;
  }

  /** Pick the path that best keeps away from the tackler while gaining ground; commit to it. */
  private decide(p: Perception, me: AthleteView, o: AthleteView, goalH: number, moveNow: boolean) {
    // a hobbling carrier plans the paths he can run (and makes the most of a hobbling tackler)
    const V = Math.max(GAIT_SPEED[this.gait], BURST * GAIT_SPEED.sprint) * (me.lame ? HOBBLE.speed : 1);
    let bestOff = this.plan.off, bestS = -Infinity, curS = -Infinity;
    for (const off of OFFSETS) {
      const s = this.score(p, me, o, goalH + off, V, off);
      const noisy = s + this.rng.gauss() * this.diff.noise * 0.6;
      if (Math.abs(off - this.plan.off) < 1e-6) curS = s;
      if (noisy > bestS) { bestS = noisy; bestOff = off; }
    }
    if (bestS > curS + SWITCH || p.time >= this.plan.until) {
      // aim noise: where the path is actually run
      this.plan.off = clamp(bestOff + this.rng.gauss() * this.diff.noise * 0.12, -1.5, 1.5);
    }
    this.plan.until = p.time + this.rng.range(...COMMIT);
    if (moveNow) this.plan.juked = true;
  }

  /** Smallest gap (m) the path keeps from the tackler's reachable area, capped, plus progress toward the goal. */
  private score(p: Perception, me: AthleteView, o: AthleteView, h: number, V: number, off: number) {
    const ux = Math.sin(h) * V, uz = Math.cos(h) * V, a = 10 * PLAN_DT;
    let qx = me.com[0], qz = me.com[2], vx = me.comVel[0], vz = me.comVel[2], m = Infinity, mate = Infinity;
    const mates = p.athletes.filter((b, j) => j !== p.self && b.team === p.athletes[p.self].team && !b.down);
    for (let t = PLAN_DT; t <= HORIZON + 1e-9; t += PLAN_DT) {
      const ex = ux - vx, ez = uz - vz, e = Math.hypot(ex, ez);
      if (e > a) { vx += ex * a / e; vz += ez * a / e; } else { vx = ux; vz = uz; }
      qx += vx * PLAN_DT; qz += vz * PLAN_DT;
      const tr = Math.max(0, t - THREAT.react), vmax = THREAT.vmax * (o.lame ? HOBBLE.speed : 1), tv = vmax / THREAT.accel;
      const R = THREAT.reach + (tr < tv ? 0.5 * THREAT.accel * tr * tr : 0.5 * THREAT.accel * tv * tv + vmax * (tr - tv));
      let g = Math.hypot(qx - o.com[0] - o.comVel[0] * t, qz - o.com[2] - o.comVel[2] * t) - R;
      const out = Math.abs(qx) - (p.field.halfWidth - 1);
      if (out > 0) g = Math.min(g, -2 * out);
      m = Math.min(m, g);
      for (const b of mates) mate = Math.min(mate, Math.hypot(qx - b.com[0] - b.comVel[0] * t, qz - b.com[2] - b.comVel[2] * t));
    }
    // keep the tackler on the off-arm side (ball away from him) when it costs nothing
    const left = (o.com[0] - me.com[0]) * Math.cos(h) - (o.com[2] - me.com[2]) * Math.sin(h); // + = tackler on the left
    const offArm = this.carryArm === 2 ? 1 : -1;
    return Math.min(m, MARGIN_CAP) + PROGRESS * Math.cos(off) + (left * offArm > 0 ? 0.15 : 0) - MATE_COST * Math.max(0, MATE_CLEAR - mate);
  }

  /** Ramp the commanded heading toward the target: bend it in, or plant and cut when the change is big. */
  private steer(p: Perception, me: AthleteView, target: number, dt: number, c: Commands) {
    const d = wrapAngle(target - this.heading), speed = Math.hypot(me.comVel[0], me.comVel[2]);
    if (Math.abs(d) > JUKE && speed > 2.5 && this.plan.juked && p.time >= this.plantUntil + LEAN) {
      // the faster the run, the less of the turn one plant can take; the rest is bent in
      const jump = clamp(JUKE_REACH / speed, JUKE, JUKE_MAX);
      this.heading = wrapAngle(this.heading + clamp(d, -jump, jump));
      this.plantSide = d > 0 ? 1 : -1;
      this.plantUntil = p.time + PLANT; this.leanUntil = p.time + LEAN;
      this.jukes++;
      // name it: back against the tackler's flow, toward the near sideline, or away from him
      this.move = this.classify(me, target);
    } else {
      const w = Math.min(BEND, turnRate(speed)) * dt;
      this.heading = wrapAngle(this.heading + clamp(d, -w, w));
      if (p.time >= this.leanUntil && p.time >= this.stutterUntil && this.move !== 'past') this.move = Math.abs(d) > 0.05 ? 'bend' : 'run';
    }
    if (p.time < this.plantUntil) c.plantCut = this.plantSide;
    // lean into the cut (the turn's own lean comes from the animator's lateral acceleration)
    if (p.time < this.leanUntil) c.lean.side = 0.5 * this.plantSide;
  }

  private classify(me: AthleteView, h: number): CarrierMove {
    const hx = Math.sin(h);
    if (Math.abs(hx) > 0.6 && hx * me.com[0] > 0 && Math.abs(me.com[0]) > 5) return 'sideline';
    return me.comVel[0] * hx < 0 ? 'cutback' : 'cut';
  }
}
