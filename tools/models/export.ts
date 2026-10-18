// npm run models:export — copies the character models (art/characters/<style>/<style>.glb) into public/models/ and
// writes src/game/skins.json, the skin list the game loads. The owner's pick (art/picks.json) comes first.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STYLES = ['vinyl', 'lowpoly', 'toon', 'voxel', 'clay', 'future', 'paper', 'rubberhose'];
// how the game shades each style; everything else keeps the file's PBR materials
const LOOK: Record<string, string> = { toon: 'toon', rubberhose: 'toon', clay: 'clay', paper: 'paper' };

const pick: string = JSON.parse(readFileSync(join(root, 'art', 'picks.json'), 'utf8')).character;
const order = [pick, ...STYLES.filter((s) => s !== pick)];
mkdirSync(join(root, 'public', 'models'), { recursive: true });
const skins = order.map((id) => {
  const src = join(root, 'art', 'characters', id, id + '.glb');
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  copyFileSync(src, join(root, 'public', 'models', id + '.glb'));
  const info = JSON.parse(readFileSync(join(root, 'art', 'characters', id, 'info.json'), 'utf8'));
  // every skin is unlocked for now; the flag is where a future unlock system plugs in
  return { id, label: info.label, pitch: info.pitch, file: `models/${id}.glb`, look: LOOK[id] ?? 'standard', unlocked: true };
});
writeFileSync(join(root, 'src', 'game', 'skins.json'), JSON.stringify(skins, null, 2) + '\n');
console.log(`exported ${skins.length} skins: ${order.join(', ')}`);
