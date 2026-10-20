// Catch tuning (owner decisions 2026-10-18 / 2026-10-19: catching is an arcade rule, "make catching way easier" with
// settings for what makes it easier or harder). The same numbers for every athlete; game-design values, not
// measurements. Play.catchTry and Play.loose read them (PlayConfig.catching overrides any of them).

export interface CatchTuning {
  /** A raised hand this close to the ball (m, hand surface to ball tip), or two raised hands with the ball this close
   *  to the line between them, gets a try. */
  reach: number;
  /** Base chance with both hands (the diamond), one hand, and the trunk only. */
  twoHands: number; oneHand: number; body: number;
  /** Factor for a ball at the very edge of the reach (one meeting the hands squarely: 1). */
  edge: number;
  /** Factor for the hardest throw (35 m/s at the hands; soft up to 20 m/s). */
  hard: number;
  /** Factor for running flat out (from 4 m/s, least at 9) and, separately, for catching in the air or laid out. */
  moving: number; air: number;
  /** Factor with an opponent on him (touching or holding). */
  contact: number;
  /** Factor for a ball he does not look at. */
  blind: number;
}

/** The defaults, much easier than the first rule (two hands 0.95, one 0.55, body 0.3, reach 0.3 m, edge 0.5, hard
 *  0.6, running 0.85, air 0.85, contact 0.4, blind 0.3): a well-thrown ball to raised hands is nearly always caught. */
export const DEFAULT_CATCHING: CatchTuning = {
  reach: 0.45, twoHands: 0.98, oneHand: 0.85, body: 0.55, edge: 0.8, hard: 0.85, moving: 0.95, air: 0.92, contact: 0.65, blind: 0.7,
};

/** Each knob's range (the settings sliders and validation of stored values). */
export const CATCH_RANGES: Record<keyof CatchTuning, [number, number]> = {
  reach: [0.15, 0.8], twoHands: [0.3, 1], oneHand: [0.1, 1], body: [0, 1], edge: [0.2, 1], hard: [0.2, 1], moving: [0.5, 1], air: [0.3, 1], contact: [0, 1], blind: [0, 1],
};

/** Defaults with valid overrides applied (unknown keys and bad values dropped, values clamped to their range). */
export function catchTuning(o: unknown): CatchTuning {
  const out = { ...DEFAULT_CATCHING };
  if (o && typeof o === 'object') for (const k of Object.keys(DEFAULT_CATCHING) as (keyof CatchTuning)[]) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(CATCH_RANGES[k][1], Math.max(CATCH_RANGES[k][0], v));
  }
  return out;
}
