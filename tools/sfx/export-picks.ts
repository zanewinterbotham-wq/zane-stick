// npm run sfx:export — copies only the owner's picked sounds (art/picks.json) out of the dev library (art/sfx,
// never deployed) into public/sfx/, and writes src/game/sfx-picks.json for the game's sample player.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../picker/picks';
import type { Manifest } from './checks';

export interface SfxPicks { version: 1; categories: Record<string, { volume: number; files: string[] }>; effects?: string[] }
/** Injury sounds (design §6.6) the owner has not picked yet: the game plays their first two variants meanwhile. */
export const TEMP_DEFAULTS = ['bone_crack', 'pain_scream', 'pain_moan', 'ko_thud', 'ko_ring'];

export function exportPicks(o: { picks: string; libDir: string; publicDir: string; out: string }): SfxPicks {
  const v = validate(JSON.parse(readFileSync(o.picks, 'utf8')));
  if (!v.ok) throw new Error(`${o.picks}:\n  ${v.errors.join('\n  ')}`);
  const manifest: Manifest = JSON.parse(readFileSync(join(o.libDir, 'manifest.json'), 'utf8'));
  const res: SfxPicks = { version: 1, categories: {} };
  const copies: [string, string][] = [];
  const temp = TEMP_DEFAULTS.filter((id) => !v.picks.sounds[id]).flatMap((id) => { const c = manifest.categories.find((x) => x.id === id); return c ? [[id, c.variants.slice(0, 2).map((x) => x.id)] as [string, string[]]] : []; });
  for (const [cat, ids] of [...Object.entries(v.picks.sounds), ...temp]) {
    const c = manifest.categories.find((x) => x.id === cat);
    if (!c) throw new Error(`picked category ${cat} is not in the library`);
    const files = ids.map((id) => {
      const variant = c.variants.find((x) => x.id === id);
      if (!variant) throw new Error(`picked sound ${id} is not in category ${cat}`);
      const src = join(o.libDir, variant.file), rel = `sfx/${cat}/${basename(variant.file)}`;
      if (!existsSync(src)) throw new Error(`missing library file ${src}`);
      copies.push([src, join(o.publicDir, rel)]);
      return rel;
    });
    res.categories[cat] = { volume: v.picks.volumes[cat] ?? 1, files };
  }
  if (v.picks.effects?.length) res.effects = v.picks.effects;
  // a clean copy each time, so un-picked sounds never linger in the deploy
  rmSync(join(o.publicDir, 'sfx'), { recursive: true, force: true });
  for (const [src, dst] of copies) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); }
  writeFileSync(o.out, JSON.stringify(res, null, 2) + '\n');
  return res;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const r = exportPicks({ picks: join(root, 'art/picks.json'), libDir: join(root, 'art/sfx'), publicDir: join(root, 'public'), out: join(root, 'src/game/sfx-picks.json') });
  const n = Object.values(r.categories).reduce((s, c) => s + c.files.length, 0);
  console.log(`exported ${n} sounds in ${Object.keys(r.categories).length} categories to public/sfx`);
}
