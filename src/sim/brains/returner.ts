// Bot kick returner: while a kick is in the air, runs to where it comes down to chest height, squares up to it and
// raises his hands (a ball that meets his hands or his chest is caught: the play's possession rule). Misjudges the
// spot by the difficulty's noise. Once it is on the turf (a muff, a bounce) he goes for it as a tackler goes for a
// loose ball; with the ball the play hands him a carrier brain. Same Commands as a human.
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type Commands } from '../control/types';
import { clamp, wrapAngle } from '../math';
import type { Rng } from '../rng';
import type { BotDifficulty } from './carrier';
import { TacklerBrain, turnRate } from './tackler';
import type { AthleteView, Brain, Perception } from './types';

/** Height the ball is taken at (m, chest), the hands go up this long before it arrives (s), and the run is planned
 *  to stop on the spot with this deceleration (m/s²). */
const CATCH_H = 1.2, CHEST = 0.15, HANDS_T = 0.5, BRAKE = 4;
const G = 9.81, FULL = GAIT_SPEED.sprint, MOVE_TAU = 0.08;

/** Time (s) until a ball in flight comes down through height h, or −1 if it is below h already. */
export function fallTime(pos: readonly number[], vel: readonly number[], h: number): number {
  const disc = vel[1] * vel[1] + 2 * G * (pos[1] - h);
  return disc < 0 ? -1 : (vel[1] + Math.sqrt(disc)) / G;
}

export class ReturnerBrain implements Brain {
  private chase: TacklerBrain;
  private heading = NaN; private mag = 0;
  /** How far off he judges the landing spot (m). */
  private err: [number, number];
  constructor(rng: Rng, diff: BotDifficulty) {
    this.chase = new TacklerBrain(rng, diff);
    this.err = [rng.gauss() * diff.noise, rng.gauss() * diff.noise];
  }

  think(p: Perception, dt = 1 / 240): Commands {
    const me = p.athletes[p.self], b = p.ball;
    const t = b && !p.athletes.some((a) => a.hasBall) ? fallTime(b.pos, b.vel, CATCH_H) : -1;
    if (!b || me.down || t < 0) return this.chase.think(p, dt);
    const c = neutralCommands();
    const k = Math.min(1, t); // the misjudgement shrinks as the ball comes down
    // where it reaches chest height; he stands CHEST behind that along its flight, so it comes down onto his chest
    const cx = b.pos[0] + b.vel[0] * t, cz = b.pos[2] + b.vel[2] * t, hv = Math.hypot(b.vel[0], b.vel[2]) || 1;
    const dx = cx + b.vel[0] / hv * CHEST + this.err[0] * k - me.com[0], dz = cz + b.vel[2] / hv * CHEST + this.err[1] * k - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    const v = d < 0.1 ? 0 : clamp(Math.sqrt(2 * BRAKE * d), 0.5, FULL);
    this.run(me, dx / d * v, dz / d * v, dt, c);
    c.gait = v > 6 ? 'sprint' : 'jog';
    const bx = b.pos[0] - me.com[0], bz = b.pos[2] - me.com[2], bd = Math.hypot(bx, bz);
    if (d < 3 && bd > 1) c.face = { x: bx / bd, z: bz / bd };
    // the catching hand waits where the ball will come down, at the chest: a hand reaching up to the ball is
    // still swinging when it closes, and the tuck that follows wrenches the ball out of it
    if (t < HANDS_T) { c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = [cx, CATCH_H, cz]; }
    return c;
  }

  /** Toward a ground velocity, the heading turning no faster than footing allows (as the tackler's run). */
  private run(me: AthleteView, vx: number, vz: number, dt: number, c: Commands) {
    if (Number.isNaN(this.heading)) this.heading = me.heading;
    if (Math.hypot(vx, vz) > 1e-3) {
      const d = wrapAngle(Math.atan2(vx, vz) - this.heading), w = turnRate(Math.hypot(me.comVel[0], me.comVel[2])) * dt;
      this.heading = wrapAngle(this.heading + clamp(d, -w, w));
    }
    this.mag += (Math.min(1, Math.hypot(vx, vz) / FULL) - this.mag) * (1 - Math.exp(-dt / MOVE_TAU));
    c.move = { x: Math.sin(this.heading) * this.mag, z: Math.cos(this.heading) * this.mag };
  }
}
