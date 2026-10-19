// Football sense shared by every football brain (docs/passing.md): where things are in the play's frame, who is
// open, whether a throwing lane is clear, who can get where in time. Pure functions of the Perception, so every brain
// reads the field the same way. (First versions: the football-sense agent refines and tests them.)
import type { Vec3 } from '../../math';
import type { AthleteView, Perception } from '../types';
import type { PlayFrame } from './types';

/** Fastest a defender closes on a ball's landing spot (m/s, a DB's sprint) and his reach (m). */
export const DB_SPEED = 9, REACH = 1;

/** Depth downfield of the LOS (m) and world x of a point. */
export const rel = (f: PlayFrame, p: Vec3) => ({ depth: (p[2] - f.los) * f.dir, x: p[0] });
/** The world point at a depth downfield and world x (on the turf). */
export const toWorld = (f: PlayFrame, depth: number, x: number): Vec3 => [x, 0, f.los + f.dir * depth];

export const opponents = (p: Perception, self = p.self) => p.athletes.map((_, i) => i).filter((i) => p.athletes[i].team !== p.athletes[self].team);
export const mates = (p: Perception, self = p.self) => p.athletes.map((_, i) => i).filter((i) => i !== self && p.athletes[i].team === p.athletes[self].team);

const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Distance (m) from athlete i to the nearest standing opponent. */
export function separation(p: Perception, i: number): number {
  let d = Infinity;
  for (const j of opponents(p, i)) if (!p.athletes[j].down) d = Math.min(d, flat(p.athletes[i].com, p.athletes[j].com));
  return d;
}

/** Time (s) for a chaser at `from` running at `speed` to reach a target moving at `vel` from `at` (Infinity if never;
 *  ground plane). */
export function interceptTime(from: Vec3, speed: number, at: Vec3, vel: Vec3): number {
  const dx = at[0] - from[0], dz = at[2] - from[2], a = vel[0] ** 2 + vel[2] ** 2 - speed ** 2, b = 2 * (dx * vel[0] + dz * vel[2]), c = dx * dx + dz * dz;
  if (Math.abs(a) < 1e-9) return b < 0 ? -c / b : Infinity;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const r = [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)].filter((t) => t >= 0);
  return r.length ? Math.min(...r) : Infinity;
}

/** How open a target is for a ball arriving at `at` in `tFlight` s: 0 (a defender gets there first) .. 1 (nobody
 *  within reach): the time margin of the quickest defender over the ball, mapped over 0..1 s. */
export function openness(p: Perception, target: number, at: Vec3, tFlight: number): number {
  let margin = Infinity;
  for (const j of opponents(p, target)) {
    const d = p.athletes[j];
    if (d.down) continue;
    margin = Math.min(margin, Math.max(0, flat(d.com, at) - REACH) / DB_SPEED - tFlight);
  }
  return Math.max(0, Math.min(1, margin));
}

/** No standing opponent of `team` within `radius` (m) of the ball's path from → to (ground plane; the arc's height is
 *  the caller's concern: a lob clears underneath defenders). */
export function laneClear(p: Perception, from: Vec3, to: Vec3, team: 0 | 1, radius = 1): boolean {
  const ax = to[0] - from[0], az = to[2] - from[2], L2 = ax * ax + az * az || 1e-9;
  return p.athletes.every((o: AthleteView) => {
    if (o.team === team || o.down) return true;
    const t = Math.max(0, Math.min(1, ((o.com[0] - from[0]) * ax + (o.com[2] - from[2]) * az) / L2));
    return Math.hypot(from[0] + ax * t - o.com[0], from[2] + az * t - o.com[2]) > radius;
  });
}

/** Pressure on athlete i: 0 (nobody within 4 m) .. 1 (an opponent on him), from the nearest standing opponent. */
export const pressure = (p: Perception, i: number) => Math.max(0, Math.min(1, (4 - separation(p, i)) / 3));
