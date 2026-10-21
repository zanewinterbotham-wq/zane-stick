// Fumble tuning (owner request 2026-10-20: fumble settings in the Tuning panel). A fumble stays physics: the carrier's
// grip on the ball breaks when the force pulling it apart passes the grip's strength (World.updateGrips). These scale
// that strength and how long a jolt must last to count. The defaults (×1, 0.02 s) are the same rule as every other grip.
import { tuned } from './tuning';

export interface FumbleTuning {
  /** × the force the ball grip holds before the ball is knocked loose (higher: fewer fumbles). */
  hold: number;
  /** Seconds the pull on the ball grip is averaged over: a longer window lets a short jolt pass without a fumble. */
  window: number;
}
export const FUMBLE_DEFAULTS: FumbleTuning = { hold: 1, window: 0.02 };
export const FUMBLE_RANGES: Record<keyof FumbleTuning, [number, number, number]> = { hold: [0.25, 10, 0.05], window: [0.005, 0.25, 0.005] };
export const fumbleTuning = (o: unknown): FumbleTuning => tuned(FUMBLE_DEFAULTS, FUMBLE_RANGES, o);
