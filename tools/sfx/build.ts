// npm run sfx:build — regenerates art/sfx/ (dev-only sound library: .ogg files, manifest.json, analysis.json).
// npm run sfx:build -- <category> … regenerates only those categories and keeps every other one as it is.
// Needs ffmpeg with libvorbis and the CC0 packs. Found via SFX_FFMPEG / SFX_PACKS, else an "art tools" folder
// next to the repo or any parent of it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Sig, SR, analyse, fade, gain, hashSeed, hp, makeRng, peak, pitch } from './dsp';
import { CATEGORIES, type Category } from './library';
import { type Analysis, type Manifest, VOICE, checkLibrary, oggInfo } from './checks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(root, 'art', 'sfx');

function findArtTools(): string | undefined {
  for (let d = root; ; d = dirname(d)) {
    if (existsSync(join(d, 'art tools'))) return join(d, 'art tools');
    if (dirname(d) === d) return undefined;
  }
}
const tools = findArtTools();
const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const ffmpeg = process.env.SFX_FFMPEG ?? (tools && existsSync(join(tools, 'ffmpeg', 'bin', exe)) ? join(tools, 'ffmpeg', 'bin', exe) : 'ffmpeg');
const packsDir = process.env.SFX_PACKS ?? (tools ? join(tools, 'sound') : '');

function run(args: string[], input?: Buffer): Buffer {
  const p = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { input, maxBuffer: 1 << 30 });
  if (p.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${p.error ?? p.stderr.toString()}`);
  return p.stdout;
}
const toSig = (b: Buffer): Sig => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~3)));
const decode = (file: string) => toSig(run(['-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), 'pipe:1']));
function encode(x: Sig, file: string) {
  run(['-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0', '-c:a', 'libvorbis', '-q:a', '4',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', file], Buffer.from(x.buffer, x.byteOffset, x.byteLength));
}
const packCache = new Map<string, Sig>();
function pack(p: string, name: string): Sig {
  const key = `${p}/${name}`;
  if (!packCache.has(key)) {
    // a name with its extension is a path inside the pack (packs that are not flat .ogg folders)
    const file = [join(packsDir, p, 'Audio', `${name}.ogg`), join(packsDir, p, `${name}.ogg`), join(packsDir, p, name)].find(existsSync);
    if (!file) throw new Error(`pack sound not found: ${key} (set SFX_PACKS)`);
    packCache.set(key, decode(file));
  }
  return packCache.get(key)!.slice();
}

/** Trim silence, de-click edges, then gain so the loudest 50 ms sits at the category level, peak capped at -1.4 dBFS. */
function finish(x: Sig, c: Category): Sig {
  let y = x;
  if (c.kind !== 'loop') {
    y = hp(y, 20);
    const p = peak(y);
    let a = 0, b = y.length - 1;
    while (a < b && Math.abs(y[a]) < p * 0.01) a++; // start on the transient: game events need zero latency
    while (b > a && Math.abs(y[b]) < p * 0.002) b--;
    y = fade(y.slice(Math.max(0, a - Math.round(0.0005 * SR)), Math.min(y.length, b + Math.round(0.01 * SR))), 0.0005, 0.01);
  }
  const m = analyse(y).momentaryDb, target = c.level ?? -14;
  gain(y, Math.pow(10, (target - m) / 20));
  const p = peak(y);
  if (p > 0.85) gain(y, 0.85 / p);
  return y;
}

const t0 = Date.now();
mkdirSync(outDir, { recursive: true });
const only = new Set(process.argv.slice(2));
for (const id of only) if (!CATEGORIES.some((c) => c.id === id)) throw new Error(`unknown category ${id}`);
const read = <T>(f: string, empty: T): T => (only.size && existsSync(join(outDir, f)) ? JSON.parse(readFileSync(join(outDir, f), 'utf8')) : empty);
const kept: Manifest = read('manifest.json', { version: 1, categories: [] }), keptAnalysis: Analysis = read('analysis.json', {});
for (const d of readdirSync(outDir, { withFileTypes: true })) if (d.isDirectory() && (!only.size || only.has(d.name))) rmSync(join(outDir, d.name), { recursive: true });
const manifest: Manifest = { version: 1, categories: [] };
const analysis: Analysis = {};
const round = (x: number, k = 4) => Number(x.toFixed(k));
for (const c of CATEGORIES) {
  if (only.size && !only.has(c.id)) {
    const prev = kept.categories.find((x) => x.id === c.id);
    if (!prev) throw new Error(`${c.id} has never been built: build it too`);
    manifest.categories.push(prev);
    for (const v of prev.variants) analysis[v.id] = keptAnalysis[v.id];
    continue;
  }
  mkdirSync(join(outDir, c.id));
  const variants: Manifest['categories'][number]['variants'] = [];
  for (let i = 0; i < c.count; i++) {
    const nn = String(i + 1).padStart(2, '0'), id = `${c.id}_${nn}`, file = `${c.id}/${nn}.ogg`;
    const made = c.gen({ r: makeRng(hashSeed(id)), i, n: c.count, v: c.count > 1 ? i / (c.count - 1) : 0, pack });
    const x = finish(made.x, c), path = join(outDir, file);
    encode(x, path);
    // The Ogg granule length is what browsers play. ffmpeg's decode is start-aligned but its end is off by up
    // to ~128 samples either way, so fit it to the granule length (a short tail is filled from the render).
    const { samples } = oggInfo(readFileSync(path));
    if (samples !== x.length) throw new Error(`${file}: encoded ${samples} samples, rendered ${x.length}`);
    const dec = decode(path), y = x.slice();
    y.set(dec.subarray(0, samples));
    const s = analyse(y);
    analysis[id] = { kind: c.kind, ...s, duration: round(s.duration), peak: round(s.peak), rmsDb: round(s.rmsDb, 2), momentaryDb: round(s.momentaryDb, 2),
      onset: round(s.onset), centroid: round(s.centroid, 1), bands: s.bands.map((b) => round(b)), segments: s.segments.map((e) => round(e)), loopJump: round(s.loopJump, 2) };
    if (VOICE[c.id]) { const p = pitch(y); Object.assign(analysis[id], { f0: round(p.f0, 1), voiced: round(p.voiced, 3) }); }
    variants.push({ id, file, source: made.source ?? 'synth', license: 'CC0', duration: round(s.duration, 3), note: made.note });
  }
  manifest.categories.push({ id: c.id, label: c.label, group: c.group, event: c.event, variants });
  const ds = variants.map((v) => v.duration), cs = variants.map((v) => analysis[v.id].centroid);
  const f0s = VOICE[c.id] ? `  f0 ${variants.map((v) => analysis[v.id].f0!.toFixed(0)).join('/')} Hz` : '';
  console.log(`${c.id.padEnd(22)} ${String(c.count).padStart(2)}  ${Math.min(...ds).toFixed(2)}-${Math.max(...ds).toFixed(2)} s  centroid ${Math.min(...cs).toFixed(0)}-${Math.max(...cs).toFixed(0)} Hz  pack ${variants.filter((v) => v.source !== 'synth').length}${f0s}`);
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(outDir, 'analysis.json'), JSON.stringify(analysis) + '\n');
const errors = checkLibrary(manifest, analysis);
const total = manifest.categories.reduce((n, c) => n + c.variants.length, 0);
console.log(`${manifest.categories.length} categories, ${total} variants in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
