// The bot brains' steering: a wanted ground velocity (m/s, world) becomes Commands.move, the heading turning no faster
// than footing allows and the magnitude filtered so the command does not chatter. Every bot brain holds one Steer and
// passes its own turn rate; the float operations keep the order the brains' own copies had (state hashes, bench/perf).
import { BALL, BALL_AERO } from '../anatomy/equipment';
import { GAIT_SPEED } from '../control/hand';
import { BALL_AREA } from '../physics/aero';
import type { Commands } from '../control/types';
import { clamp, G, wrapAngle } from '../math';
import { BARRIER, outside } from '../modes/rules';
import type { AthleteView, Perception } from './types';

/** The move command's filter time (s); a full command is a sprint. */
const MOVE_TAU = 0.08, FULL = GAIT_SPEED.sprint;
/** Sideways acceleration a run can turn with (m/s², ~0.6 g) and the fastest heading change (rad/s): at speed a
 *  heading swung faster than the feet can follow leaves the body facing off its run, and it falls. */
export const LAT_ACCEL = 3.5;
const TURN_MAX = 6;
export const turnRate = (speed: number) => Math.min(TURN_MAX, LAT_ACCEL / Math.max(speed, 1));
/** Plant and cut (as a carrier does) when the wanted direction is PLANT_ANGLE rad off a run faster than
 *  PLANT_RUN m/s; the command is held PLANT_HOLD s, and the next one waits PLANT_GAP s (the cut lasts 0.45 s). */
const PLANT_ANGLE = 0.6, PLANT_RUN = 2.5, PLANT_HOLD = 0.1, PLANT_GAP = 0.6;

/** A flight is followed down to this height (m: on the turf) in steps of FLY_DT s, at most FLY_T s; drag per speed²
 *  (1/m) of a ball side-on to the flow, the most it can have: the shortest it can fly (aero.ts). */
const TURF_H = 0.2, FLY_DT = 1 / 30, FLY_T = 6, DRAG = 0.5 * BALL_AERO.rho * BALL_AERO.cdSide * BALL_AREA / BALL.mass;
/** A loose ball worth going for: the play is live, the ball is not beyond the lines where the mode's rules make that
 *  dead (rules.ts outside), and it is not in the stands: beyond the barrier, or flying over it (its shortest flight still
 *  clears the wall's top; one that hits the wall comes back into play). */
export function ballInPlay(p: Perception, b = p.ball): boolean {
  if (!b || p.ballLive === false) return false;
  const r = p.field.rules, stands = (x: number, z: number) => Math.abs(x) >= BARRIER.halfWidth || Math.abs(z) >= BARRIER.halfLength;
  if ((r?.outOfBounds && outside(r, b.pos[0], b.pos[2])) || stands(b.pos[0], b.pos[2])) return false;
  let [x, y, z] = b.pos, [vx, vy, vz] = b.vel;
  for (let t = 0; t < FLY_T && y > TURF_H; t += FLY_DT) {
    const sp = Math.hypot(vx, vy, vz);
    vx -= DRAG * sp * vx * FLY_DT; vy -= (G + DRAG * sp * vy) * FLY_DT; vz -= DRAG * sp * vz * FLY_DT;
    x += vx * FLY_DT; y += vy * FLY_DT; z += vz * FLY_DT;
    if (stands(x, z)) return y < BARRIER.height;
  }
  return true;
}

/** Wall keeping: a bot runs at the barrier no faster than lets him stop WALL.margin m short of it at WALL.brake m/s²,
 *  whatever he is after (a ball against the wall is still reached, slowly). */
const WALL = { margin: 0.6, brake: 4 };
/** Caps the outward part of c.move along each axis (Commands only; a no-op away from the walls). */
export function keepOffWall(me: AthleteView, c: Commands) {
  const v = GAIT_SPEED[c.gait];
  const cap = (pos: number, half: number, m: number) => {
    const s = Math.sign(pos), lim = Math.sqrt(2 * WALL.brake * Math.max(0, half - Math.abs(pos) - WALL.margin)) / v;
    return m * s > lim ? s * lim : m;
  };
  const x = cap(me.com[0], BARRIER.halfWidth, c.move.x), z = cap(me.com[2], BARRIER.halfLength, c.move.z);
  if (x !== c.move.x || z !== c.move.z) c.move = { x, z };
}

export class Steer {
  heading = NaN; mag = 0;
  private plantSide: -1 | 1 = 1; private plantUntil = 0; private plantFree = 0;

  /** Move toward (vx, vz): the heading turns at most `rate` rad/s (default: turnRate at his speed), or at once on a
   *  `snap`; with the way behind him (over 90° off the heading) the magnitude is × `reverse` (pull up first, then
   *  turn). The first call starts the heading at `init`. */
  run(me: AthleteView, vx: number, vz: number, dt: number, c: Commands, rate = turnRate(Math.hypot(me.comVel[0], me.comVel[2])), snap = false, reverse = 1, init = me.heading) {
    let n = Math.hypot(vx, vz);
    if (Number.isNaN(this.heading)) this.heading = init;
    if (n > 1e-3) {
      const d = wrapAngle(Math.atan2(vx, vz) - this.heading), w = rate * dt;
      this.heading = wrapAngle(this.heading + (snap ? d : clamp(d, -w, w)));
      if (Math.abs(d) > Math.PI / 2) n *= reverse;
    }
    this.mag += (Math.min(1, n / FULL) - this.mag) * (1 - Math.exp(-dt / MOVE_TAU));
    c.move = { x: Math.sin(this.heading) * this.mag, z: Math.cos(this.heading) * this.mag };
  }

  /** Run after a target (tackler, defensive back): a way to go that swings well off the run (a juke, a miss, a
   *  receiver's break) is answered with a plant and cut at speed and a pivot (TURN_MAX) when slow, never bent in over a
   *  long arc; below `snapV` m/s a step goes any way at once. */
  chase(p: Perception, me: AthleteView, vx: number, vz: number, dt: number, c: Commands, snapV = 0) {
    const sp = Math.hypot(me.comVel[0], me.comVel[2]), vn = Math.hypot(vx, vz);
    const off = vn > 1 && sp > 0.5 && (me.comVel[0] * vx + me.comVel[2] * vz) / (sp * vn) < Math.cos(PLANT_ANGLE);
    const plant = off && sp > PLANT_RUN && p.time >= this.plantFree;
    if (plant) {
      this.plantSide = me.comVel[2] * vx - me.comVel[0] * vz > 0 ? 1 : -1;
      this.plantUntil = p.time + PLANT_HOLD; this.plantFree = p.time + PLANT_GAP;
    }
    if (p.time < this.plantUntil) c.plantCut = this.plantSide;
    this.run(me, vx, vz, dt, c, off && sp <= PLANT_RUN ? TURN_MAX : turnRate(sp), plant || sp < snapV);
  }
}
