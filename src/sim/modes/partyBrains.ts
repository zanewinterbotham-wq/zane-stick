// Bots for the free-for-all party modes, through Commands only. FleeBrain runs from the nearest standing opponents and
// keeps off the walls (Hot Potato's holder, Infection's survivors); ChaseBrain tackles the nearest standing opponent
// with the ordinary tackler, which chases "the ball carrier": here that is whoever is nearest. Difficulty is the
// reaction delay (and aim noise) only.
import { neutralCommands, type Commands } from '../control/types';
import type { Rng } from '../rng';
import type { BotDifficulty } from '../brains/carrier';
import { predict, TacklerBrain } from '../brains/tackler';
import type { Brain, Perception } from '../brains/types';

/** Threats beyond FAR m are ignored; within CLAMP m of an edge he never heads outward. */
const CLAMP = 2, FAR = 14, LOOK = 0.7, WALL = 4;

export class FleeBrain implements Brain {
  private history: Perception[] = [];
  private err = 0; private errUntil = 0;
  constructor(private rng: Rng, private diff: BotDifficulty, private half: number) {}

  think(p: Perception): Commands {
    const c = neutralCommands();
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    const seen = this.history[0], me = p.athletes[p.self];
    if (me.down) return c;
    if (p.time >= this.errUntil) { this.err = this.rng.gauss() * this.diff.noise; this.errUntil = p.time + 0.5; }
    let gx = 0, gz = 0, near = Infinity;
    seen.athletes.forEach((a, i) => {
      if (i === p.self || a.team === me.team || a.down) return;
      const t = predict(a, p.time - seen.time), dx = me.com[0] - t.com[0], dz = me.com[2] - t.com[2], d = Math.hypot(dx, dz) || 1e-6;
      if (d > FAR) return;
      near = Math.min(near, d);
      gx += (dx / d) / d; gz += (dz / d) / d;
    });
    // the walls push inward (harder the nearer), a weak pull to the middle stops him circling in a corner, and
    // within CLAMP m of an edge he never heads out through it
    // (judged where he will be in LOOK s at his present speed, so he turns before the line, not after it)
    const qx = me.com[0] + me.comVel[0] * LOOK, qz = me.com[2] + me.comVel[2] * LOOK;
    const wall = (v: number) => -Math.sign(v) * Math.min(1 / Math.max(this.half - Math.abs(v), 0.3), 3);
    gx += wall(qx) * WALL - me.com[0] * 0.01; gz += wall(qz) * WALL - me.com[2] * 0.01;
    if (this.half - Math.abs(qx) < CLAMP && gx * qx > 0) gx = 0;
    if (this.half - Math.abs(qz) < CLAMP && gz * qz > 0) gz = 0;
    if (Math.hypot(gx, gz) < 1e-6) return c;
    const a = Math.atan2(gx, gz) + this.err * 0.3;
    c.move = { x: Math.sin(a), z: Math.cos(a) };
    c.gait = near < 9 ? 'sprint' : 'jog';
    return c;
  }
}

export class ChaseBrain implements Brain {
  private inner: TacklerBrain;
  constructor(rng: Rng, diff: BotDifficulty) { this.inner = new TacklerBrain(rng, diff); }

  think(p: Perception, dt = 1 / 240): Commands {
    const me = p.athletes[p.self];
    let ti = -1, bd = Infinity;
    p.athletes.forEach((a, i) => {
      const d = Math.hypot(a.com[0] - me.com[0], a.com[2] - me.com[2]);
      if (a.team !== me.team && !a.down && d < bd) { ti = i; bd = d; }
    });
    if (ti < 0) return neutralCommands();
    return this.inner.think({ ...p, athletes: p.athletes.map((a, i) => ({ ...a, hasBall: i === ti })) }, dt);
  }
}
