// Hits & support tuning (owner request 2026-10-21). The knock, stun and carry rules stay as World.updateSupport has them
// (design §6.5); these are their plain-number thresholds and timings, named as in world.ts SUP, whose values are the
// defaults. The same for every athlete (AI toughness still scales the bots' thresholds on top).
import { tuned } from './tuning';

export interface HitTuning {
  /** Stun (muscles loosen after a hard hit): the knock impulse, in big hits, where it starts and the further amount to full. */
  stunStart: number; stunFull: number;
  /** Seconds the stun takes to wear off. */
  stunTime: number;
  /** Driven back: speed along the hit beyond what he wants (m/s) where the knock starts and where it is full. */
  drivenStart: number; drivenFull: number;
  /** Seconds a big hit is remembered for the driven-back knock. */
  drivenTime: number;
  /** Knock decay per second once nothing knocks him (1/s). */
  decay: number;
  /** Seconds untouched before a tilt or a flight stops counting as a knock. */
  free: number;
  /** Seconds of stable footing before the run's carry returns after contact, and its ramp back in (s). */
  stable: number; fadeIn: number;
  /** The knock under which he counts as steady enough to get going again. */
  goKnock: number;
  /** Seconds for the posture support to come back during a get-up. */
  getup: number;
  /** Largest acceleration of a dive take-off (m/s²). */
  launch: number;
  /** Largest horizontal acceleration of a hip-thrust lunge (m/s²). */
  lunge: number;
}
export const HIT_DEFAULTS: HitTuning = { stunStart: 1, stunFull: 2, stunTime: 0.5, drivenStart: 0.5, drivenFull: 2, drivenTime: 1.5, decay: 1, free: 1, stable: 0.1, fadeIn: 0.15, goKnock: 0.5, getup: 1, launch: 15, lunge: 12 };
export const HIT_RANGES: Record<keyof HitTuning, [number, number, number]> = {
  stunStart: [0, 5, 0.05], stunFull: [0.1, 6, 0.05], stunTime: [0.05, 3, 0.05], drivenStart: [0, 3, 0.05], drivenFull: [0.5, 6, 0.05], drivenTime: [0.1, 5, 0.1],
  decay: [0.1, 5, 0.05], free: [0, 3, 0.05], stable: [0, 1, 0.01], fadeIn: [0.01, 1, 0.01], goKnock: [0.05, 1, 0.05], getup: [0.2, 4, 0.05], launch: [3, 40, 0.5], lunge: [0, 30, 0.5],
};
export const hitTuning = (o: unknown): HitTuning => tuned(HIT_DEFAULTS, HIT_RANGES, o);
