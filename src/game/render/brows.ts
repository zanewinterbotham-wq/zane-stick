// Eyebrows: two small 3D bars on the face (one draw call, ~60 triangles) that tilt with the athlete's mood. The mood
// comes from the game's own data (game/expressions.ts); this file only draws it and smooths it.
import * as THREE from 'three';
import { faceMaterial, type Anchor } from './mouth';

/** Mood weights, each 0..1: angry (inner ends down, a frown) and sad/hurt (inner ends up, outer ends down). */
export interface Expression { angry: number; sad: number }
export const NEUTRAL: Expression = { angry: 0, sad: 0 };

/** Moods ease in and out over about a quarter of a second. */
const EASE = 0.1;

export class ExpressionDriver {
  target: Expression = { angry: 0, sad: 0 };
  pose: Expression = { angry: 0, sad: 0 };
  /** Test and screenshot hook: hold this expression, bypassing the smoothing. */
  force: Expression | null = null;
  update(dt: number): Expression {
    if (this.force) return (this.pose = { ...this.force });
    const k = 1 - Math.exp(-Math.min(dt, 0.1) / EASE);
    this.pose.angry += (this.target.angry - this.pose.angry) * k;
    this.pose.sad += (this.target.sad - this.pose.sad) * k;
    return this.pose;
  }
}

/** Where a brow sits and how it is built, in the head-segment frame (metres, reference athlete). */
export interface BrowStyle {
  /** centre offset to each side, height, half length, thickness across the bar, height off the face */ x: number; y: number; hw: number; th: number; depth: number;
  /** the head material the brows are fitted to */ mat: string;
  /** centreline points, snap grid (m, 0 = smooth), lump amount */ k: number; snap: number; lump: number;
  /** cross-section: [across × th, height × depth] */ profile: [number, number][];
  look: 'lit' | 'toon' | 'unlit' | 'facet'; roughness: number; color: number;
}
const ROUNDED: [number, number][] = [[-0.5, 0.15], [-0.25, 1], [0.25, 1], [0.5, 0.15]];
const SQUARE: [number, number][] = [[-0.5, 0.1], [-0.5, 1], [0.5, 1], [0.5, 0.1]];
export const BROW_STYLES: Record<string, BrowStyle> = {
  rubberhose: { x: 0.056, y: 0.232, hw: 0.05, th: 0.02, depth: 0.012, mat: 'eye', k: 6, snap: 0, lump: 0, profile: ROUNDED, look: 'toon', roughness: 1, color: 0x14100e },
  toon: { x: 0.05, y: 0.197, hw: 0.044, th: 0.016, depth: 0.01, mat: 'eye', k: 6, snap: 0, lump: 0, profile: ROUNDED, look: 'toon', roughness: 1, color: 0x1a1210 },
  vinyl: { x: 0.056, y: 0.218, hw: 0.044, th: 0.018, depth: 0.014, mat: 'eye', k: 6, snap: 0, lump: 0, profile: ROUNDED, look: 'lit', roughness: 0.25, color: 0x2a1c16 },
  lowpoly: { x: 0.05, y: 0.17, hw: 0.04, th: 0.016, depth: 0.01, mat: 'skin', k: 3, snap: 0, lump: 0, profile: ROUNDED, look: 'facet', roughness: 0.6, color: 0x2a1c16 },
  voxel: { x: 0.05, y: 0.182, hw: 0.038, th: 0.014, depth: 0.012, mat: 'skin', k: 4, snap: 0.014, lump: 0, profile: SQUARE, look: 'lit', roughness: 0.9, color: 0x241812 },
  clay: { x: 0.05, y: 0.192, hw: 0.042, th: 0.02, depth: 0.014, mat: 'eye', k: 6, snap: 0, lump: 0.25, profile: ROUNDED, look: 'lit', roughness: 1, color: 0x3a2418 },
  paper: { x: 0.05, y: 0.196, hw: 0.044, th: 0.016, depth: 0.004, mat: 'eye', k: 4, snap: 0, lump: 0, profile: SQUARE, look: 'unlit', roughness: 1, color: 0x1a1210 },
  // no eyes under the visor: lit slashes on its glass carry the mood like a display (colour replaced by the team glow)
  future: { x: 0.06, y: 0.14, hw: 0.045, th: 0.012, depth: 0.004, mat: 'visor', k: 4, snap: 0, lump: 0, profile: SQUARE, look: 'unlit', roughness: 1, color: 0x6bdaff },
  classic: { x: 0.04, y: 0, hw: 0.03, th: 0.012, depth: 0.007, mat: 'helmet', k: 4, snap: 0, lump: 0, profile: ROUNDED, look: 'lit', roughness: 0.8, color: 0x161616 },
};

export class Brows {
  readonly mesh: THREE.Mesh;
  readonly driver = new ExpressionDriver();
  private pos: Float32Array;
  private last = '';

  /** `anchors`: left and right brow. `glow`: the team's light colour, for the Future skin. */
  constructor(private s: BrowStyle, private anchors: [Anchor, Anchor], glow = 0x6bdaff) {
    const K = s.k, P = s.profile.length, per = K * P, idx: number[] = [];
    this.pos = new Float32Array(3 * 2 * per);
    for (let b = 0; b < 2; b++) {
      const o = b * per;
      for (let k = 0; k < K - 1; k++) for (let p = 0; p < P - 1; p++) {
        const a = o + k * P + p, c = o + (k + 1) * P + p;
        idx.push(a, c, c + 1, a, c + 1, a + 1);
      }
      for (const end of [0, K - 1]) { const e = o + end * P; for (let p = 1; p < P - 1; p++) idx.push(e, e + p, e + p + 1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, faceMaterial(s.look, s.roughness, { color: s.mat === 'visor' ? glow : s.color }));
    this.mesh.frustumCulled = false;
    this.build(NEUTRAL);
  }

  update(dt: number) {
    const e = this.driver.update(dt), key = e.angry.toFixed(3) + ',' + e.sad.toFixed(3);
    if (key !== this.last) { this.last = key; this.build(e); }
  }

  dispose() { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }

  private build({ angry, sad }: Expression) {
    const { s, pos } = this, K = s.k, P = s.profile.length, hw = s.hw, v = new THREE.Vector3();
    const snap = (x: number) => (s.snap ? Math.round(x / s.snap) * s.snap : x);
    // inner end down and in for angry; inner end up and outer end down for sad; a calm brow arches a little
    const inner = hw * (0.5 * sad - 0.8 * angry), outer = hw * (-0.3 * sad + 0.25 * angry), arch = hw * 0.22 * (1 - 0.85 * angry), pull = 0.3 * hw * angry;
    for (let b = 0; b < 2; b++) {
      const side = b ? 1 : -1, an = this.anchors[b], cu: number[] = [], cv: number[] = [];
      for (let k = 0; k < K; k++) {
        const t = k / (K - 1);
        cu.push(snap(side * (hw * (2 * t - 1) - pull * (1 - t))));
        cv.push(snap(inner + (outer - inner) * t + arch * 4 * t * (1 - t)));
      }
      for (let k = 0; k < K; k++) {
        const k0 = Math.max(0, k - 1), k1 = Math.min(K - 1, k + 1);
        let tx = cu[k1] - cu[k0], ty = cv[k1] - cv[k0];
        const len = Math.hypot(tx, ty) || 1;
        // stepped bars (voxel) keep their thickness vertical; others are thick across the bar
        [tx, ty] = s.snap ? [1, 0] : [tx / len, ty / len];
        const th = s.th * (1 + s.lump * Math.sin(2.7 * k + 1.1 * b));
        for (let p = 0; p < P; p++) {
          const [a, h] = s.profile[p], u = cu[k] - ty * a * th, w = cv[k] + tx * a * th;
          v.set(u, w, h * s.depth - an.kx * u * u - an.ky * w * w).applyQuaternion(an.quat).add(an.pos);
          pos.set([v.x, v.y, v.z], 3 * (b * K * P + k * P + p));
        }
      }
    }
    (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    if (s.look === 'lit' || s.look === 'toon') this.mesh.geometry.computeVertexNormals();
  }
}
