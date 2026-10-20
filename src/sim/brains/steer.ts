// The bot brains' steering: a wanted ground velocity (m/s, world) becomes Commands.move, the heading turning no faster
// than footing allows and the magnitude filtered so the command does not chatter. Every bot brain holds one Steer and
// passes its own turn rate; the float operations keep the order the brains' own copies had (state hashes, bench/perf).
import { GAIT_SPEED } from '../control/hand';
import type { Commands } from '../control/types';
import { clamp, wrapAngle } from '../math';
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
