// npm run models:export — copies the character models (art/characters/<style>/<style>.glb, or a rigged model in
// art/models/<dir>/<dir>.glb, see MODELS) and the stadiums
// (art/stadiums/<id>/<id>.glb) into public/models/, with a small preview image of each for the inventory, and writes
// src/game/skins.json and src/game/stadiums.json, the lists the game loads. The owner's picks (art/picks.json) come first.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STYLES = ['vinyl', 'lowpoly', 'toon', 'voxel', 'clay', 'future', 'paper', 'rubberhose'];
const STADIUMS = ['college', 'highschool', 'dolphinhills', 'pro', 'night', 'backyard', 'crater'];
// how the game shades each style; everything else keeps the file's PBR materials
const LOOK: Record<string, string> = { toon: 'toon', rubberhose: 'toon', clay: 'clay', paper: 'paper' };
// skins shipped from a rigged model (art/models/<dir>/: <dir>.glb, info.json, preview.png) instead of a procedural style
const MODELS: Record<string, string> = { future: 'futurearmor' };

const picks = JSON.parse(readFileSync(join(root, 'art', 'picks.json'), 'utf8')) as { character: string; stadium?: string | null };
const out = join(root, 'public', 'models');
mkdirSync(join(out, 'stadiums'), { recursive: true });
mkdirSync(join(out, 'previews'), { recursive: true });

/** ImageMagick, if the art tools are installed (env MAGICK, or art tools/imagemagick next to the project): used to
 *  shrink previews. Without it the full-size picture is copied instead. */
function magick(): string | null {
  if (process.env.MAGICK) return process.env.MAGICK;
  for (let dir = root; parse(dir).root !== dir; dir = dirname(dir)) {
    const m = join(dir, 'art tools', 'imagemagick', 'magick.exe');
    if (existsSync(m)) return m;
  }
  return null;
}
const MAGICK = magick();

/** Writes the preview for `src` to public/models/<dest>.jpg (resized to `width` px) and returns its game-relative path. */
function preview(src: string, dest: string, width: number): string | null {
  if (!existsSync(src)) return null;
  const jpg = join(out, dest + '.jpg');
  if (MAGICK && spawnSync(MAGICK, [src, '-resize', `${width}x`, '-quality', '82', jpg], { stdio: 'ignore' }).status === 0) return `models/${dest}.jpg`;
  const ext = src.slice(src.lastIndexOf('.'));
  copyFileSync(src, join(out, dest + ext));
  return `models/${dest}${ext}`;
}

const order = <T extends string>(all: T[], pick: string | null | undefined) => (pick && all.includes(pick as T) ? [pick as T, ...all.filter((s) => s !== pick)] : all);

const skinOrder = order(STYLES, picks.character);
const skins = skinOrder.map((id) => {
  const m = MODELS[id], dir = m ? join(root, 'art', 'models', m) : join(root, 'art', 'characters', id), src = join(dir, (m ?? id) + '.glb');
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  copyFileSync(src, join(out, id + '.glb'));
  const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'));
  // a rigged model's single-athlete render (like the procedural skins' cards), else its preview.png
  const pic = preview(m ? [join(dir, 'renders', 'preview_harbor-gulls.png'), join(dir, 'preview.png')].find(existsSync)! : join(root, 'art', 'concepts', 'renders', id, 'harbor-gulls-three-quarter.png'), `previews/${id}`, 260);
  // every skin is unlocked for now; the flag is where a future unlock system plugs in
  return { id, label: info.label, pitch: info.pitch, file: `models/${id}.glb`, preview: pic, look: LOOK[id] ?? 'standard', unlocked: true };
});
writeFileSync(join(root, 'src', 'game', 'skins.json'), JSON.stringify(skins, null, 2) + '\n');
console.log(`exported ${skins.length} skins: ${skinOrder.join(', ')}`);

const stadiumOrder = order(STADIUMS, picks.stadium);
const stadiums = stadiumOrder.map((id) => {
  const dir = join(root, 'art', 'stadiums', id), src = join(dir, id + '.glb');
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  copyFileSync(src, join(out, 'stadiums', id + '.glb'));
  const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8'));
  const pic = preview(join(dir, 'preview.jpg'), `previews/stadium-${id}`, 480);
  return { id, label: info.label, pitch: info.pitch, file: `models/stadiums/${id}.glb`, preview: pic, scene: info.scene, unlocked: true };
});
writeFileSync(join(root, 'src', 'game', 'stadiums.json'), JSON.stringify(stadiums, null, 2) + '\n');
console.log(`exported ${stadiums.length} stadiums: ${stadiumOrder.join(', ')}`);
