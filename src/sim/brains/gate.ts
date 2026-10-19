// A dormant bot: stands still until the ball comes within `range` (the carrier, or a loose ball), then plays as
// `inner` for the rest of the play. A defender in a gauntlet waits for the runner instead of chasing him from the whistle.
import { neutralCommands, type Commands } from '../control/types';
import type { Brain, Perception } from './types';

export class GateBrain implements Brain {
  awake = false;
  constructor(private inner: Brain, private range: number) {}

  think(p: Perception, dt = 1 / 240): Commands {
    if (!this.awake) {
      const me = p.athletes[p.self], c = neutralCommands();
      const at = p.athletes.find((a) => a.hasBall)?.com ?? p.ball?.pos;
      if (at && Math.hypot(at[0] - me.com[0], at[2] - me.com[2]) < this.range) this.awake = true;
      else return c;
    }
    return this.inner.think(p, dt);
  }
}
