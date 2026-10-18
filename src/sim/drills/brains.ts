// Bot brains the drill hands out as possession changes. Factories, so a better brain can replace these.
import { CarrierBrain, type BotDifficulty } from '../brains/carrier';
import type { Brain, Perception } from '../brains/types';
import { neutralCommands, type Commands, type Gait } from '../control/types';
import type { Rng } from '../rng';

/** Bot with the ball: runs for the goal the perception names. */
export const makeCarrier = (rng: Rng, diff: BotDifficulty, gait: Gait): Brain => new CarrierBrain(rng, diff, gait);

/** Bot without the ball: chases the ball carrier (or, with the ball loose, the nearest athlete) and wraps. */
export const makeTackler = (_rng: Rng, diff: BotDifficulty): Brain => new PursuitBrain(diff);

/** Lead on the target's velocity per metre of distance (s/m), its cap (s), and the ranges where the bot sets up
 *  (sinks, arms up) and wraps (m). */
const LEAD = 0.12, LEAD_MAX = 0.6, SETUP = 3, WRAP = 1.5;

// shortcut: pursuit only, no angles or cut reads; a full TacklerBrain (brains/tackler.ts) replaces this factory.
class PursuitBrain implements Brain {
  private history: Perception[] = [];
  constructor(private diff: BotDifficulty) {}

  think(p: Perception): Commands {
    const c = neutralCommands();
    this.history.push(p);
    // what the bot "sees" is the world as it was a reaction time ago
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    const seen = this.history[0], me = p.athletes[p.self];
    if (me.down) return c;
    let t = seen.athletes.findIndex((a, i) => i !== p.self && a.hasBall);
    if (t < 0) {
      let best = Infinity;
      seen.athletes.forEach((a, i) => { const d = Math.hypot(a.com[0] - me.com[0], a.com[2] - me.com[2]); if (i !== p.self && d < best) { best = d; t = i; } });
    }
    if (t < 0) return c;
    const o = seen.athletes[t], d = Math.hypot(o.com[0] - me.com[0], o.com[2] - me.com[2]), lead = Math.min(LEAD_MAX, LEAD * d);
    const dx = o.com[0] + o.comVel[0] * lead - me.com[0], dz = o.com[2] + o.comVel[2] * lead - me.com[2], n = Math.hypot(dx, dz) || 1;
    c.move = { x: dx / n, z: dz / n };
    c.gait = 'sprint';
    if (d < SETUP) {
      c.contactMode = true; c.sink = 0.4; c.armL = c.armR = 1; c.aim = o.pelvis;
      c.wrap = d < WRAP; c.driveLegs = c.wrap ? 1 : 0;
    }
    return c;
  }
}
