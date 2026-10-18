// Mouths: a small 3D mesh on every athlete's face (one draw call, ~150 triangles) whose lips, jaw, teeth and tongue
// follow the athlete's own voice sounds. Presentation only: the shapes come from the sound category and the opening
// from the sound's amplitude envelope (audio.ts), never from the sim.
import * as THREE from 'three';
import type { SkinTemplate } from './skin';

export type Shape = 'closed' | 'grunt' | 'scream' | 'moan' | 'exhale';

/** The mouth outline and contents, in units of the mouth's half width `hw`. */
export interface MouthPose {
  /** half width factor */ w: number;
  /** opening height factor (0 = lips together) */ h: number;
  /** corner lift (+) or droop (-) */ curve: number;
  /** contour exponent: 2 oval, higher boxier */ n: number;
  /** teeth rows, fraction of the opening each row fills (0..0.46) */ teeth: number;
  /** tongue size (0..1) */ tongue: number;
}

/** Fully voiced mouth for each sound: grunt slightly open, scream wide, moan/groan a grimace of bared teeth, exhale an O. */
export const SHAPES: Record<Shape, MouthPose> = {
  closed: { w: 1, h: 0, curve: 0.05, n: 2, teeth: 0, tongue: 0 },
  grunt: { w: 0.95, h: 0.3, curve: -0.04, n: 2.2, teeth: 0.3, tongue: 0 },
  scream: { w: 1.1, h: 1.0, curve: 0.1, n: 2.5, teeth: 0.28, tongue: 1 },
  moan: { w: 1.3, h: 0.42, curve: -0.3, n: 3.2, teeth: 0.46, tongue: 0 },
  exhale: { w: 0.5, h: 0.6, curve: 0, n: 2, teeth: 0, tongue: 0 },
};

/** Which shape each voice category makes; categories not listed are not voices. */
export const CATEGORY_SHAPE: Record<string, Shape> = { voice_grunt: 'grunt', voice_exhale: 'exhale', pain_scream: 'scream', pain_moan: 'moan' };
export const shapeOf = (cat: string): Shape | null => CATEGORY_SHAPE[cat] ?? null;
/** Pain sounds leave the face in a grimace for a moment after they end. */
const PAIN: ReadonlySet<Shape> = new Set<Shape>(['scream', 'moan']);

/** RMS loudness of a sound in windows of 1/hz s, scaled so the loudest window is 1. */
export function envelope(data: ArrayLike<number>, sampleRate: number, hz = 60): Float32Array {
  const win = Math.max(1, Math.round(sampleRate / hz)), out = new Float32Array(Math.ceil(data.length / win));
  let peak = 1e-9;
  for (let k = 0; k < out.length; k++) {
    let s = 0;
    const end = Math.min(data.length, (k + 1) * win);
    for (let i = k * win; i < end; i++) s += data[i] * data[i];
    out[k] = Math.sqrt(s / (end - k * win));
    if (out[k] > peak) peak = out[k];
  }
  for (let k = 0; k < out.length; k++) out[k] /= peak;
  return out;
}

/** Envelope for a sound that has no decoded buffer (muted, not loaded yet): a few syllables of speech-like swell. */
export function syntheticEnvelope(cat: string, hz = 60): Float32Array {
  const dur = ({ voice_grunt: 0.35, voice_exhale: 0.9, pain_scream: 1.4, pain_moan: 1.6 } as Record<string, number>)[cat] ?? 0.5;
  const f = cat === 'pain_scream' ? 6 : 4;
  return Float32Array.from({ length: Math.ceil(dur * hz) }, (_, i) => {
    const t = i / hz / dur;
    return Math.sin(Math.PI * Math.min(1, t * 1.3)) ** 0.6 * (1 - t * 0.4) * (0.7 + 0.3 * Math.sin(2 * Math.PI * f * i / hz)) ** 2;
  });
}

/** Envelope value (0..1) to how far the mouth opens: a noise gate, then a gentle curve so quiet parts still move it. */
export function openness(e: number): number {
  return e < 0.04 ? 0 : Math.min(1, ((e - 0.04) / 0.96) ** 0.7);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function blend(a: MouthPose, b: MouthPose, t: number): MouthPose {
  return { w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t), curve: lerp(a.curve, b.curve, t), n: lerp(a.n, b.n, t), teeth: lerp(a.teeth, b.teeth, t), tongue: lerp(a.tongue, b.tongue, t) };
}
/** The mouth making `shape` with the voice at `level` (0..1) of its full opening. */
export const poseAt = (shape: Shape, level: number): MouthPose => blend(SHAPES.closed, SHAPES[shape], Math.min(1, Math.max(0, level)));

/** One voice sound as the audio plays it. `rate` is its playback rate; `loud` the event loudness 0..1. */
export interface Voice { athlete: number; cat: string; env: Float32Array; hz: number; rate: number; loud: number }

/** Per-athlete mouth animation state: which voices are sounding, smoothed so it reads as talking, not flicker. */
export class MouthDriver {
  private voices: { v: Voice; shape: Shape; t: number }[] = [];
  private shape: MouthPose = SHAPES.grunt;
  private level = 0;
  private linger = 0;
  /** Test and screenshot hook: hold this shape at this level, bypassing the voices. */
  force: { shape: Shape; level: number } | null = null;
  pose: MouthPose = SHAPES.closed;

  say(v: Voice) {
    const shape = shapeOf(v.cat);
    if (shape && !this.voices.some((x) => x.v.cat === v.cat && x.t < 0.3))this.voices.push({ v, shape, t: 0 });
  }

  update(dt: number): MouthPose {
    dt = Math.min(dt, 0.1);
    if (this.force) return (this.pose = poseAt(this.force.shape, this.force.level));
    let target = 0, shape: Shape | null = null;
    this.voices = this.voices.filter((x) => {
      x.t += dt;
      const pos = x.t * x.v.rate * x.v.hz, i = Math.floor(pos);
      if (i >= x.v.env.length - 1) { if (PAIN.has(x.shape)) this.linger = 0.35; return false; }
      const e = lerp(x.v.env[i], x.v.env[i + 1], pos - i), l = openness(e) * (0.5 + 0.5 * x.v.loud);
      if (l >= target) { target = l; shape = x.shape; }
      return true;
    });
    this.linger = Math.max(0, this.linger - dt * 0.35 / 1.5);
    if (!this.voices.length && this.linger > target) { target = this.linger; shape = 'moan'; }
    // open fast, close a little slower; the mouth keeps the last shape while it closes
    this.level += (target - this.level) * (1 - Math.exp(-dt / (target > this.level ? 0.03 : 0.09)));
    if (shape) this.shape = blend(this.shape, SHAPES[shape], 1 - Math.exp(-dt / 0.06));
    return (this.pose = blend(SHAPES.closed, this.shape, this.level));
  }
}

// ------------------------------------------------------------------ the mesh

/** A skin's mouth: where it sits on the face (head-segment frame, metres, reference athlete) and how it is built. */
interface Style {
  /** height of the mouth centre; half width; lip thickness; lip width (× hw) */ y: number; hw: number; t: number; lipW: number;
  /** the head material the mouth is fitted to */ mat: string;
  /** contour points (even), added contour exponent, snap grid (m, 0 = smooth), lump amount */ segs: number; dn: number; snap: number; lump: number;
  /** lip cross-section from inner to outer edge: [outward offset × lipW, height × t] */ lip: [number, number][];
  /** open height scale */ open: number;
  teeth: boolean; tongue: boolean; look: 'lit' | 'toon' | 'unlit' | 'facet'; roughness: number;
  lipC: number; cavC: number; teethC: number; tongueC: number;
}
const ROUND: [number, number][] = [[0, 0.3], [0.5, 1], [1, 0.2]];
const FLAT: [number, number][] = [[0, 0.3], [0, 1], [1, 1], [1, 0.3]];
const CARTOON = { segs: 20, dn: 0, snap: 0, lump: 0, lip: ROUND, open: 1, teeth: true, tongue: true };
export const STYLES: Record<string, Style> = {
  // 1930s cartoon: inked lips, black mouth, big white teeth, red tongue
  rubberhose: { ...CARTOON, y: -0.01, hw: 0.062, t: 0.012, lipW: 0.26, mat: 'skin', look: 'toon', roughness: 1, lipC: 0x14100e, cavC: 0x1c0a0a, teethC: 0xfff8e8, tongueC: 0xd2455a },
  toon: { ...CARTOON, y: -0.012, hw: 0.056, t: 0.011, lipW: 0.3, mat: 'skin', look: 'toon', roughness: 1, lipC: 0x7a2a2a, cavC: 0x2a0d12, teethC: 0xffffff, tongueC: 0xe0607a },
  vinyl: { ...CARTOON, y: -0.012, hw: 0.062, t: 0.014, lipW: 0.34, mat: 'skin', look: 'lit', roughness: 0.25, lipC: 0xc2453f, cavC: 0x2a0d0d, teethC: 0xf6f3ea, tongueC: 0xe8707e },
  lowpoly: { y: -0.005, hw: 0.045, t: 0.01, lipW: 0.3, mat: 'skin', segs: 8, dn: 0, snap: 0, lump: 0, lip: [[0, 0.3], [0.5, 1], [1, 0.2]], open: 1, teeth: true, tongue: false, look: 'facet', roughness: 0.6, lipC: 0xa04a3c, cavC: 0x24100e, teethC: 0xf0ece0, tongueC: 0xd9606c },
  // blocky: a pixel grid, hard steps
  voxel: { y: 0.055, hw: 0.056, t: 0.012, lipW: 0.22, mat: 'skin', segs: 16, dn: 6, snap: 0.014, lump: 0, lip: FLAT, open: 1, teeth: true, tongue: true, look: 'lit', roughness: 0.9, lipC: 0x7a2d2d, cavC: 0x1a0e0e, teethC: 0xf2f2f2, tongueC: 0xd2506a },
  clay: { y: -0.011, hw: 0.052, t: 0.016, lipW: 0.36, mat: 'skin', segs: 18, dn: 0, snap: 0, lump: 0.2, lip: ROUND, open: 1, teeth: true, tongue: false, look: 'lit', roughness: 1, lipC: 0xb86a5a, cavC: 0x2a1410, teethC: 0xe8e0cc, tongueC: 0xc85a64 },
  // cut-out cards stacked a few millimetres apart
  paper: { y: -0.01, hw: 0.055, t: 0.004, lipW: 0.26, mat: 'skin', segs: 12, dn: 0, snap: 0, lump: 0, lip: [[0, 0.5], [0, 1], [1, 1], [1, 0.5]], open: 1, teeth: true, tongue: true, look: 'unlit', roughness: 1, lipC: 0xb23a3a, cavC: 0x2b1111, teethC: 0xfffdf4, tongueC: 0xe7788a },
  // no face under the visor: a lit slot on the chin guard opens like an equaliser (cavC is replaced by the team glow)
  future: { y: -0.01, hw: 0.05, t: 0.006, lipW: 0.16, mat: 'mask', segs: 16, dn: 3, snap: 0, lump: 0, lip: FLAT, open: 0.5, teeth: false, tongue: false, look: 'unlit', roughness: 1, lipC: 0x1b2330, cavC: 0x6bdaff, teethC: 0xffffff, tongueC: 0xffffff },
  classic: { y: 0, hw: 0.038, t: 0.008, lipW: 0.3, mat: 'helmet', segs: 14, dn: 0, snap: 0, lump: 0, lip: ROUND, open: 1, teeth: true, tongue: false, look: 'lit', roughness: 0.8, lipC: 0x4a1f1f, cavC: 0x140808, teethC: 0xf2f2f2, tongueC: 0xc85a64 },
};

/** Where a mouth sits on a surface: position, tilt to the surface normal, and the surface's bend (z drop per m² in x and y). */
export interface Anchor { pos: THREE.Vector3; quat: THREE.Quaternion; kx: number; ky: number }

const ray = new THREE.Raycaster();
const probeMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const anchors = new WeakMap<SkinTemplate, Map<string, Anchor>>();
/** Fit a face feature of half width `hw` at (x, y) to the head mesh of material `mat` by shooting rays at it, so it
 *  sits on the surface, tilted and curved like it. */
export function fitAnchor(tpl: SkinTemplate, mat: string, x: number, y: number, hw: number): Anchor {
  const key = `${mat},${x},${y},${hw}`;
  let cache = anchors.get(tpl);
  if (!cache) anchors.set(tpl, cache = new Map());
  let a = cache.get(key);
  if (a) return a;
  const targets = (tpl.parts.get('head') ?? []).filter((m) => (m.material as THREE.Material).name === mat).map((m) => new THREE.Mesh(m.geometry, probeMat));
  const z = (px: number, py: number) => {
    ray.set(new THREE.Vector3(px, py, 1), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObjects(targets, false)[0];
    return hit ? hit.point.z : null;
  };
  const d = 0.03, z0 = z(x, y) ?? 0.2, zu = z(x, y + d) ?? z0, zd = z(x, y - d) ?? z0, zl = z(x - hw, y) ?? z0, zr = z(x + hw, y) ?? z0;
  const sy = (zu - zd) / (2 * d), sx = (zr - zl) / (2 * hw), kx = Math.max(0, (z0 - (zl + zr) / 2) / (hw * hw)), ky = Math.max(0, (2 * z0 - zu - zd) / (2 * d * d));
  // a faceted face is not a smooth bend: lift the feature until it clears the surface everywhere it will reach
  let lift = 0.002;
  for (const fx of [-1, -0.5, 0.5, 1]) for (const dy of [-0.04, -0.02, 0.02, 0.03]) {
    const zs = z(x + fx * hw, y + dy);
    if (zs !== null) lift = Math.max(lift, zs - (z0 + sx * fx * hw + sy * dy - kx * (fx * hw) ** 2 - ky * dy * dy) + 0.002);
  }
  a = {
    pos: new THREE.Vector3(x, y, z0 + lift),
    quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(-sx, -sy, 1).normalize()),
    kx, ky,
  };
  cache.set(key, a);
  return a;
}
export const skinAnchor = (tpl: SkinTemplate, s: Style) => fitAnchor(tpl, s.mat, 0, s.y, s.hw);

/** A feature on a sphere (the Classic helmet): `c` its centre, `r` radius, `dy` and `dx` the offset below and beside the centre. */
export function sphereAnchor(c: ArrayLike<number>, r: number, dy: number, dx = 0): Anchor {
  const z = Math.sqrt(r * r - dy * dy - dx * dx);
  return { pos: new THREE.Vector3(c[0] + dx, c[1] + dy, c[2] + z + 0.001), quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dx, dy, z).normalize()), kx: 1 / (2 * z), ky: 1 / (2 * r) };
}

/** Face-feature material for a skin look: lit, cel-shaded, unlit (paper, LEDs) or flat-faceted. */
export function faceMaterial(look: Style['look'], roughness: number, extra: THREE.MeshStandardMaterialParameters = {}): THREE.Material {
  const opts = { side: THREE.DoubleSide, ...extra };
  return look === 'unlit' ? new THREE.MeshBasicMaterial(opts) : look === 'toon' ? new THREE.MeshToonMaterial(opts)
    : new THREE.MeshStandardMaterial({ ...opts, roughness, metalness: 0, flatShading: look === 'facet' });
}

const UP = 0.35; // share of the opening that is the upper lip's: the jaw (lower lip) does most of the moving
const sgnpow = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e;

export class Mouth {
  readonly mesh: THREE.Mesh;
  readonly driver = new MouthDriver();
  private pos: Float32Array;
  private N: number; private P: number;
  private last = '';

  /** `glow`: the team's light colour, for the Future skin's slot. */
  constructor(private s: Style, anchor: Anchor, glow = 0x6bdaff) {
    const N = this.N = s.segs, P = this.P = s.lip.length, M = N / 2;
    // vertex layout: cavity N+1 | lip rings P·N | upper teeth 2(M+1) | lower teeth 2(M+1) | tongue 1+T
    const T = 10, nCav = N + 1, nRing = P * N, nTeeth = 2 * (M + 1), nTongue = T + 1, total = nCav + nRing + 2 * nTeeth + nTongue;
    this.pos = new Float32Array(3 * total);
    const col = new Float32Array(3 * total), idx: number[] = [], c = new THREE.Color();
    const paint = (from: number, n: number, hex: number) => { c.setHex(hex); for (let i = from; i < from + n; i++) col.set([c.r, c.g, c.b], 3 * i); };
    const oRing = nCav, oUp = oRing + nRing, oLow = oUp + nTeeth, oTongue = oLow + nTeeth;
    paint(0, nCav, s.look === 'unlit' && s.mat === 'mask' ? glow : s.cavC);
    paint(oRing, nRing, s.lipC); paint(oUp, nTeeth, s.teethC); paint(oLow, nTeeth, s.teethC); paint(oTongue, nTongue, s.tongueC);
    for (let i = 0; i < N; i++) idx.push(N, i, (i + 1) % N);
    for (let k = 0; k < P - 1; k++) for (let i = 0; i < N; i++) {
      const a = oRing + k * N + i, b = oRing + k * N + (i + 1) % N, cc = oRing + (k + 1) * N + (i + 1) % N, d = oRing + (k + 1) * N + i;
      idx.push(a, cc, b, a, d, cc);
    }
    for (const o of [oUp, oLow]) for (let j = 0; j < M; j++) { const a = o + 2 * j; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    for (let i = 0; i < T; i++) idx.push(oTongue, oTongue + 1 + i, oTongue + 1 + (i + 1) % T);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, faceMaterial(s.look, s.roughness, { vertexColors: true }));
    this.mesh.frustumCulled = false;
    this.mesh.position.copy(anchor.pos); this.mesh.quaternion.copy(anchor.quat);
    this.anchor = anchor;
    this.build(SHAPES.closed);
  }
  private anchor: Anchor;

  update(dt: number) {
    const p = this.driver.update(dt), key = [p.w, p.h, p.curve, p.n, p.teeth, p.tongue].map((v) => v.toFixed(3)).join();
    if (key !== this.last) { this.last = key; this.build(p); }
  }

  dispose() { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }

  /** Rewrite the vertex positions for a pose. */
  private build(pose: MouthPose) {
    const { s, N, P, pos } = this, M = N / 2, T = 10, hw = s.hw, t = s.t;
    const snap = (v: number) => (s.snap ? Math.round(v / s.snap) * s.snap : v);
    const e = 2 / (pose.n + s.dn), a = pose.w * hw, hh = pose.h * hw * s.open;
    const px = new Float64Array(N), py = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const th = (2 * Math.PI * i) / N, cs = Math.cos(th), sn = Math.sin(th);
      const x = a * sgnpow(cs, e);
      px[i] = snap(x);
      py[i] = snap((sn >= 0 ? UP : -(1 - UP)) * hh * sgnpow(Math.abs(sn), e) + pose.curve * hw * (x / a) ** 2);
    }
    const { kx, ky } = this.anchor;
    const set = (v: number, x: number, y: number, z: number) => { pos[3 * v] = x; pos[3 * v + 1] = y; pos[3 * v + 2] = z - kx * x * x - ky * y * y; };
    const oRing = N + 1, oUp = oRing + P * N, oLow = oUp + 2 * (M + 1), oTongue = oLow + 2 * (M + 1);
    // cavity: a fan from the contour's centre
    let cy = 0;
    for (let i = 0; i < N; i++) cy += py[i] / N;
    for (let i = 0; i < N; i++) set(i, px[i], py[i], 0.05 * t);
    set(N, 0, cy, 0.05 * t);
    // lips: rings offset along the contour's outward normal
    for (let i = 0; i < N; i++) {
      const th = (2 * Math.PI * i) / N, i0 = (i + N - 1) % N, i1 = (i + 1) % N;
      let nx = py[i1] - py[i0], ny = -(px[i1] - px[i0]);
      const len = Math.hypot(nx, ny);
      if (len < 1e-6) { nx = Math.cos(th); ny = Math.sin(th); } else { nx /= len; ny /= len; }
      const lump = 1 + s.lump * Math.sin(5 * th + 1.3 * (i % 3));
      for (let k = 0; k < P; k++) {
        const [dr, dz] = s.lip[k], d = dr * s.lipW * hw * lump;
        set(oRing + k * N + i, snap(px[i] + nx * d), snap(py[i] + ny * d), dz * t * (k && s.lump ? lump : 1));
      }
    }
    // teeth: a strip hanging from the upper contour and one rising from the lower, never more than their share of the gap there
    for (let j = 0; j <= M; j++) {
      const up = j, low = (N - j) % N, gap = py[up] - py[low];
      const th = Math.max(0, Math.min(pose.teeth * hh, 0.46 * gap));
      const show = s.teeth && gap > 0.002;
      set(oUp + 2 * j, px[up], py[up], 0.4 * t);
      set(oUp + 2 * j + 1, px[up], py[up] - (show ? th : 0), 0.4 * t);
      set(oLow + 2 * j, px[low], py[low], 0.4 * t);
      set(oLow + 2 * j + 1, px[low], py[low] + (show ? th : 0), 0.4 * t);
    }
    // tongue: an oval resting on the floor of the mouth, only once there is room
    const bottom = py[3 * N / 4 | 0], room = py[N / 4 | 0] - bottom, size = s.tongue ? pose.tongue * Math.min(1, Math.max(0, (room - 0.02 * hw) / (0.5 * hw))) : 0;
    const rx = 0.42 * a * size, ry = 0.4 * room * size;
    set(oTongue, 0, bottom + 0.65 * ry, 0.2 * t);
    for (let i = 0; i < T; i++) { const th = (2 * Math.PI * i) / T; set(oTongue + 1 + i, rx * Math.cos(th), bottom + 0.65 * ry + ry * Math.sin(th), 0.2 * t); }
    const attr = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    if (this.s.look !== 'unlit' && this.s.look !== 'facet') this.mesh.geometry.computeVertexNormals();
  }
}
