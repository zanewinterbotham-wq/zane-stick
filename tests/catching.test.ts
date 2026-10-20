// Catch tuning (catching.ts): the defaults are the easy ones, overrides are validated and clamped, and the game's setting
// keeps only valid overrides.
import { describe, expect, it } from 'vitest';
import { CATCH_RANGES, catchTuning, DEFAULT_CATCHING } from '../src/sim/modes/catching';

describe('catch tuning', () => {
  it('defaults when empty; overrides apply; bad values are dropped and out-of-range ones clamped', () => {
    expect(catchTuning(undefined)).toEqual(DEFAULT_CATCHING);
    expect(catchTuning({ oneHand: 0.4 }).oneHand).toBe(0.4);
    expect(catchTuning({ reach: 9, body: -1, hard: 'x', nope: 1 })).toEqual({ ...DEFAULT_CATCHING, reach: CATCH_RANGES.reach[1], body: 0 });
    for (const [k, [lo, hi]] of Object.entries(CATCH_RANGES)) {
      const v = DEFAULT_CATCHING[k as keyof typeof DEFAULT_CATCHING];
      expect(v).toBeGreaterThanOrEqual(lo); expect(v).toBeLessThanOrEqual(hi);
    }
  });
  it('the defaults are easier than the first rule in every factor', () => {
    const first = { reach: 0.3, twoHands: 0.95, oneHand: 0.55, body: 0.3, edge: 0.5, hard: 0.6, moving: 0.85, air: 0.85, contact: 0.4, blind: 0.3 };
    for (const [k, v] of Object.entries(first)) expect(DEFAULT_CATCHING[k as keyof typeof first]).toBeGreaterThan(v);
  });
});
