import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SampleChooser } from '../src/game/audio';
import picks from '../src/game/sfx-picks.json';
import { Rng } from '../src/sim/rng';

const cats = { foot_jog: { volume: 0.5, files: ['a', 'b', 'c'] }, ui_move: { volume: 2, files: ['only'] }, crowd_ooh: { volume: 1, files: ['x', 'y'] } };

describe('sample chooser', () => {
  it('never plays the same variant twice in a row, and uses every one', () => {
    const c = new SampleChooser(cats, new Rng(7)), seen = new Set<string>();
    let prev = '';
    for (let i = 0; i < 300; i++) {
      const r = c.choose('foot_jog', 1, i)!;
      expect(r.file).not.toBe(prev);
      prev = r.file; seen.add(r.file);
    }
    expect(seen.size).toBe(3);
    expect(c.choose('ui_move', 1, 0)!.file).toBe('only'); // a single variant still plays
    expect(c.choose('ui_move', 1, 1)!.file).toBe('only');
  });

  it('gain is the category volume times the event loudness, with a few percent of pitch jitter', () => {
    const c = new SampleChooser(cats, new Rng(1));
    expect(c.choose('foot_jog', 0.8, 0)!.gain).toBeCloseTo(0.4, 9);
    expect(c.choose('ui_move', 0.25, 0)!.gain).toBeCloseTo(0.5, 9);
    for (let i = 1; i < 100; i++) expect(Math.abs(c.choose('foot_jog', 1, i)!.rate - 1)).toBeLessThanOrEqual(0.04);
  });

  it('a category stays quiet for its cooldown, and one with no picks never plays', () => {
    const c = new SampleChooser(cats, new Rng(3));
    expect(c.choose('crowd_ooh', 1, 10)).not.toBeNull();
    expect(c.choose('crowd_ooh', 1, 12)).toBeNull(); // 3 s cooldown
    expect(c.choose('foot_jog', 1, 12)).not.toBeNull(); // other categories are independent
    expect(c.choose('crowd_ooh', 1, 13.1)).not.toBeNull();
    expect(c.choose('game_whistle_end', 1, 0)).toBeNull();
    expect(c.has('game_whistle_end')).toBe(false);
  });

  it('the shipped picks leave the owner\'s empty categories silent and keep their volumes', () => {
    // the shipped file must match art/picks.json (run npm run sfx:export after picking)
    const owner = JSON.parse(readFileSync('art/picks.json', 'utf8')) as { sounds: Record<string, string[]>; volumes: Record<string, number> };
    const shipped = picks.categories as Record<string, { volume: number; files: string[] }>;
    for (const [cat, ids] of Object.entries(owner.sounds)) {
      if (!ids.length) { expect(Object.keys(picks.categories)).not.toContain(cat); continue; }
      expect(shipped[cat].files).toHaveLength(ids.length);
      expect(shipped[cat].volume).toBe(owner.volumes[cat] ?? 1);
    }
  });
});
