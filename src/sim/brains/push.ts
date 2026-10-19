// Bot sumo wrestler: gets on the ring-centre side of the nearest standing opponent and drives him outward, both arms
// gripping, hips low, legs pushing; never wanders to the edge itself. Reads the world through a reaction delay;
// difficulty is that delay and aim noise only. Same Commands as a human.
import { neutralCommands, type Commands } from '../control/types';
import type { Rng } from '../rng';
import type { BotDifficulty } from './carrier';
import { predict } from './tackler';
import type { Brain, Perception } from './types';

/** Seat himself this far behind his man on the centre side (m); the clinch starts inside CLINCH; stay this far inside the edge (m). */
const BEHIND = 0.9, CLINCH = 1.7, EDGE = 0.8;

export class PushBrain implements Brain {
  private history: Perception[] = [];
  private aimErr = 0; private aimUntil = 0;
  constructor(private rng: Rng, private diff: BotDifficulty, private ring: { x: number; z: number; r: number }) {}

  think(p: Perception): Commands {
    const c = neutralCommands();
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    const seen = this.history[0], me = p.athletes[p.self];
    if (me.down) return c;
    let best = -1, bd = Infinity;
    seen.athletes.forEach((a, i) => {
      const d = Math.hypot(a.com[0] - me.com[0], a.com[2] - me.com[2]);
      if (a.team !== me.team && !a.down && d < bd) { best = i; bd = d; }
    });
    if (best < 0) return c;
    const t = predict(seen.athletes[best], p.time - seen.time), { x: cx, z: cz, r } = this.ring;
    if (p.time >= this.aimUntil) { this.aimErr = this.rng.gauss() * this.diff.noise * 0.5; this.aimUntil = p.time + 0.5; }
    // outward unit vector through him; the side of him that faces the centre is where to stand
    const ox = t.com[0] - cx, oz = t.com[2] - cz, on = Math.hypot(ox, oz) || 1, ux = ox / on, uz = oz / on;
    const dx = t.com[0] - me.com[0], dz = t.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    c.gait = 'jog'; c.contactMode = d < 3; c.face = { x: dx / d, z: dz / d };
    if (d < CLINCH) {
      c.move = { x: ux * 0.6, z: uz * 0.6 };
      c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = [t.pelvis[0], t.pelvis[1] + 0.2, t.pelvis[2]];
      c.sink = 0.35; c.lean.fwd = 0.4; c.driveLegs = 1;
      return c;
    }
    let gx = t.com[0] - ux * BEHIND - uz * this.aimErr - me.com[0], gz = t.com[2] - uz * BEHIND + ux * this.aimErr - me.com[2];
    // near the edge himself: back to the middle first
    if (Math.hypot(me.com[0] - cx, me.com[2] - cz) > r - EDGE) { gx = cx - me.com[0]; gz = cz - me.com[2]; }
    const n = Math.hypot(gx, gz) || 1e-6, v = Math.min(0.8, n / 1.5);
    c.move = { x: gx / n * v, z: gz / n * v };
    return c;
  }
}
