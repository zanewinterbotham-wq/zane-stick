// Bot kick returner: while a kick is in the air, runs to where it comes down to chest height, squares up to it and
// raises his hands to where it comes down (a ball that meets his hands or his chest may be caught: the play's catch
// rule, the same chance as anyone's). Misjudges the spot by the difficulty's noise. Once it is on the turf (a muff, a
// bounce) he goes for it as a tackler goes for a loose ball; with the ball the play hands him a carrier brain. Same
// Commands as a human.
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type Commands } from '../control/types';
import { clamp, type Vec3 } from '../math';
import type { Rng } from '../rng';
import type { BotDifficulty } from './carrier';
import { ballInPlay, Steer } from './steer';
import { TacklerBrain } from './tackler';
import type { Brain, Perception } from './types';

/** Height the ball is taken at (m, chest), the hands go up this long before it arrives (s), and the run is planned
 *  to stop on the spot with this deceleration (m/s²). */
const CATCH_H = 1.2, CHEST = 0.15, HANDS_T = 0.5, BRAKE = 4;
const G = 9.81, FULL = GAIT_SPEED.sprint;

/** Time (s) until a ball in flight comes down through height h (negative: it already has), or −1 if it never
 *  comes up to h. */
export function fallTime(pos: readonly number[], vel: readonly number[], h: number): number {
  const disc = vel[1] * vel[1] + 2 * G * (pos[1] - h);
  return disc < 0 ? -1 : (vel[1] + Math.sqrt(disc)) / G;
}

/** Where a ball in flight passes nearest the point `at` (its straight-line closest approach, at most `tMax` s ahead,
 *  with the drop over that time): the hands wait there for it. */
export function catchPoint(b: { pos: Vec3; vel: Vec3 }, at: readonly number[], tMax = 1): Vec3 {
  const p = b.pos, v = b.vel, v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] || 1e-9;
  const t = clamp(-((p[0] - at[0]) * v[0] + (p[1] - at[1]) * v[1] + (p[2] - at[2]) * v[2]) / v2, 0, tMax);
  return [p[0] + v[0] * t, p[1] + v[1] * t - G * t * t / 2, p[2] + v[2] * t];
}

/** Hands at full stretch above the head's centre (m, a standing reach); how far from the chest along the ground a
 *  falling ball can still be taken (m, an arm's length), and how near a fall counts as coming down on him (m: the
 *  hands go up toward it while he gets under it). */
export const OVERHEAD = 0.5;
const ARM = 0.6, NEAR = 2;

/** Where the hands take a ball coming down near `chest` (its ballistic fall): the highest point of the fall between
 *  `top` and chest height within ARM of the chest along the ground (overhead if it drops onto him, at the face or
 *  chest if it comes in front); else the nearest point of that fall within NEAR; else null. */
export function dropPoint(b: { pos: Vec3; vel: Vec3 }, chest: readonly number[], top: number): Vec3 | null {
  let best: Vec3 | null = null, bd = NEAR;
  for (let h = top; h >= chest[1] - 1e-9; h -= 0.1) {
    const t = fallTime(b.pos, b.vel, h);
    if (t < 0) continue;
    const x = b.pos[0] + b.vel[0] * t, z = b.pos[2] + b.vel[2] * t, d = Math.hypot(x - chest[0], z - chest[2]);
    if (d < ARM) return [x, h, z];
    if (d < bd) { bd = d; best = [x, h, z]; }
  }
  return best;
}

/** A loose ball flying at `at` (closing faster than `close` m/s, within `range` m): worth reaching for. */
export function incoming(b: { pos: Vec3; vel: Vec3 }, at: readonly number[], range = 8, close = 2): boolean {
  const r = [b.pos[0] - at[0], b.pos[1] - at[1], b.pos[2] - at[2]], d = Math.hypot(r[0], r[1], r[2]) || 1e-9;
  return d < range && -(r[0] * b.vel[0] + r[1] * b.vel[1] + r[2] * b.vel[2]) / d > close;
}

export class ReturnerBrain implements Brain {
  private chase: TacklerBrain;
  private steer = new Steer();
  /** How far off he judges the landing spot (m). */
  private err: [number, number];
  constructor(rng: Rng, diff: BotDifficulty) {
    this.chase = new TacklerBrain(rng, diff);
    this.err = [rng.gauss() * diff.noise, rng.gauss() * diff.noise];
  }

  think(p: Perception, dt = 1 / 240): Commands {
    const me = p.athletes[p.self], b = p.ball;
    const t = b && !p.athletes.some((a) => a.hasBall) ? fallTime(b.pos, b.vel, CATCH_H) : -1;
    // a kick into the stands (or out, where that kills it) is let go: the tackler leaves it alone too
    if (!b || me.down || t < 0 || !ballInPlay(p)) return this.chase.think(p, dt);
    const c = neutralCommands();
    const k = Math.min(1, t); // the misjudgement shrinks as the ball comes down
    // where it reaches chest height; he stands CHEST behind that along its flight, so it comes down onto his chest
    const cx = b.pos[0] + b.vel[0] * t, cz = b.pos[2] + b.vel[2] * t, hv = Math.hypot(b.vel[0], b.vel[2]) || 1;
    const dx = cx + b.vel[0] / hv * CHEST + this.err[0] * k - me.com[0], dz = cz + b.vel[2] / hv * CHEST + this.err[1] * k - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    const v = d < 0.1 ? 0 : clamp(Math.sqrt(2 * BRAKE * d), 0.5, FULL);
    this.steer.run(me, dx / d * v, dz / d * v, dt, c);
    c.gait = v > 6 ? 'sprint' : 'jog';
    const bx = b.pos[0] - me.com[0], bz = b.pos[2] - me.com[2], bd = Math.hypot(bx, bz);
    if (d < 3 && bd > 1) c.face = { x: bx / bd, z: bz / bd };
    // both hands wait together (the diamond) where the ball will come down through their reach, as the human's do
    if (t < HANDS_T) { c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = dropPoint(b, [me.head[0], me.head[1] - 0.3, me.head[2]], me.head[1] + OVERHEAD) ?? [cx, CATCH_H, cz]; }
    return c;
  }
}
