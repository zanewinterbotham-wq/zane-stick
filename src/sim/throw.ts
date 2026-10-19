// Passing math (docs/passing.md), pure: the launch velocity that puts a thrown ball on a point, where to throw to meet
// a running receiver, and how far off a throw goes. The World, the bots and the shell's aim previews share it. The
// scene has no air drag, so a throw is a vacuum trajectory (as a kick is).
import { clamp, type Vec3 } from './math';

const G = 9.81;
/** Throwing [S5, Passing]: fastest release an arm gives the ball (m/s; NFL Combine radar readings top out near
 *  60 mph, ~27 m/s), spiral spin (rad/s, ~600 rpm, Rae 2004), the motion's times from its start (s): the arm cocked,
 *  the ball out (a quick NFL release, ~0.4 s from the start of the motion, scouting stopwatch figures), the follow
 *  through over; how far ahead of the hand's centre the ball's centre leaves (m: its half length, a hand's and a
 *  margin); and the accuracy model (1σ miss at the target, m, all assumptions): per metre of throw, and the factors
 *  per m/s of the passer's own speed, at full knock, with a defender within `pressR` m, and at full loft. */
export const THROW = { vmax: 27, spin: 63, cock: 0.25, release: 0.4, end: 0.65, clear: 0.3,
  perM: 0.012, run: 0.12, knock: 1.5, pressure: 1, pressR: 1.5, loft: 0.5 };

/** Launch velocity from `from` that reaches `at` (world, m) and the flight time (s). Loft 0: the fastest throw the
 *  arm allows (THROW.vmax); 1: the softest, the least-speed (about 45°) trajectory; between them the flight time
 *  interpolates. Out of the arm's range: the longest throw toward it (it falls short). */
export function throwVelocity(from: Vec3, at: Vec3, loft: number): { vel: Vec3; time: number } {
  const dx = at[0] - from[0], dz = at[2] - from[2], dy = at[1] - from[1], d = Math.hypot(dx, dz), R = Math.hypot(d, dy), V = THROW.vmax;
  const ux = d > 1e-9 ? dx / d : 0, uz = d > 1e-9 ? dz / d : 1;
  // speed² = R²/T² + g·dy + g²T²/4: least at T⁴ = 4R²/g²; equal to V² at the two roots of a quadratic in T²
  const tSoft = Math.sqrt(2 * R / G), b = V * V - G * dy, disc = b * b - G * G * R * R;
  if (disc < 0 || R < 1e-6) {
    // beyond the arm (or nowhere to go): 45° at full speed toward it
    const s = V * Math.SQRT1_2, T = R < 1e-6 ? 0 : 2 * s / G;
    return { vel: [ux * s, s, uz * s], time: T };
  }
  const tFast = Math.sqrt(2 * (b - Math.sqrt(disc)) / (G * G)), T = Math.max(1e-3, tFast + clamp(loft, 0, 1) * Math.max(0, tSoft - tFast));
  return { vel: [ux * d / T, dy / T + G * T / 2, uz * d / T], time: T };
}

/** Where to throw so a receiver running on at his velocity meets the ball: his point when it gets there, the flight
 *  time and the `delay` before release (the motion: s) included, iterated to a fixed point. y stays the target's. */
export function leadPoint(from: Vec3, target: { pos: Vec3; vel: Vec3 }, loft: number, delay: number = THROW.release): Vec3 {
  const p = target.pos, v = target.vel, at: Vec3 = [p[0], p[1], p[2]];
  for (let k = 0; k < 8; k++) {
    const t = delay + throwVelocity(from, at, loft).time;
    at[0] = p[0] + v[0] * t; at[2] = p[2] + v[2] * t;
  }
  return at;
}

/** A throw's 1σ miss at the target (m): grows with its length, the passer's own ground speed (m/s), his knock (0..1),
 *  a defender on him, and the loft. */
export function throwError(dist: number, speed: number, knock: number, pressured: boolean, loft: number): number {
  const T = THROW;
  return T.perM * dist * (1 + T.run * speed) * (1 + T.knock * clamp(knock, 0, 1)) * (pressured ? 1 + T.pressure : 1) * (1 + T.loft * clamp(loft, 0, 1));
}

/** One throw (Play.lastPass, for the HUD and tests): the passer, when it left the hand (world s), where it was aimed
 *  and where the error sent it (m), its loft and release speed (m/s), and the miss (m) between the two. */
export interface PassRecord { athlete: number; time: number; at: Vec3; to: Vec3; loft: number; speed: number; error: number }
