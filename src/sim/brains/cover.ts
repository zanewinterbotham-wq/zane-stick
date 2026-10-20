// Bot kick coverage (kickoff, punt): runs down the field in his lane, keeping his spacing from the men beside him,
// and squeezes toward the ball only as he gets near it. The outermost men keep contain: they stay outside the
// returner, turning him back inside, and do not overrun him; the safety (the kicker, the punter) trails deep as the
// last line. A blocker in the lane is shed, not run round. Once the returner has the ball and is near, or is past
// him, he is a tackler (TacklerBrain) for the rest of the play. Reads the world through a reaction delay; difficulty
// is only that delay and how far off his lane he runs. Same Commands as a human.
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type Commands } from '../control/types';
import { clamp, type Vec3 } from '../math';
import type { Rng } from '../rng';
import type { BotDifficulty } from './carrier';
import { fallTime } from './returner';
import { blockerInWay, shed, shedSide } from './shed';
import { Steer } from './steer';
import { predict, TacklerBrain } from './tackler';
import type { AthleteView, Brain, Perception } from './types';

export type CoverRole = 'lane' | 'contain' | 'safety';
/** A cover man's assignment: his lane (x, m) and role. */
export interface CoverLane { x: number; role: CoverRole }

/** Lanes squeeze toward the ball from FAR m out and fully at NEAR, where a lane man takes the tackle; contain keeps
 *  OUTSIDE m outside the ball and takes it inside CONTAIN_NEAR; the safety trails DEEP m behind the ball and comes up
 *  inside SAFETY_NEAR. The run is planned to stop on its spot at BRAKE m/s²; the ball is played at CATCH_H m. */
const FAR = 30, NEAR = 9, OUTSIDE = 3, CONTAIN_NEAR = 5, DEEP = 15, SAFETY_NEAR = 10, BRAKE = 4, CATCH_H = 1.2;
const FULL = GAIT_SPEED.sprint;

export class CoverBrain implements Brain {
  private history: Perception[] = [];
  private steer = new Steer();
  private side: -1 | 1 = 1;
  /** How far off his lane he runs (m): the difficulty's precision. */
  private err: number;
  private tackler: TacklerBrain;
  /** Off his lane for good: a tackler now (tests read it). */
  released = false;
  constructor(rng: Rng, private diff: BotDifficulty, readonly lane: CoverLane) {
    this.tackler = new TacklerBrain(rng, diff);
    this.err = rng.gauss() * diff.noise * 2;
  }

  think(p: Perception, dt = 1 / 240): Commands {
    if (this.released) return this.tackler.think(p, dt);
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    const seen = this.history[0], age = p.time - seen.time, me = p.athletes[p.self], c = neutralCommands();
    if (me.down) return c;
    const ci = seen.athletes.findIndex((a) => a.hasBall), b = seen.ball;
    if (ci >= 0 && seen.athletes[ci].team === me.team) return this.release(p, dt);
    // the ball: the returner, or where the kick comes down
    let at: Vec3;
    if (ci >= 0) at = predict(seen.athletes[ci], age).com;
    else if (b) { const t = Math.max(0, fallTime(b.pos, b.vel, CATCH_H)); at = [b.pos[0] + b.vel[0] * t, CATCH_H, b.pos[2] + b.vel[2] * t]; }
    else return c;
    const down = me.team === 0 ? 1 : -1, held = ci >= 0;
    const d = Math.hypot(at[0] - me.com[0], at[2] - me.com[2]), past = (at[2] - me.com[2]) * down < -1;
    const sq = clamp((FAR - d) / (FAR - NEAR), 0, 1), lx = this.lane.x + this.err, side = Math.sign(this.lane.x) || 1;
    let tx = lx + (at[0] - lx) * sq, tz = at[2];
    if (this.lane.role === 'safety') {
      if (held && (d < SAFETY_NEAR || past)) return this.release(p, dt);
      tx = at[0]; tz = at[2] - down * DEEP;
    } else if (this.lane.role === 'contain') {
      if (held && (d < CONTAIN_NEAR || past)) return this.release(p, dt);
      tx = side * Math.max(side * tx, side * at[0] + OUTSIDE);
    } else if (held && (d < NEAR || past)) return this.release(p, dt);
    tx = clamp(tx, -p.field.halfWidth + 1, p.field.halfWidth - 1);
    const gx = tx - me.com[0], gz = tz - me.com[2], g = Math.hypot(gx, gz) || 1e-6;
    // a blocker in my lane: get off him toward where I am going
    const spot: AthleteView = { ...me, com: [tx, me.com[1], tz], hasBall: false };
    const bl = blockerInWay(seen, me, spot);
    if (bl) {
      this.side = shedSide(me, bl, spot, this.side);
      const [vx, vz] = shed(me, bl, spot, this.side, c);
      this.steer.run(me, vx, vz, dt, c, undefined, false, 0.2);
      return c;
    }
    const v = clamp(Math.sqrt(2 * BRAKE * g), 0, FULL);
    this.steer.run(me, gx / g * v, gz / g * v, dt, c, undefined, false, 0.2);
    c.gait = v > 6 ? 'sprint' : 'jog';
    c.contactMode = d < 4;
    return c;
  }

  private release(p: Perception, dt: number) { this.released = true; return this.tackler.think(p, dt); }
}
