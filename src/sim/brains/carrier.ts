// Bot ball carrier (Phase 1, simple): runs for the goal line, reads the tackler through a reaction delay,
// and cuts away from his leverage with seeded variety so reps do not repeat. Issues ordinary Commands.
import { neutralCommands, type Commands, type Gait } from '../control/types';
import type { Rng } from '../rng';
import type { Brain, Perception } from './types';

export interface BotDifficulty { reaction: number; noise: number }
export const DIFFICULTY: Record<'easy' | 'normal' | 'hard', BotDifficulty> = {
  easy: { reaction: 0.35, noise: 0.35 }, normal: { reaction: 0.25, noise: 0.2 }, hard: { reaction: 0.15, noise: 0.1 },
};

export class CarrierBrain implements Brain {
  private history: Perception[] = [];
  private cutDir = 0;        // −1 right, +1 left (relative to the run direction), 0 straight
  private cutUntil = 0;
  private nextDecision = 0;
  constructor(private rng: Rng, private diff: BotDifficulty, private gait: Gait = 'jog', private carryArm: 1 | 2 = 2) {}

  think(p: Perception): Commands {
    const c = neutralCommands();
    c.carry = this.carryArm;
    c.gait = this.gait;
    this.history.push(p);
    // what the carrier "sees" is the world as it was a reaction time ago
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    const seen = this.history[0];
    const me = p.athletes[p.self];
    if (me.down) return c;
    const dirZ = p.field.dirZ;
    const goal = [0, dirZ];
    // nearest opponent as seen
    let opp = -1, best = Infinity;
    seen.athletes.forEach((a, i) => {
      if (i === p.self) return;
      const d = Math.hypot(a.com[0] - me.com[0], a.com[2] - me.com[2]);
      if (d < best) { best = d; opp = i; }
    });
    let mx = goal[0], mz = goal[1];
    if (opp >= 0 && p.time >= this.nextDecision) {
      const o = seen.athletes[opp];
      const ahead = (o.com[2] - me.com[2]) * dirZ;            // how far in front the tackler is
      const lateral = (o.com[0] - me.com[0]) * dirZ;          // + = tackler to the carrier's left (when running +Z)
      if (ahead > 0.5 && ahead < 9) {
        // cut away from the tackler's side, with seeded noise and a chance to cut back
        let side = lateral > 0 ? -1 : 1;
        if (this.rng.next() < this.diff.noise + 0.15) side = -side;
        this.cutDir = side;
        this.cutUntil = p.time + this.rng.range(0.6, 1.2);
        this.nextDecision = this.cutUntil + this.rng.range(0.2, 0.6);
      }
    }
    if (p.time < this.cutUntil && this.cutDir !== 0) {
      const ang = this.rng.range(0.55, 0.85) * this.cutDir * dirZ; // ~30–50° off the line
      mx = Math.sin(ang) * dirZ; mz = Math.cos(ang) * dirZ;
    }
    // stay in bounds: steer back toward the middle near the sideline
    const margin = p.field.halfWidth - Math.abs(me.com[0]);
    if (margin < 4) mx += -Math.sign(me.com[0]) * (4 - margin) * 0.4;
    const n = Math.hypot(mx, mz) || 1;
    c.move = { x: mx / n, z: mz / n };
    return c;
  }
}
