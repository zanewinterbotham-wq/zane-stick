// Mid-rep team changes (Infection): the renderer recolours an athlete only when his team differs from what is shown.
import { describe, expect, it } from 'vitest';
import { teamChanged } from '../src/game/render/athleteMesh';

describe('teamChanged', () => {
  it('is true once per change and updates what is shown', () => {
    const shown = [0, 0, 1];
    expect(teamChanged(shown, 0, 0)).toBe(false);
    expect(teamChanged(shown, 1, 1)).toBe(true);
    expect(shown).toEqual([0, 1, 1]);
    expect(teamChanged(shown, 1, 1)).toBe(false);
  });
});
