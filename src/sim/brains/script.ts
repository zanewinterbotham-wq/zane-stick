import { neutralCommands, type Commands } from '../control/types';
import type { Brain, Perception } from './types';

/** Commands from a function of time — used by tests, benchmarks and demos. */
export class ScriptBrain implements Brain {
  constructor(private fn: (t: number, p: Perception, c: Commands) => void) {}
  think(p: Perception): Commands {
    const c = neutralCommands();
    this.fn(p.time, p, c);
    return c;
  }
}
