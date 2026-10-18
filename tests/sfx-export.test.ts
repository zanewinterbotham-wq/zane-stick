import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportPicks } from '../tools/sfx/export-picks';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture(sounds: Record<string, string[]>, volumes: Record<string, number> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'sfx-export-'));
  const lib = join(dir, 'lib'), variants = (cat: string) => ['01', '02', '03'].map((n) => ({ id: `${cat}_${n}`, file: `${cat}/${n}.ogg` }));
  const manifest = { version: 1, categories: ['hit_a', 'ui_b'].map((id) => ({ id, label: id, group: 'g', event: 'e', variants: variants(id) })) };
  for (const c of manifest.categories) for (const v of c.variants) { mkdirSync(join(lib, c.id), { recursive: true }); writeFileSync(join(lib, v.file), v.id); }
  writeFileSync(join(lib, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'picks.json'), JSON.stringify({ version: 1, sounds, volumes, character: null, notes: '' }));
  mkdirSync(join(dir, 'public/sfx/old'), { recursive: true });
  writeFileSync(join(dir, 'public/sfx/old/stale.ogg'), 'x');
  return { picks: join(dir, 'picks.json'), libDir: lib, publicDir: join(dir, 'public'), out: join(dir, 'sfx-picks.json') };
}

describe('sfx:export', () => {
  it('copies only the picked files, keeps volumes (missing = 1), drops empty categories and stale files', () => {
    const o = fixture({ hit_a: ['hit_a_03', 'hit_a_01'], ui_b: [] }, { hit_a: 0.4, ui_b: 2 });
    const r = exportPicks(o);
    expect(r).toEqual({ version: 1, categories: { hit_a: { volume: 0.4, files: ['sfx/hit_a/03.ogg', 'sfx/hit_a/01.ogg'] } } });
    expect(JSON.parse(readFileSync(o.out, 'utf8'))).toEqual(r);
    expect(readFileSync(join(o.publicDir, 'sfx/hit_a/03.ogg'), 'utf8')).toBe('hit_a_03');
    expect(existsSync(join(o.publicDir, 'sfx/hit_a/02.ogg'))).toBe(false);
    expect(existsSync(join(o.publicDir, 'sfx/old'))).toBe(false);
    writeFileSync(o.picks, JSON.stringify({ version: 1, sounds: { ui_b: ['ui_b_02'] }, volumes: {}, character: null, notes: '' }));
    expect(exportPicks(o).categories).toEqual({ ui_b: { volume: 1, files: ['sfx/ui_b/02.ogg'] } });
    expect(existsSync(join(o.publicDir, 'sfx/hit_a'))).toBe(false);
  });

  it('rejects invalid picks and unknown sounds without touching public/', () => {
    const o = fixture({ hit_a: ['hit_a_09'] });
    expect(() => exportPicks(o)).toThrow('hit_a_09 is not in category hit_a');
    writeFileSync(o.picks, JSON.stringify({ version: 2 }));
    expect(() => exportPicks(o)).toThrow('version must be 1');
    expect(existsSync(join(o.publicDir, 'sfx/old/stale.ogg'))).toBe(true);
  });
});
