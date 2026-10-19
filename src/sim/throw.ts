// Pass flight (docs/passing.md): the launch velocity that lands a throw on a point, and where to throw so a running
// receiver meets it. Pure: the World, the bot QB and the shell's aim previews share it. Gravity only (the scene has no
// air drag on the ball), so the flight is a parabola.
import type { Vec3 } from './math';

const G = 9.81;
/** Fastest release an arm throws (m/s): ~27 m/s (60 mph), the top of NFL combine QB radar readings (the sim branch
 *  documents the source in docs/realism-sources.md). */
export const ARM_SPEED = 27;
/** Launch angle of a full-loft lob (rad, 50°); loft 0 is the flattest angle the arm speed allows. */
const LOB = 50 * Math.PI / 180;

/** The launch velocity from `from` that reaches `at`, and the flight time (s). Loft 0..1 moves the launch angle from
 *  the flattest one reachable at ARM_SPEED (a bullet) to LOB (or the steepest reachable, if lower); a point out of
 *  the arm's range gets the farthest throw toward it (ARM_SPEED at the best angle), which falls short. */
export function throwVelocity(from: Vec3, at: Vec3, loft: number): { vel: Vec3; time: number } {
  const dx = at[0] - from[0], dz = at[2] - from[2], h = at[1] - from[1], d = Math.max(Math.hypot(dx, dz), 0.1);
  const ux = Math.hypot(dx, dz) > 1e-6 ? dx / d : 0, uz = Math.hypot(dx, dz) > 1e-6 ? dz / d : 1;
  const V = ARM_SPEED, disc = V ** 4 - G * (G * d * d + 2 * h * V * V);
  let th: number, v: number;
  if (disc < 0) { th = Math.PI / 4 + Math.atan2(h, d) / 2; v = V; } // out of range
  else {
    const lo = Math.atan((V * V - Math.sqrt(disc)) / (G * d)), hi = Math.atan((V * V + Math.sqrt(disc)) / (G * d));
    th = lo + Math.min(1, Math.max(0, loft)) * Math.max(0, Math.min(hi, LOB) - lo);
    const c = Math.cos(th);
    v = Math.min(V, Math.sqrt(G * d * d / (2 * c * c * (d * Math.tan(th) - h))));
  }
  const vh = v * Math.cos(th), vy = v * Math.sin(th);
  // out of range: the time it comes back down to the point's height, short of it
  const time = disc < 0 ? (vy + Math.sqrt(Math.max(0, vy * vy - 2 * G * h))) / G : d / vh;
  return { vel: [ux * vh, vy, uz * vh], time };
}

/** Where to throw from `from` so a receiver at `target.pos` running on at `target.vel` (along the ground) meets the
 *  ball: the flight time and the lead are iterated to agree. The point keeps the receiver's height. */
export function leadPoint(from: Vec3, target: { pos: Vec3; vel: Vec3 }, loft: number): Vec3 {
  const { pos, vel } = target;
  let at: Vec3 = [pos[0], pos[1], pos[2]];
  for (let k = 0; k < 8; k++) {
    const t = throwVelocity(from, at, loft).time;
    at = [pos[0] + vel[0] * t, pos[1], pos[2] + vel[2] * t];
  }
  return at;
}
