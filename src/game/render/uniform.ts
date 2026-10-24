// Uniform details (presentation only): numbers and names on the jerseys, a team mark on the helmets, and grass stains
// that build up on jerseys and pants over a session. Textures are drawn on canvases once per look and shared; the
// decals share one plane and their materials, so nothing here needs disposing per athlete.
import * as THREE from 'three';

/** Invented surnames and numbers, handed out by an athlete's place on his team (no real names or marks). */
const NAMES: string[][] = [
  ['ORTEGA', 'WHITFIELD', 'NAKAMURA', 'BOYD', 'CASTELLAN', 'DUMONT', 'ELLERY', 'FINCH', 'GARRITY', 'HOLLIS', 'IDRIS', 'JARROW'],
  ['KESSLER', 'LUND', 'MARSH', 'NOVAK', 'OKAFOR', 'PRUITT', 'QUILL', 'REYES', 'SATO', 'TRAN', 'UNDERHILL', 'VANCE'],
];
const NUMBERS = [12, 24, 33, 7, 55, 81, 90, 21, 44, 3, 68, 17];
/** One letter on each team's helmet. */
const MARKS = ['G', 'F'];

export interface Ident { name: string; number: number; mark: string }
/** The `rank`-th athlete (0-based) of `team`. */
export function identFor(team: 0 | 1, rank: number): Ident {
  const i = ((rank % NUMBERS.length) + NUMBERS.length) % NUMBERS.length;
  return { name: NAMES[team][i], number: NUMBERS[i], mark: MARKS[team] };
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
export interface Palette { jersey: number; trim: number }

const textures = new Map<string, THREE.CanvasTexture>();
const materials = new Map<string, THREE.MeshStandardMaterial>();
export const decalGeometry = new THREE.PlaneGeometry(1, 1);
decalGeometry.userData.shared = true;

function canvasTexture(key: string, size: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  let t = textures.get(key);
  if (!t) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d')!);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    textures.set(key, t);
  }
  return t;
}

/** A material that is shared and never disposed (it carries `userData.shared`, which disposeTree skips). */
function decalMaterial(key: string, map: THREE.Texture): THREE.MeshStandardMaterial {
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.userData.shared = true;
    materials.set(key, m);
  }
  return m;
}

/** The jersey's back (name over number) or chest (number only). */
export function jerseyMaterial(id: Ident, p: Palette, side: 'back' | 'front'): THREE.MeshStandardMaterial {
  const key = `${side}:${id.number}:${side === 'back' ? id.name : ''}:${p.trim}`;
  const tex = canvasTexture(key, 256, (g) => {
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = hex(p.trim);
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineJoin = 'round';
    const put = (text: string, y: number, px: number) => {
      g.font = `bold ${px}px system-ui, sans-serif`; g.lineWidth = Math.max(3, px / 14);
      g.strokeText(text, 128, y); g.fillText(text, 128, y);
    };
    if (side === 'back') {
      put(id.name, 46, id.name.length > 7 ? 38 : 46);
      put(String(id.number), 158, id.number > 9 ? 150 : 170);
    } else put(String(id.number), 128, id.number > 9 ? 150 : 170);
  });
  return decalMaterial(key, tex);
}

/** The helmet's side mark: a ring in the trim colour round the team's letter. */
export function helmetMaterial(id: Ident, p: Palette): THREE.MeshStandardMaterial {
  const key = `helmet:${id.mark}:${p.trim}:${p.jersey}`;
  const tex = canvasTexture(key, 128, (g) => {
    g.fillStyle = hex(p.trim);
    g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
    g.fillStyle = hex(p.jersey);
    g.beginPath(); g.arc(64, 64, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = hex(p.trim); g.font = 'bold 66px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(id.mark, 64, 68);
  });
  return decalMaterial(key, tex);
}

/** Grass stains: the colour jerseys and pants fade toward, and how far at most (share of the way). */
export const STAIN_COLOR = new THREE.Color(0x4b6b22);
export const STAIN_MAX = 0.55;
/** Stain gained per second an athlete spends down on the turf, and per metre he slides on it. */
const STAIN_PER_S = 0.012, STAIN_PER_M = 0.02;

/** Stain levels (0..1) by athlete slot `team:rank`, kept for the page's session: a jersey that has been dragged
 *  through the grass stays green into the next rep. */
const stains = new Map<string, number>();
export const stainKey = (team: number, rank: number) => `${team}:${rank}`;
export const stainOf = (key: string) => stains.get(key) ?? 0;
/** Add wear to a slot for `dt` seconds down and `slide` metres slid; returns the new level. */
export function addStain(key: string, dt: number, slide: number): number {
  const v = Math.min(1, stainOf(key) + dt * STAIN_PER_S + slide * STAIN_PER_M);
  stains.set(key, v);
  return v;
}
export const clearStains = () => stains.clear();

export interface Spot { pos: [number, number, number]; size: number }
export interface SkinSpots { back?: Spot; front?: Spot; headL?: Spot; headR?: Spot }

const ray = new THREE.Raycaster();
const spotCache = new WeakMap<THREE.Mesh[], SkinSpots>();

/** Where a skin's torso and head surfaces are, found by shooting rays at the skin's own meshes (skins differ a lot in
 *  shape): the decals sit 4 mm off the surface. `kind`: the skin node ('thorax' or 'head'). Meshes are in the rest
 *  frame about the segment origin, as skin.ts has them. */
export function skinSpots(kind: 'thorax' | 'head', meshes: THREE.Mesh[]): SkinSpots {
  let s = spotCache.get(meshes);
  if (s) return s;
  s = {};
  const solid = meshes.filter((m) => (m.material as THREE.Material).name !== 'ink').map((m) => new THREE.Mesh(m.geometry, m.material));
  const box = new THREE.Box3();
  for (const m of solid) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!); }
  const hit = (o: THREE.Vector3, d: THREE.Vector3) => { ray.set(o, d); ray.far = 6; return ray.intersectObjects(solid, false)[0]?.point ?? null; };
  if (!box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    if (kind === 'thorax') {
      const size = Math.min(0.42, 0.7 * sz.x);
      const b = hit(new THREE.Vector3(0, c.y, -3), new THREE.Vector3(0, 0, 1)), f = hit(new THREE.Vector3(0, c.y, 3), new THREE.Vector3(0, 0, -1));
      if (b) s.back = { pos: [0, c.y, b.z - 0.004], size };
      if (f) s.front = { pos: [0, c.y, f.z + 0.004], size: size * 0.6 };
    } else {
      const y = box.min.y + 0.55 * sz.y, size = Math.min(0.2, 0.32 * sz.y);
      const l = hit(new THREE.Vector3(3, y, c.z - 0.03), new THREE.Vector3(-1, 0, 0)), r = hit(new THREE.Vector3(-3, y, c.z - 0.03), new THREE.Vector3(1, 0, 0));
      if (l) s.headL = { pos: [l.x + 0.004, y, c.z - 0.03], size };
      if (r) s.headR = { pos: [r.x - 0.004, y, c.z - 0.03], size };
    }
  }
  spotCache.set(meshes, s);
  return s;
}

/** A decal plane at `pos` facing `yaw` (0: +Z, π: -Z, ±π/2: ±X), `size` metres square. */
export function decalMesh(mat: THREE.Material, pos: [number, number, number], yaw: number, size: number): THREE.Mesh {
  const m = new THREE.Mesh(decalGeometry, mat);
  m.position.set(...pos); m.rotation.y = yaw; m.scale.set(size, size, 1);
  m.renderOrder = 2;
  return m;
}
