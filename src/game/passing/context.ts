// A throw scheme's view of the play (schemes.ts PassCtx) from the World and the camera, and when the local player's
// throw controls apply. Reads the sim, never writes it.
import type { Vec3 } from '../../sim/math';
import type { World } from '../../sim/world';
import { leadPoint } from '../../sim/throw';
import { CATCH_Y, MAX_RANGE, type PassCtx, type Receiver } from './schemes';

/** Openness of a receiver nobody covers (m). */
const UNCOVERED = 20;
/** How far ahead (m) the automatic aim throws when no receiver is in range. */
const AHEAD = 25;

/** Where a ray from the camera meets the turf, at catch height and no farther than MAX_RANGE (horizontally) from
 *  `from`; a ray at or above the horizon gives the farthest point along its heading. */
export function turfAim(origin: Vec3, dir: Vec3, from: Vec3): Vec3 {
  let x: number, z: number;
  if (dir[1] < -1e-3) { const t = -origin[1] / dir[1]; x = origin[0] + dir[0] * t; z = origin[2] + dir[2] * t; }
  else { const h = Math.hypot(dir[0], dir[2]) || 1; x = from[0] + dir[0] / h * MAX_RANGE; z = from[2] + dir[2] / h * MAX_RANGE; }
  const dx = x - from[0], dz = z - from[2], d = Math.hypot(dx, dz);
  if (d > MAX_RANGE) { x = from[0] + dx / d * MAX_RANGE; z = from[2] + dz / d * MAX_RANGE; }
  return [x, CATCH_Y, z];
}

/** The automatic QB aim (for the automatic camera, where the camera, not the player, decides where he looks): the
 *  most open receiver within range, led to where he will be; none in range: straight ahead along `yaw`. */
export function autoAim(from: Vec3, receivers: Receiver[], yaw: number): Vec3 {
  let best: Receiver | null = null;
  for (const r of receivers) if (Math.hypot(r.pos[0] - from[0], r.pos[2] - from[2]) <= MAX_RANGE && (!best || r.open > best.open)) best = r;
  const at: Vec3 = best ? leadPoint(from, best, 0.3) : [from[0] + Math.sin(yaw) * AHEAD, CATCH_Y, from[2] + Math.cos(yaw) * AHEAD];
  const dx = at[0] - from[0], dz = at[2] - from[2], d = Math.hypot(dx, dz);
  return d > MAX_RANGE ? [from[0] + dx / d * MAX_RANGE, CATCH_Y, from[2] + dz / d * MAX_RANGE] : [at[0], CATCH_Y, at[2]];
}

/** The scheme context for athlete `me` throwing: the ball in his hand, his team mates (how open each is), the camera (`auto`: the automatic QB aim instead of where the camera looks). */
export function passCtx(w: World, me: number, time: number, cam: { yaw: number; pitch: number; origin: Vec3; dir: Vec3 }, auto = false): PassCtx {
  const team = w.athletes[me].setup.team, st = (i: number) => w.scene.athletes[i].state;
  const p = w.scene.propPose(w.ballIndex).pos, from: Vec3 = [p[0], p[1], p[2]];
  const foes = w.athletes.filter((a) => a.setup.team !== team).map((a) => st(a.index).com);
  const receivers: Receiver[] = w.athletes.filter((a) => a.setup.team === team && a.index !== me).map((a) => {
    const c = st(a.index).com, v = st(a.index).comVel;
    const open = Math.min(UNCOVERED, ...foes.map((f) => Math.hypot(f[0] - c[0], f[2] - c[2])));
    return { index: a.index, pos: [c[0], CATCH_Y, c[2]], vel: [v[0], 0, v[2]], open };
  });
  return { time, from, receivers, target: 0, yaw: cam.yaw, pitch: cam.pitch, turf: auto ? autoAim(from, receivers, cam.yaw) : turfAim(cam.origin, cam.dir, from) };
}

/** The local player can throw: he holds the ball (any mode; the sim's rules decide whether a pass counts). */
export const canThrow = (w: World, me: number) => me >= 0 && w.ballCarrier === me && w.ballIndex >= 0;
