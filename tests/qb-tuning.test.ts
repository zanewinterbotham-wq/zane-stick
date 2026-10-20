// Bot QB tuning (qbTuning.ts): overrides validated and clamped, skill over the full range (0.5 = the old default).
import { describe, expect, it } from 'vitest';
import { QB_DEFAULTS, QB_RANGES, qbSkill, qbTuning } from '../src/sim/brains/football/qbTuning';

describe('bot QB tuning', () => {
  it('defaults, overrides, bad values dropped, out of range clamped', () => {
    expect(qbTuning(undefined)).toEqual(QB_DEFAULTS);
    expect(qbTuning({ skill: 0.9, open: 5, look: 'x', nope: 1 })).toEqual({ ...QB_DEFAULTS, skill: 0.9, open: QB_RANGES.open[1] });
  });
  it('skill: 0.5 is the old default (reaction 0.35 s, noise 0.35), 1 is elite, better at every step', () => {
    expect(qbSkill(0.5).reaction).toBeCloseTo(0.35, 6); expect(qbSkill(0.5).noise).toBeCloseTo(0.35, 6);
    expect(qbSkill(1)).toEqual({ reaction: 0.05, noise: 0.02 });
    for (let k = 0; k < 1; k += 0.1) { expect(qbSkill(k + 0.1).reaction).toBeLessThan(qbSkill(k).reaction); expect(qbSkill(k + 0.1).noise).toBeLessThan(qbSkill(k).noise); }
  });
});
