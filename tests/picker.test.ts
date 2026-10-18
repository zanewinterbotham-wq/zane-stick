import { describe, expect, it } from 'vitest';
import { emptyPicks, validate } from '../tools/picker/picks';

describe('picker picks validate()', () => {
  it('accepts the empty and a full picks file, dropping unknown fields and empty lists', () => {
    expect(validate(emptyPicks())).toEqual({ ok: true, picks: emptyPicks() });
    const full = { version: 1, sounds: { hit_helmet_helmet: ['hit_helmet_helmet_01', 'hit_helmet_helmet_02'], ui_click: [] },
      character: 'stick', volumes: { hit_helmet_helmet: 0.8 }, notes: 'louder hits', extra: 5 };
    expect(validate(full)).toEqual({ ok: true, picks: { version: 1, sounds: { hit_helmet_helmet: ['hit_helmet_helmet_01', 'hit_helmet_helmet_02'] },
      character: 'stick', volumes: { hit_helmet_helmet: 0.8 }, notes: 'louder hits' } });
  });

  it('the stadium field is optional: older files stay valid, a chosen stadium is kept, a bad one is refused', () => {
    expect(validate({ ...emptyPicks(), stadium: 'pro' })).toEqual({ ok: true, picks: { ...emptyPicks(), stadium: 'pro' } });
    expect(validate({ ...emptyPicks(), stadium: null })).toEqual({ ok: true, picks: emptyPicks() });
    const bad = validate({ ...emptyPicks(), stadium: 5 });
    expect(bad.ok ? [] : bad.errors).toEqual(['stadium must be a stadium id or null']);
  });

  it('rejects bad shapes with readable errors', () => {
    expect(validate(null).ok).toBe(false);
    expect(validate([]).ok).toBe(false);
    const bad = validate({ version: 2, sounds: { a: 'x', b: ['y', 'y'], c: [3] }, character: '', volumes: { a: -1, b: NaN, c: '1' }, notes: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toEqual([
      'version must be 1', 'sounds.a must be a list of variant ids', 'sounds.b has duplicate ids', 'sounds.c must be a list of variant ids',
      'character must be a style id or null', 'volumes.a must be a number from 0 to 4', 'volumes.b must be a number from 0 to 4',
      'volumes.c must be a number from 0 to 4', 'notes must be a string']);
    expect(validate({ ...emptyPicks(), sounds: undefined }).ok).toBe(false);
  });
});
