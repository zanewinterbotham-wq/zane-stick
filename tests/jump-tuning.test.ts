// JumpTuning merge (saved settings and a host's start message are trust boundaries).
import { describe, expect, it } from 'vitest';
import { JUMP_DEFAULTS, JUMP_RANGES, jumpTuning } from '../src/sim/anim/jump';

describe('jumpTuning', () => {
  it('absent or empty is the defaults, and the defaults sit inside their ranges', () => {
    for (const p of [undefined, null, {}, 'x' as never]) expect(jumpTuning(p)).toEqual(JUMP_DEFAULTS);
    for (const [k, [lo, hi]] of Object.entries(JUMP_RANGES)) {
      const v = JUMP_DEFAULTS[k as keyof typeof JUMP_DEFAULTS];
      expect(v, k).toBeGreaterThanOrEqual(lo); expect(v, k).toBeLessThanOrEqual(hi);
    }
    expect(Object.keys(JUMP_RANGES).sort()).toEqual(Object.keys(JUMP_DEFAULTS).sort());
  });
  it('keeps valid knobs, clamps out-of-range ones, drops junk and unknown keys', () => {
    const t = jumpTuning({ height: 1.4, dip: 5, load: -1, air: NaN, cooldown: '0.5' as never, bogus: 3 } as never);
    expect(t.height).toBe(1.4);
    expect(t.dip).toBe(JUMP_RANGES.dip[1]);
    expect(t.load).toBe(JUMP_RANGES.load[0]);
    expect(t.air).toBe(JUMP_DEFAULTS.air);
    expect(t.cooldown).toBe(JUMP_DEFAULTS.cooldown);
    expect('bogus' in t).toBe(false);
  });
  it('does not alias the defaults', () => {
    const t = jumpTuning({});
    t.height = 2;
    expect(JUMP_DEFAULTS.height).toBe(1);
  });
});
