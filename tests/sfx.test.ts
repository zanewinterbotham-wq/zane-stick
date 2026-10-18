// Dev sound library (art/sfx, never deployed): manifest shape, files on disk, Ogg/Vorbis headers and the
// measured quality rules (no silence, no clipping, durations, onsets, loop seams, variants differ).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Analysis, type Manifest, checkLibrary, oggInfo } from '../tools/sfx/checks';
import { PACKS } from '../tools/sfx/library';

const dir = fileURLToPath(new URL('../art/sfx/', import.meta.url));
const manifest: Manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const analysis: Analysis = JSON.parse(readFileSync(join(dir, 'analysis.json'), 'utf8'));
const variants = manifest.categories.flatMap((c) => c.variants);

describe('sfx library', () => {
  it('passes every library rule (shape, licence, durations, no silence, no clipping, variants differ)', () => {
    expect(checkLibrary(manifest, analysis)).toEqual([]);
  });

  it('the rules catch clipping, silence, late starts and duplicate variants', () => {
    const c = manifest.categories[0], [a, b] = c.variants.map((v) => v.id);
    const bad: Analysis = structuredClone(analysis);
    bad[a] = { ...bad[a], clipped: 3, peak: 1, onset: 0.05 };
    bad[b] = { ...bad[a], clipped: 0, peak: 0.01, momentaryDb: -60, duration: bad[a].duration };
    const errs = checkLibrary(manifest, bad).join('\n');
    for (const want of [`${a}: clipping`, `${b}: too quiet`, `${a}: starts late`, 'near-identical']) expect(errs).toContain(want);
  });

  it('has the sounds the game needs, 8-16 variants each', () => {
    const ids = manifest.categories.map((c) => c.id);
    for (const need of ['hit_helmet_helmet', 'hit_pads_pads', 'hit_body_body', 'body_turf_tackle', 'foot_sprint', 'ball_bounce', 'game_whistle_end', 'crowd_ooh', 'ui_select'])
      expect(ids).toContain(need);
    for (const c of manifest.categories) expect(c.variants.length).toBeGreaterThanOrEqual(8);
  });

  it('every file exists and is mono 44.1 kHz Ogg Vorbis of the listed length', () => {
    for (const v of variants) {
      const f = join(dir, v.file);
      expect(existsSync(f), v.file).toBe(true);
      const info = oggInfo(readFileSync(f));
      expect(info.channels, v.file).toBe(1);
      expect(info.rate, v.file).toBe(44100);
      expect(Math.abs(info.samples / info.rate - v.duration), v.file).toBeLessThan(0.001);
    }
  });

  it('stays small enough for the repo and credits every pack it uses', () => {
    const bytes = variants.reduce((n, v) => n + statSync(join(dir, v.file)).size, 0);
    expect(bytes).toBeLessThan(15 * 1024 * 1024);
    const credits = readFileSync(join(dir, 'CREDITS.md'), 'utf8');
    for (const p of new Set(variants.map((v) => v.source).filter((s) => s !== 'synth'))) {
      expect(PACKS).toContain(p);
      expect(credits, p).toContain(p);
    }
  });
});
