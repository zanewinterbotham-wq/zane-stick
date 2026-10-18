// Bot brains the drill hands out as possession changes. Factories, so a better brain can replace these.
import { CarrierBrain, type BotDifficulty } from '../brains/carrier';
import { TacklerBrain } from '../brains/tackler';
import type { Brain } from '../brains/types';
import type { Gait } from '../control/types';
import type { Rng } from '../rng';

/** Bot with the ball: runs for the goal the perception names. */
export const makeCarrier = (rng: Rng, diff: BotDifficulty, gait: Gait): Brain => new CarrierBrain(rng, diff, gait);

/** Bot without the ball: pursuit angle, breakdown, wrap and dive; dives on a loose ball. */
export const makeTackler = (rng: Rng, diff: BotDifficulty): Brain => new TacklerBrain(rng, diff);
