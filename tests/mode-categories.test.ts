import { describe, expect, it } from 'vitest';
import { modeCategory } from '../src/game/modes';
import { MODES } from '../src/sim/modes/registry';

describe('Play menu categories', () => {
  it('puts every registered mode under a named tab, and unknown ids under Other', () => {
    for (const m of MODES) expect(modeCategory(m.id), m.id).not.toBe('other');
    expect(modeCategory('someNewMode')).toBe('other');
  });
});
