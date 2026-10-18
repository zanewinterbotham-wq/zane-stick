// Shedding a blocker (a defender's move, used by TacklerBrain): with a blocker in the way to the ball carrier, step
// round him on the carrier's side, both arms punching him off (no grip: the hands must stay free for the tackle),
// hips low and legs driving, eyes on the carrier. Whether he gets off the block is physics.
import type { Commands } from '../control/types';
import type { AthleteView, Perception } from './types';

/** A blocker counts as in the way inside SHED_D (m, COM to COM) when he is nearer than the carrier and within
 *  SHED_COS of the line to him, or inside ENGAGED whatever the angle (locked up with me), but never once the carrier
 *  is inside REACH (m): then the tackle comes first, blocker or not. The step round passes him SHED_WIDE m to the
 *  side and SHED_AHEAD m on, at SHED_V m/s. */
const SHED_D = 1.8, SHED_COS = 0.5, ENGAGED = 1.1, REACH = 1.7, SHED_WIDE = 0.9, SHED_AHEAD = 0.6, SHED_V = 5;

/** The opponent without the ball who stands between me and the carrier `t`, or null. */
export function blockerInWay(seen: Perception, me: AthleteView, t: AthleteView): AthleteView | null {
  const tx = t.com[0] - me.com[0], tz = t.com[2] - me.com[2], td = Math.hypot(tx, tz) || 1e-6;
  if (td < REACH) return null;
  let best: AthleteView | null = null, bd = Infinity;
  for (const b of seen.athletes) {
    if (b.team === me.team || b.hasBall || b.down) continue;
    const bx = b.com[0] - me.com[0], bz = b.com[2] - me.com[2], d = Math.hypot(bx, bz) || 1e-6;
    const between = d < SHED_D && d < td && (bx * tx + bz * tz) / (d * td) > SHED_COS;
    if ((between || d < ENGAGED) && d < bd) { best = b; bd = d; }
  }
  return best;
}

/** Ground velocity (m/s, world) that steps round blocker `b` on the carrier's side (`side` +1 = left of the line to
 *  the blocker), and the shed's commands. */
export function shed(me: AthleteView, b: AthleteView, t: AthleteView, side: 1 | -1, c: Commands): [number, number] {
  const bx = b.com[0] - me.com[0], bz = b.com[2] - me.com[2], d = Math.hypot(bx, bz) || 1e-6, ux = bx / d, uz = bz / d;
  // left of a run along (ux, uz) is (uz, −ux) (facing +Z, left is +X)
  const px = b.com[0] + uz * side * SHED_WIDE + ux * SHED_AHEAD - me.com[0], pz = b.com[2] - ux * side * SHED_WIDE + uz * SHED_AHEAD - me.com[2];
  const n = Math.hypot(px, pz) || 1e-6;
  c.contactMode = true; c.gait = 'sprint';
  c.sink = 0.35; c.lean.fwd = 0.3; c.driveLegs = 1;
  c.armL = c.armR = 1; c.gripL = c.gripR = false;
  c.aim = [b.pelvis[0], b.pelvis[1] + 0.45, b.pelvis[2]];
  const fx = t.com[0] - me.com[0], fz = t.com[2] - me.com[2], f = Math.hypot(fx, fz) || 1e-6;
  c.face = { x: fx / f, z: fz / f };
  return [px / n * SHED_V, pz / n * SHED_V];
}

/** Which side of the line from me to the blocker the carrier is on (+1 left), or `prev` when he is straight behind. */
export function shedSide(me: AthleteView, b: AthleteView, t: AthleteView, prev: 1 | -1): 1 | -1 {
  const bx = b.com[0] - me.com[0], bz = b.com[2] - me.com[2], tx = t.com[0] - me.com[0], tz = t.com[2] - me.com[2];
  // t along the left of the line to b, (bz, −bx)
  const cr = tx * bz - tz * bx, n = Math.hypot(bx, bz) * Math.hypot(tx, tz) || 1e-6;
  return Math.abs(cr / n) < 0.15 ? prev : cr > 0 ? 1 : -1;
}
