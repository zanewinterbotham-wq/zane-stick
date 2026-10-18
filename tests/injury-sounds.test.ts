// Injury sounds (design §6.6): the dev library's new categories, the human-voice rules that guard the synthesized
// screams and moans, and the temporary defaults the game plays until the owner picks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Analysis, type Manifest, VOICE, checkLibrary } from '../tools/sfx/checks';
import { SR, osc, pitch } from '../tools/sfx/dsp';
import { TEMP_DEFAULTS } from '../tools/sfx/export-picks';
import game from '../src/game/sfx-picks.json';

const dir = fileURLToPath(new URL('../art/sfx/', import.meta.url));
const manifest: Manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const analysis: Analysis = JSON.parse(readFileSync(join(dir, 'analysis.json'), 'utf8'));

describe('injury sounds', () => {
  it('the library has 8-12 variants of each injury sound and fresh crowd cheers', () => {
    for (const id of [...TEMP_DEFAULTS, 'crowd_cheer']) {
      const c = manifest.categories.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect(c!.variants.length).toBeGreaterThanOrEqual(8);
      expect(c!.variants.length).toBeLessThanOrEqual(12);
    }
  });

  it('screams and moans measure as human voices; the rule catches one that is not', () => {
    for (const id of Object.keys(VOICE)) for (const v of manifest.categories.find((c) => c.id === id)!.variants) {
      expect(analysis[v.id].f0, v.id).toBeGreaterThanOrEqual(VOICE[id].f0[0]);
      expect(analysis[v.id].f0, v.id).toBeLessThanOrEqual(VOICE[id].f0[1]);
    }
    const bad: Analysis = structuredClone(analysis), id = 'pain_scream_01';
    bad[id] = { ...bad[id], f0: 90, voiced: 0.1, bands: [0.9, 0.1, 0, 0, 0, 0, 0, 0] };
    const errs = checkLibrary(manifest, bad).join('\n');
    for (const want of [`${id}: voice pitch 90 Hz`, `${id}: only 10 % voiced`, `${id}: only 0 % of the energy`]) expect(errs).toContain(want);
  });

  it('pitch() finds the fundamental of a tone with harmonics, not a multiple of its period', () => {
    const x = osc(0.5, 220, 'saw');
    for (let i = 0; i < x.length; i++) x[i] += 0.3 * Math.sin(2 * Math.PI * 440 * i / SR);
    const p = pitch(x);
    expect(p.f0).toBeGreaterThan(215);
    expect(p.f0).toBeLessThan(225);
    expect(p.voiced).toBeGreaterThan(0.9);
  });

  it('the game plays the first two variants of an unpicked injury sound meanwhile', () => {
    const cats = (game as { categories: Record<string, { files: string[] }> }).categories;
    for (const id of TEMP_DEFAULTS) expect(cats[id]?.files.length, id).toBeGreaterThanOrEqual(1);
  });
});
