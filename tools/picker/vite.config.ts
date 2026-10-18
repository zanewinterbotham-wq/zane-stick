// Dev-only sound and character picker (`npm run picker`). Never part of the game build or deploy.
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { validate } from './picks';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
// PICKER_LIBRARY=fixtures develops against the tiny fixtures instead of the real art/ library.
const lib = process.env.PICKER_LIBRARY === 'fixtures' ? join(here, 'fixtures') : join(repo, 'art');
const picksPath = process.env.PICKER_PICKS ? resolve(process.env.PICKER_PICKS) : join(lib, 'picks.json');
const mounts: Record<string, string> = { sfx: join(lib, 'sfx'), characters: join(lib, 'characters'), stadiums: join(lib, 'stadiums'), concepts: join(lib, 'concepts') };
const types: Record<string, string> = { ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', glb: 'model/gltf-binary', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', json: 'application/json' };

const readJson = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, 'utf8'));
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

async function dirs(path: string) {
  return existsSync(path) ? (await fs.readdir(path, { withFileTypes: true })) : [];
}

/** Character styles: every art/characters/<style>/ folder and every art/concepts/<style>.png. */
async function characters() {
  const ids = new Set<string>();
  for (const d of await dirs(mounts.characters)) if (d.isDirectory()) ids.add(d.name);
  for (const f of await dirs(mounts.concepts)) if (f.isFile() && f.name.endsWith('.png')) ids.add(f.name.slice(0, -4));
  const out = [];
  for (const id of [...ids].sort()) {
    const dir = join(mounts.characters, id);
    const models = (await dirs(dir)).filter((f) => f.isFile() && f.name.endsWith('.glb')).map((f) => f.name).sort();
    let info: { label?: unknown; pitch?: unknown } = {};
    try { if (existsSync(join(dir, 'info.json'))) info = await readJson(join(dir, 'info.json')) as typeof info; } catch { /* bad info.json: show the folder name */ }
    out.push({
      id,
      label: typeof info.label === 'string' ? info.label : id,
      pitch: typeof info.pitch === 'string' ? info.pitch : '',
      models: models.map((m) => ({ name: m.slice(0, -4), url: `/lib/characters/${encodeURIComponent(id)}/${encodeURIComponent(m)}` })),
      concept: existsSync(join(mounts.concepts, `${id}.png`)) ? `/lib/concepts/${encodeURIComponent(id)}.png` : null,
    });
  }
  return out;
}

/** Stadiums: every art/stadiums/<id>/ folder, with its render art/concepts/stadiums/<id>.png (or the game preview). */
async function stadiums() {
  const out = [];
  for (const d of (await dirs(mounts.stadiums)).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const id = d.name, dir = join(mounts.stadiums, id);
    const models = (await dirs(dir)).filter((f) => f.isFile() && f.name.endsWith('.glb')).map((f) => f.name).sort();
    let info: { label?: unknown; pitch?: unknown } = {};
    try { if (existsSync(join(dir, 'info.json'))) info = await readJson(join(dir, 'info.json')) as typeof info; } catch { /* bad info.json: show the folder name */ }
    out.push({
      id,
      label: typeof info.label === 'string' ? info.label : id,
      pitch: typeof info.pitch === 'string' ? info.pitch : '',
      models: models.map((m) => ({ name: m.slice(0, -4), url: `/lib/stadiums/${encodeURIComponent(id)}/${encodeURIComponent(m)}` })),
      concept: existsSync(join(mounts.concepts, 'stadiums', `${id}.png`)) ? `/lib/concepts/stadiums/${encodeURIComponent(id)}.png` : null,
    });
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('picks body too large');
  }
  return body;
}

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://picker');
  const path = decodeURIComponent(url.pathname);
  if (path === '/api/library' && req.method === 'GET') {
    const manifest = join(mounts.sfx, 'manifest.json');
    const sfx = existsSync(manifest) ? await readJson(manifest) : { version: 1, categories: [] };
    return send(res, 200, { sfx, characters: await characters(), stadiums: await stadiums(), picksPath: relative(repo, picksPath).split(sep).join('/') });
  }
  if (path === '/api/picks' && req.method === 'GET') {
    return send(res, 200, existsSync(picksPath) ? await readJson(picksPath) : null);
  }
  if (path === '/api/picks' && req.method === 'POST') {
    let parsed: unknown;
    try { parsed = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { ok: false, errors: [String(e)] }); }
    const v = validate(parsed);
    if (!v.ok) return send(res, 400, v);
    await fs.mkdir(dirname(picksPath), { recursive: true });
    // write then rename, so a crash mid-write never leaves a half-written picks file
    await fs.writeFile(`${picksPath}.tmp`, JSON.stringify(v.picks, null, 2) + '\n', 'utf8');
    await fs.rename(`${picksPath}.tmp`, picksPath);
    return send(res, 200, { ok: true, path: relative(repo, picksPath).split(sep).join('/') });
  }
  const m = /^\/lib\/(sfx|characters|stadiums|concepts)\/(.+)$/.exec(path);
  if (m && req.method === 'GET') {
    const base = mounts[m[1]];
    const file = resolve(base, m[2]);
    if (!file.startsWith(base + sep)) return send(res, 403, { error: 'outside the library' });
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return send(res, 404, { error: 'not found' });
    res.setHeader('Content-Type', types[file.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    return createReadStream(file).pipe(res);
  }
  next();
}

const library: Plugin = {
  name: 'picker-library',
  configureServer(server) {
    server.middlewares.use((req, res, next) => { handle(req, res, next).catch((e) => send(res, 500, { error: String(e) })); });
  },
};

export default defineConfig({
  root: here,
  publicDir: false,
  cacheDir: join(repo, 'node_modules/.vite-picker'),
  plugins: [library],
  server: { port: 5180, open: !process.env.PICKER_NO_OPEN },
});
