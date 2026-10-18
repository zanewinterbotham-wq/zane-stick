// The open-field drill as the tests and benchmarks have always driven it: the human tackles a bot ball carrier
// ('tackle') or carries past a bot tackler ('carry'), one on one. A thin wrapper over the game-mode framework
// (src/sim/modes): the rules are the shared ones, with the owner's earlier rule that only a tackle or a score ends
// the rep (out of bounds does not).
import { DEFAULT_ATHLETE, type AthleteParams } from '../anatomy/body';
import { DEFAULT_SUPPORT } from '../anim/types';
import { DIFFICULTY } from '../brains/carrier';
import type { Brain } from '../brains/types';
import { OPEN_FIELD_CARRY, OPEN_FIELD_TACKLE } from '../modes/openField';
import { Play } from '../modes/play';
import type { PlayConfig } from '../modes/types';
import type { PhysicsEngine } from '../physics/engine';

export { BARRIER, GOAL_LINE } from '../modes/rules';
export type { RepEnd } from '../modes/play';

export interface OpenFieldConfig extends Omit<PlayConfig, 'bot'> {
  /** The bot's body (he carries in 'tackle', tackles in 'carry'). */
  carrier: AthleteParams;
  /** Safety timeout (s): reps end on a tackle or a score; this only stops a rep nobody finishes. */
  timeLimit: number;
  /** 'tackle' (default): the bot carries, the human tackles. 'carry': the human starts with the ball and runs for
   *  the far end zone; the bot tackles. */
  mode?: 'tackle' | 'carry';
}
export const DEFAULT_OPEN_FIELD: Omit<OpenFieldConfig, 'physics'> = {
  assist: 0.2, seed: 1, human: DEFAULT_ATHLETE, carrier: { height: 1.80, mass: 98, strength: 1, speed: 1 },
  difficulty: DIFFICULTY.normal, carrierGait: 'jog', timeLimit: 60, support: DEFAULT_SUPPORT,
};

/** A play with the drill's names: the bot is athlete `carrier` (1), whatever he does. */
export type OpenFieldDrill = Play;
export const OpenFieldDrill = {
  async create(engine: PhysicsEngine, cfg: OpenFieldConfig, humanBrain: Brain, rep = 0): Promise<OpenFieldDrill> {
    const { carrier, timeLimit, mode, ...rest } = cfg;
    const def = mode === 'carry' ? OPEN_FIELD_CARRY : OPEN_FIELD_TACKLE;
    return Play.create(engine, { ...rest, bot: carrier }, def, { outOfBounds: false, timeLimit, tacklers: 1, blockers: 0 }, humanBrain, rep);
  },
};
