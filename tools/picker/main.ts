// Dev-only picker UI: audition sounds, choose a character style, save art/picks.json.
import { emptyPicks, validate, type Picks } from './picks';

interface Variant { id: string; file: string; source: string; license: string; duration: number; note: string }
interface Category { id: string; label: string; group: string; event: string; variants: Variant[] }
interface Character { id: string; label: string; pitch: string; models: { name: string; url: string }[]; concept: string | null }
interface Library { sfx: { version: number; categories: Category[] }; characters: Character[]; stadiums?: Character[]; picksPath: string }

const GROUPS = ['Hits', 'Bodies', 'Feet', 'Ball', 'Air', 'Game', 'UI'];
const STORE = 'zane-stick-picker-v1';
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

let lib: Library;
let picks: Picks = emptyPicks();
let savedJson = '';
const rows: { cat: Category; v: Variant; el: HTMLElement; heart: HTMLButtonElement }[] = [];
const catUi = new Map<string, { picked: HTMLElement; vol: HTMLInputElement; out: HTMLOutputElement }>();
let cur = 0;

function status(text: string, kind: '' | 'warn' | 'err' = '') {
  const s = $('#status');
  s.textContent = text;
  s.className = kind;
}

function changed() {
  try { localStorage.setItem(STORE, JSON.stringify(picks)); } catch { /* storage blocked: the project file is the real save */ }
  refresh();
  if (JSON.stringify(picks) !== savedJson) status('Unsaved changes', 'warn');
}

// ---- sounds ----
let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer>>();
let playing: { src: AudioBufferSourceNode; el: HTMLElement } | null = null;

async function play(i: number) {
  const { cat, v, el } = rows[i];
  ctx ??= new AudioContext();
  await ctx.resume();
  const url = `/lib/sfx/${v.file.split('/').map(encodeURIComponent).join('/')}`;
  let buf = buffers.get(url);
  if (!buf) {
    const c = ctx;
    buf = fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); }).then((b) => c.decodeAudioData(b));
    buffers.set(url, buf);
    buf.catch(() => buffers.delete(url));
  }
  try {
    const data = await buf;
    if (playing) { playing.src.onended = null; playing.src.stop(); playing.el.classList.remove('playing'); }
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = data;
    gain.gain.value = picks.volumes[cat.id] ?? 1;
    src.connect(gain).connect(ctx.destination);
    src.start();
    el.classList.add('playing');
    playing = { src, el };
    src.onended = () => { el.classList.remove('playing'); if (playing?.src === src) playing = null; };
    status(`Played ${v.id}`);
  } catch (e) {
    status(`Could not play ${v.id}: ${e}`, 'err');
  }
}

function togglePick(i: number) {
  const { cat, v } = rows[i];
  const list = picks.sounds[cat.id] ?? [];
  const next = list.includes(v.id) ? list.filter((id) => id !== v.id) : [...list, v.id];
  if (next.length) picks.sounds[cat.id] = next; else delete picks.sounds[cat.id];
  changed();
}

function setCurrent(i: number, scroll = true) {
  if (!rows.length) return;
  rows[cur]?.el.classList.remove('current');
  cur = Math.max(0, Math.min(rows.length - 1, i));
  rows[cur].el.classList.add('current');
  if (scroll) rows[cur].el.scrollIntoView({ block: 'nearest' });
}

function jumpCategory(dir: 1 | -1) {
  const cat = rows[cur].cat;
  let i = cur;
  if (dir > 0) { while (i < rows.length && rows[i].cat === cat) i++; }
  else {
    while (i > 0 && rows[i].cat === cat) i--;
    const prev = rows[i].cat; // first row of the previous category
    while (i > 0 && rows[i - 1].cat === prev) i--;
  }
  if (i < rows.length) setCurrent(i);
}

function renderSounds() {
  const list = $('#soundList');
  const cats = lib.sfx.categories;
  if (!cats.length) {
    list.append(h('div', { className: 'empty', textContent: 'No sounds yet: art/sfx/manifest.json is missing or empty.' }));
    return;
  }
  const groups = [...GROUPS, ...new Set(cats.map((c) => c.group).filter((g) => !GROUPS.includes(g)))];
  for (const g of groups) {
    const inGroup = cats.filter((c) => c.group === g);
    if (!inGroup.length) continue;
    const sec = h('section', { className: 'group' }, h('h2', { textContent: g }));
    for (const cat of inGroup) {
      const picked = h('span', { className: 'picked' });
      const vol = h('input', { type: 'range', min: '0', max: '2', step: '0.05', title: 'Volume for this sound in the game' });
      const out = h('output');
      vol.addEventListener('input', () => {
        const v = Number(vol.value);
        if (v === 1) delete picks.volumes[cat.id]; else picks.volumes[cat.id] = v;
        changed();
      });
      catUi.set(cat.id, { picked, vol, out });
      const box = h('div', { className: 'cat' }, h('header', {},
        h('span', { className: 'label', textContent: cat.label }),
        h('span', { className: 'event dim', textContent: cat.event }),
        picked,
        h('label', {}, 'Volume', vol, out)));
      box.dataset.cat = cat.id;
      for (const v of cat.variants) {
        const i = rows.length;
        const playBtn = h('button', { className: 'play', textContent: '▶', title: 'Play (Space or P)', tabIndex: -1 });
        const heart = h('button', { className: 'heart', title: 'Pick (X)', tabIndex: -1 });
        const el = h('div', { className: 'row' }, playBtn,
          h('span', { className: 'mono', textContent: v.id }),
          h('span', { className: 'note', textContent: v.note }),
          h('span', { className: 'dur dim', textContent: `${v.duration.toFixed(2)} s` }),
          h('span', { className: 'src dim', textContent: `${v.source} · ${v.license}`, title: `${v.source} · ${v.license}` }),
          heart);
        el.dataset.variant = v.id;
        el.addEventListener('click', () => setCurrent(i, false));
        playBtn.addEventListener('click', () => play(i));
        heart.addEventListener('click', () => togglePick(i));
        rows.push({ cat, v, el, heart });
        box.append(el);
      }
      sec.append(box);
    }
    list.append(sec);
  }
  setCurrent(0, false);
}

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if ($('#sounds').hidden || document.querySelector('.layer') || !rows.length || e.ctrlKey || e.metaKey || e.altKey) return;
  if (t.closest('input, textarea, select')) return;
  const act: Record<string, () => void> = {
    ArrowDown: () => setCurrent(cur + 1), ArrowUp: () => setCurrent(cur - 1),
    Space: () => play(cur), KeyP: () => play(cur), KeyX: () => togglePick(cur),
    KeyA: () => jumpCategory(-1), KeyS: () => jumpCategory(1),
  };
  const f = act[e.code];
  if (!f) return;
  e.preventDefault();
  if (t instanceof HTMLButtonElement) t.blur(); // so Space does not also click the focused button
  f();
});

// ---- characters ----
type Kind = 'character' | 'stadium';
const renderCharacters = () => renderCards('character');
let stadiumsShown = false;

/** Character styles and stadiums share one card layout: render, optional 3D view, a radio to choose it. */
function renderCards(kind: Kind) {
  const cards = $(kind === 'character' ? '#cards' : '#stadiumCards');
  const items = kind === 'character' ? lib.characters : lib.stadiums ?? [];
  if (!items.length) {
    cards.append(h('div', { className: 'empty', textContent: kind === 'character' ? 'No characters yet: nothing in art/characters/ or art/concepts/.' : 'No stadiums yet: nothing in art/stadiums/.' }));
    return;
  }
  for (const c of items) {
    const radio = h('input', { type: 'radio', name: kind, value: c.id });
    radio.addEventListener('change', () => { picks[kind] = c.id; changed(); });
    const view = h('button', { textContent: 'View 3D', disabled: !c.models.length, title: c.models.length ? '' : 'No .glb model yet' });
    view.addEventListener('click', () => openViewer(c, kind));
    const img = c.concept ? h('img', { src: c.concept, alt: `${c.label} render`, loading: 'lazy' }) : 'No render yet';
    const card = h('article', { className: 'card' + (kind === 'stadium' ? ' wide' : '') },
      h('div', { className: 'img' }, img),
      h('div', { className: 'body' },
        h('h3', { textContent: c.label }),
        c.pitch ? h('p', { className: 'dim', textContent: c.pitch }) : '',
        h('p', { className: 'mono dim', textContent: c.models.length ? c.models.map((m) => `${m.name}.glb`).join(', ') : 'no models' }),
        h('div', { className: 'foot' }, view, h('label', {}, radio, 'Choose this one'))));
    if (kind === 'character') card.dataset.style = c.id; else card.dataset.stadium = c.id;
    cards.append(card);
  }
}

async function openViewer(c: Character, kind: Kind = 'character') {
  const [T, { GLTFLoader }, { OrbitControls }] = await Promise.all([
    import('three'), import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/controls/OrbitControls.js')]);
  const stage = h('div', { className: 'stage' });
  const vstatus = h('div', { className: 'vstatus dim', textContent: 'Loading…' });
  const close = h('button', { textContent: 'Close', title: 'Close (Esc)' });
  const teamBtns = c.models.length > 1 ? c.models.map((m, i) => {
    const b = h('button', { textContent: m.name });
    b.addEventListener('click', () => load(i));
    return b;
  }) : [];
  const layer = h('div', { className: 'layer' }, h('div', { className: 'viewer', role: 'dialog' },
    h('header', {}, h('h2', { textContent: c.label }), ...teamBtns, close), stage, vstatus));
  document.body.append(layer);

  const renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.append(renderer.domElement);
  const resize = () => { renderer.setSize(stage.clientWidth, stage.clientHeight, false); camera.aspect = stage.clientWidth / stage.clientHeight; camera.updateProjectionMatrix(); };
  const scene = new T.Scene();
  scene.background = new T.Color(0x0c150e);
  scene.add(new T.HemisphereLight(0xffffff, 0x334433, 2), new T.GridHelper(4, 8, 0x3c5440, 0x24362a));
  const sun = new T.DirectionalLight(0xffffff, 2.5);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const camera = new T.PerspectiveCamera(35, 4 / 3, kind === 'stadium' ? 0.5 : 0.05, kind === 'stadium' ? 2000 : 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.autoRotate = true;
  controls.enableDamping = true;
  resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

  const loader = new GLTFLoader();
  let model: import('three').Object3D | null = null;
  let token = 0;
  async function load(i: number) {
    const my = ++token;
    teamBtns.forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)));
    vstatus.textContent = `Loading ${c.models[i].name}…`;
    try {
      const gltf = await loader.loadAsync(c.models[i].url);
      if (my !== token) return;
      if (model) scene.remove(model);
      model = gltf.scene;
      scene.add(model);
      const box = new T.Box3().setFromObject(model);
      const size = box.getSize(new T.Vector3());
      const mid = box.getCenter(new T.Vector3());
      if (kind === 'stadium') {
        // the model's ground plane is huge: frame the playing area (about 60 x 120 m round the origin) instead
        scene.background = new T.Color(0x9cc3e4);
        controls.target.set(0, 4, 0);
        camera.position.set(-85, 70, -135);
        controls.autoRotate = false;
        const turf = new T.Mesh(new T.PlaneGeometry(48.77, 109.73), new T.MeshBasicMaterial({ color: 0x2f6b33 })); // stand-in for the game's field
        turf.rotation.x = -Math.PI / 2;
        turf.position.y = 0.02;
        scene.add(turf);
        vstatus.textContent = `${c.models[i].name}.glb · drag to orbit, scroll to zoom`;
        return;
      }
      controls.target.copy(mid);
      camera.position.set(mid.x, mid.y + size.y * 0.15, mid.z + Math.max(size.x, size.y, size.z) * 2.6);
      vstatus.textContent = `${c.models[i].name}.glb · ${size.y.toFixed(2)} m tall · drag to orbit, scroll to zoom`;
    } catch (e) {
      vstatus.textContent = `Could not load ${c.models[i].name}.glb: ${e}`;
    }
  }
  function shut() {
    renderer.setAnimationLoop(null);
    controls.dispose();
    scene.traverse((o) => {
      const m = o as import('three').Mesh;
      m.geometry?.dispose();
      for (const mat of [m.material ?? []].flat()) mat.dispose();
    });
    renderer.dispose();
    layer.remove();
    removeEventListener('keydown', esc);
    removeEventListener('resize', resize);
  }
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') shut(); };
  addEventListener('keydown', esc);
  addEventListener('resize', resize);
  close.addEventListener('click', shut);
  layer.addEventListener('click', (e) => { if (e.target === layer) shut(); });
  close.focus();
  load(0);
}

// ---- shared ----
function refresh() {
  let total = 0;
  for (const r of rows) {
    const on = (picks.sounds[r.cat.id] ?? []).includes(r.v.id);
    r.heart.setAttribute('aria-pressed', String(on));
    r.heart.textContent = on ? '♥' : '♡';
  }
  for (const [id, ui] of catUi) {
    const n = picks.sounds[id]?.length ?? 0;
    total += n;
    ui.picked.textContent = n ? `${n} picked` : 'none picked';
    ui.picked.classList.toggle('some', n > 0);
    const v = picks.volumes[id] ?? 1;
    ui.vol.value = String(v);
    ui.out.value = v.toFixed(2);
  }
  $('#soundCount').textContent = `${total} picked`;
  const ch = lib.characters.find((c) => c.id === picks.character);
  $('#charName').textContent = ch ? ch.label : picks.character ?? 'none';
  for (const card of document.querySelectorAll<HTMLElement>('#cards .card')) {
    const on = card.dataset.style === picks.character;
    card.classList.toggle('chosen', on);
    card.querySelector<HTMLInputElement>('input[type=radio]')!.checked = on;
  }
  const st = lib.stadiums?.find((c) => c.id === picks.stadium);
  $('#stadiumName').textContent = st ? st.label : picks.stadium ?? 'none';
  for (const card of document.querySelectorAll<HTMLElement>('#stadiumCards .card')) {
    const on = card.dataset.stadium === picks.stadium;
    card.classList.toggle('chosen', on);
    card.querySelector<HTMLInputElement>('input[type=radio]')!.checked = on;
  }
  const notes = $<HTMLTextAreaElement>('#notes');
  if (notes.value !== picks.notes) notes.value = picks.notes;
}

async function save() {
  const r = await fetch('/api/picks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(picks) });
  const res = await r.json() as { ok: boolean; path?: string; errors?: string[] };
  if (!res.ok) return status(`Not saved: ${res.errors?.join('; ')}`, 'err');
  savedJson = JSON.stringify(picks);
  status(`Saved to ${res.path}. Tell Claude your picks are ready.`);
}

function download() {
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(picks, null, 2) + '\n'], { type: 'application/json' })), download: 'zane-stick-picks.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importFile(file: File) {
  let v: ReturnType<typeof validate>;
  try { v = validate(JSON.parse(await file.text())); } catch (e) { return status(`Import failed: ${e}`, 'err'); }
  if (!v.ok) return status(`Import failed: ${v.errors.join('; ')}`, 'err');
  picks = v.picks;
  changed();
  status(`Imported ${file.name}. Press Save to project to keep it.`, 'warn');
}

function showTab(name: string) {
  for (const b of document.querySelectorAll<HTMLElement>('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  $('#sounds').hidden = name !== 'sounds';
  $('#characters').hidden = name !== 'characters';
  $('#stadiums').hidden = name !== 'stadiums';
  if (name === 'stadiums' && !stadiumsShown) { stadiumsShown = true; renderCards('stadium'); refresh(); } // the renders load only when asked for
}

async function start() {
  const [libRes, savedRes] = await Promise.all([fetch('/api/library'), fetch('/api/picks')]);
  lib = await libRes.json();
  const saved = validate(await savedRes.json());
  if (saved.ok) savedJson = JSON.stringify(saved.picks);
  let local: ReturnType<typeof validate> | null = null;
  try { const s = localStorage.getItem(STORE); if (s) local = validate(JSON.parse(s)); } catch { /* ignore bad or blocked storage */ }
  // the autosave holds the latest work in this browser; the project file is the fallback
  picks = local?.ok ? local.picks : saved.ok ? saved.picks : emptyPicks();

  renderSounds();
  renderCharacters();
  refresh();
  status(JSON.stringify(picks) === savedJson ? `Loaded ${lib.picksPath}` : savedJson ? 'Unsaved changes' : `Nothing saved yet (will save to ${lib.picksPath})`, JSON.stringify(picks) === savedJson ? '' : 'warn');

  for (const b of document.querySelectorAll<HTMLElement>('[role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab!));
  $('#save').addEventListener('click', () => { save().catch((e) => status(`Not saved: ${e}`, 'err')); });
  $('#download').addEventListener('click', download);
  const input = $<HTMLInputElement>('#importFile');
  $('#import').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files?.[0]) importFile(input.files[0]); input.value = ''; });
  $<HTMLTextAreaElement>('#notes').addEventListener('input', (e) => { picks.notes = (e.target as HTMLTextAreaElement).value; changed(); });
}

start().catch((e) => status(`Could not load the library: ${e}`, 'err'));
