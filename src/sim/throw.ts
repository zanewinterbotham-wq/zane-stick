// The throw's ballistics (docs/passing.md): the launch velocity that reaches a point, and where to throw so a running
// receiver meets the ball. Pure; used by the World, the bots and the shell's aim previews.
// (Placeholder with the contract's signatures for the QB brain's branch; the mode agent's version replaces it.)
import type { Vec3 } from './math';

const G = 9.81;
/** Fastest release an arm throws (m/s): elite NFL quarterbacks are radar-gunned at about 55–60 mph (25–27 m/s) at
 *  the Combine. */
export const ARM_SPEED = 27;

/** Launch velocity from `from` that reaches `at`, and the flight time (s). loft 0 = the quickest flight at ARM_SPEED
 *  (a bullet) .. 1 = the least-speed flight (about 45°: a lob). Out of the arm's range: the least-speed throw scaled
 *  to ARM_SPEED (it falls short). */
export function throwVelocity(from: Vec3, at: Vec3, loft: number): { vel: Vec3; time: number } {
  const dx = at[0] - from[0], dy = at[1] - from[1], dz = at[2] - from[2], R = Math.hypot(dx, dy, dz) || 1e-6;
  // |v|² at flight time T, as s = T²: g²/4 s² + (g dy − V²) s + R² = 0 at |v| = V; least speed at s = 2R/g
  const sLob = 2 * R / G, b = ARM_SPEED ** 2 - G * dy, disc = b * b - G * G * R * R;
  const vel = (T: number): Vec3 => [dx / T, dy / T + G * T / 2, dz / T];
  if (disc < 0) {
    const T = Math.sqrt(sLob), v = vel(T), k = ARM_SPEED / Math.hypot(...v);
    // shortcut: the time is the in-range flight's, not the short-falling one's; fine for aim previews and bots
    return { vel: [v[0] * k, v[1] * k, v[2] * k], time: T };
  }
  const tMin = Math.sqrt((b - Math.sqrt(disc)) / (G * G / 2)), tLob = Math.sqrt(sLob);
  const l = Math.max(0, Math.min(1, loft)), T = tMin + l * Math.max(0, tLob - tMin);
  return { vel: vel(T), time: T };
}

/** Where to throw so a receiver running on at his velocity meets the ball (ground velocity; `at` keeps his height). */
export function leadPoint(from: Vec3, target: { pos: Vec3; vel: Vec3 }, loft: number): Vec3 {
  let at: Vec3 = [...target.pos];
  for (let i = 0; i < 8; i++) {
    const T = throwVelocity(from, at, loft).time;
    at = [target.pos[0] + target.vel[0] * T, target.pos[1], target.pos[2] + target.vel[2] * T];
  }
  return at;
}
