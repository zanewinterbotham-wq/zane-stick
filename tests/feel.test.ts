import { describe, expect, it } from 'vitest';
import { BIG_HIT_N, hitFeel } from '../src/game/feel';

describe('hit feel', () => {
  it('grows with force and closing speed', () => {
    expect(hitFeel(4000, 2).k).toBeLessThan(hitFeel(8000, 2).k);
    expect(hitFeel(6000, 1).k).toBeLessThan(hitFeel(6000, 8).k);
    expect(hitFeel(20000, 20).k).toBe(1);
  });
  it('hit-stop is 40-80 ms and only on big hits', () => {
    expect(hitFeel(BIG_HIT_N - 1, 9).stopMs).toBe(0);
    for (const [F, v] of [[BIG_HIT_N, 0], [BIG_HIT_N, 9], [30000, 12]]) {
      const s = hitFeel(F, v).stopMs;
      expect(s).toBeGreaterThanOrEqual(40);
      expect(s).toBeLessThanOrEqual(80);
    }
  });
});
