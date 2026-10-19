// Injury effects (design §6.6): stylised and cheap (two instanced meshes and a few small groups), presentation only.
// A break sprays blood, leaves splats on the turf and a bone poking out at the joint; a knockout bleeds a little
// or, in the comic style, gets stars circling the head. The owner picks the style in the dev picker (Effects tab,
// art/picks.json "effects", exported by sfx:export); the Gore setting turns all of it off.
import * as THREE from 'three';
import type { Quat, Vec3 } from '../../sim/math';
import type { World } from '../../sim/world';
import picks from '../sfx-picks.json';

export interface EffectStyle {
  id: string; label: string; pitch: string;
  /** Particle colours (random per particle), shape, count per break, launch speed (m/s), size (m). */
  colors: number[]; shape: 'drop' | 'blob' | 'cube' | 'star'; count: number; speed: number; size: number;
  /** What a particle leaves on the turf, and its size relative to the particle. */
  decal: 'pool' | 'splat' | 'pixel' | 'none'; decalScale: number;
  /** Bone look ('none': no bone), drips after the break (drops per second, for how long), stars round a knocked-out head. */
  bone: 'real' | 'cartoon' | 'voxel' | 'none'; drip: [number, number]; stars: boolean;
}

export const STYLES: EffectStyle[] = [
  { id: 'realistic', label: 'Realistic', pitch: 'Dark red drops, small pools on the grass, a pale bone shard.',
    colors: [0x4a0606, 0x6b0b0b, 0x821010], shape: 'drop', count: 45, speed: 2.4, size: 0.018, decal: 'pool', decalScale: 2.6, bone: 'real', drip: [5, 3], stars: false },
  { id: 'cartoon', label: 'Cartoon splat', pitch: 'A few big bright blobs, star-shaped splats, a cartoon dog bone.',
    colors: [0xe8202a, 0xff3b3b], shape: 'blob', count: 12, speed: 3.2, size: 0.05, decal: 'splat', decalScale: 2.2, bone: 'cartoon', drip: [2, 2], stars: false },
  { id: 'comic', label: 'Comic stars (no blood)', pitch: 'No blood: a burst of stars, stars circling a knocked-out head.',
    colors: [0xffe14a, 0xffffff, 0xffb02e], shape: 'star', count: 14, speed: 1.8, size: 0.06, decal: 'none', decalScale: 0, bone: 'none', drip: [0, 0], stars: true },
  { id: 'voxel', label: 'Voxel blood', pitch: 'Blocky blood cubes and square pixels on the turf, a blocky bone: matches the voxel skin.',
    colors: [0xb01515, 0x8a0d0d, 0xd02020], shape: 'cube', count: 30, speed: 2.6, size: 0.035, decal: 'pixel', decalScale: 1.8, bone: 'voxel', drip: [4, 2.5], stars: false },
  { id: 'spray', label: 'Over the top', pitch: 'A fountain of bright blood for a second and a half, big pools, a long bone.',
    colors: [0xc8101a, 0xff2030, 0x9a0c12], shape: 'drop', count: 160, speed: 5.5, size: 0.022, decal: 'pool', decalScale: 3.2, bone: 'real', drip: [60, 1.5], stars: false },
];
/** The owner's first pick, else Realistic. */
export const DEFAULT_STYLE = STYLES.find((s) => s.id === (picks as { effects?: string[] }).effects?.[0]) ?? STYLES[0];
export const styleById = (id: string) => STYLES.find((s) => s.id === id) ?? DEFAULT_STYLE;
/** Gore setting levels (owner's picks note, 2026-10-18): each level shows one effect style. */
export const GORE_LEVELS = [
  { label: 'None', style: 'comic' }, { label: 'Low', style: 'cartoon' }, { label: 'Medium', style: 'voxel' },
  { label: 'High', style: 'realistic' }, { label: 'Very high', style: 'spray' },
] as const;

const MAX_PARTICLES = 400, MAX_DECALS = 240, G = 9.81;
const BONE = 0xeee4cc;

function starShape(points: number, outer: number, inner: number) {
  const s = new THREE.Shape();
  for (let k = 0; k <= 2 * points; k++) {
    const a = (k / (2 * points)) * Math.PI * 2, r = k % 2 ? inner : outer;
    if (k === 0) s.moveTo(r * Math.sin(a), r * Math.cos(a)); else s.lineTo(r * Math.sin(a), r * Math.cos(a));
  }
  return s;
}
const particleGeometry = (shape: EffectStyle['shape']) =>
  shape === 'cube' ? new THREE.BoxGeometry(1, 1, 1) : shape === 'star' ? new THREE.ShapeGeometry(starShape(5, 1, 0.45)) : new THREE.SphereGeometry(1, shape === 'blob' ? 8 : 5, shape === 'blob' ? 6 : 4);
const decalGeometry = (decal: EffectStyle['decal']) =>
  (decal === 'pixel' ? new THREE.PlaneGeometry(1, 1) : decal === 'splat' ? new THREE.ShapeGeometry(starShape(8, 1, 0.6)) : new THREE.CircleGeometry(1, 12)).rotateX(-Math.PI / 2);

/** A bone (shaft and knob) in the broken segment's frame, poking forward and down out of the front of the joint. */
function boneMesh(look: EffectStyle['bone']): THREE.Group {
  const g = new THREE.Group(), mat = new THREE.MeshLambertMaterial({ color: BONE });
  const len = look === 'cartoon' ? 0.15 : 0.17;
  const shaft = new THREE.Mesh(look === 'voxel' ? new THREE.BoxGeometry(0.03, len, 0.03) : new THREE.CylinderGeometry(0.013, 0.018, len, 6), mat);
  shaft.position.y = len / 2;
  g.add(shaft);
  const knobs = look === 'cartoon' ? [[-0.018, len], [0.018, len]] : [[0, len]];
  for (const [x, y] of knobs) {
    const k = new THREE.Mesh(look === 'voxel' ? new THREE.BoxGeometry(0.04, 0.04, 0.04) : new THREE.SphereGeometry(look === 'cartoon' ? 0.024 : 0.02, 6, 4), mat);
    k.position.set(x, y, 0);
    g.add(k);
  }
  // the shaft leaves the joint at the front, tilted outward and down
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -0.45, 1).normalize());
  g.position.set(0, -0.03, 0.04);
  return g;
}

interface Pin { node: THREE.Object3D; pose: () => { pos: Vec3; quat: Quat } | null; drip: number; dripUntil: number; dripAcc: number }

export class InjuryEffects {
  readonly root = new THREE.Group();
  style: EffectStyle = DEFAULT_STYLE;
  /** Share of each burst's particles drawn (the quality level's `effects`). */
  density = 1;
  private parts!: THREE.InstancedMesh;
  private decals!: THREE.InstancedMesh;
  private p = { pos: new Float32Array(3 * MAX_PARTICLES), vel: new Float32Array(3 * MAX_PARTICLES), size: new Float32Array(MAX_PARTICLES), spin: new Float32Array(MAX_PARTICLES), n: 0 };
  private d = { at: new Float32Array(3 * MAX_DECALS), size: new Float32Array(MAX_DECALS), age: new Float32Array(MAX_DECALS), rot: new Float32Array(MAX_DECALS), n: 0, next: 0 };
  private pins: Pin[] = [];
  private stars: { group: THREE.Group; head: () => Vec3 | null }[] = [];
  private t = 0;
  private rng = 1;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private s = new THREE.Vector3(); private e = new THREE.Euler();
  private seen = 0; private world: World | null = null; private worldTime = 0;

  constructor(style: EffectStyle = DEFAULT_STYLE) { this.setStyle(style); }

  /** Change the look, by style or id (clears what is on screen). */
  setStyle(s: EffectStyle | string) {
    const style = typeof s === 'string' ? styleById(s) : s;
    this.clear();
    for (const o of [this.parts, this.decals]) if (o) { this.root.remove(o); o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    this.style = style;
    this.parts = new THREE.InstancedMesh(particleGeometry(style.shape), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), MAX_PARTICLES);
    this.decals = new THREE.InstancedMesh(decalGeometry(style.decal), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), MAX_DECALS);
    for (const o of [this.parts, this.decals]) { o.count = 0; o.frustumCulled = false; this.root.add(o); }
    this.decals.renderOrder = 1;
  }

  /** Everything off the screen and the turf (a new rep). */
  clear() {
    this.p.n = 0; this.d.n = 0; this.d.next = 0;
    for (const x of [...this.pins.map((p) => p.node), ...this.stars.map((s) => s.group)]) this.root.remove(x);
    this.pins = []; this.stars = [];
    if (this.parts) this.parts.count = this.decals.count = 0;
  }

  private rand() { this.rng = (this.rng * 16807) % 2147483647; return this.rng / 2147483647; }

  private spray(at: Vec3, count: number, speed: number, carry: Vec3 = [0, 0, 0]) {
    const st = this.style, P = this.p;
    count = count > 0 ? Math.max(1, Math.round(count * this.density)) : 0;
    for (let k = 0; k < count && P.n < MAX_PARTICLES; k++, P.n++) {
      const i = P.n, a = this.rand() * Math.PI * 2, up = 0.3 + 0.7 * this.rand(), sp = speed * (0.4 + 0.6 * this.rand());
      P.pos.set(at, 3 * i);
      P.vel[3 * i] = carry[0] + sp * Math.cos(a) * (1 - up * 0.5); P.vel[3 * i + 1] = carry[1] + sp * up; P.vel[3 * i + 2] = carry[2] + sp * Math.sin(a) * (1 - up * 0.5);
      P.size[i] = st.size * (0.6 + 0.8 * this.rand()); P.spin[i] = this.rand() * 6;
      this.parts.setColorAt(i, new THREE.Color(st.colors[Math.floor(this.rand() * st.colors.length)]));
    }
    if (this.parts.instanceColor) this.parts.instanceColor.needsUpdate = true;
  }

  /** A joint broke at `at` (world); `pose` gives the broken segment's origin and orientation every frame (null: gone).
   *  `load` 0..1 scales the burst; the blood leaves with the limb's velocity `vel`. */
  break(at: Vec3, pose: () => { pos: Vec3; quat: Quat } | null, load = 0.5, vel: Vec3 = [0, 0, 0]) {
    const st = this.style;
    this.spray(at, Math.round(st.count * (0.7 + 0.6 * load)), st.speed, vel);
    const node = st.bone === 'none' ? new THREE.Group() : boneMesh(st.bone);
    const holder = new THREE.Group();
    holder.add(node);
    this.root.add(holder);
    this.pins.push({ node: holder, pose, drip: st.drip[0], dripUntil: this.t + st.drip[1], dripAcc: 0 });
  }

  /** Knocked out: a little blood from the nose, or (comic) stars circling the head for good. */
  ko(head: () => Vec3 | null) {
    const st = this.style, h = head();
    if (h && st.count && !st.stars) this.spray(h, Math.round(st.count / 5), st.speed * 0.4);
    if (!st.stars) return;
    const group = new THREE.Group(), geo = new THREE.ShapeGeometry(starShape(5, 0.035, 0.015)), mat = new THREE.MeshBasicMaterial({ color: 0xffe14a, side: THREE.DoubleSide });
    for (let k = 0; k < 4; k++) group.add(new THREE.Mesh(geo, mat));
    this.root.add(group);
    this.stars.push({ group, head });
  }

  /** Advance `dt` seconds: particles fly and land as splats, splats spread, pinned bones and stars follow their bodies. */
  step(dt: number) {
    this.t += dt;
    const P = this.p, D = this.d, st = this.style;
    // drips from the broken joints
    for (const pin of this.pins) {
      const pose = pin.pose();
      if (!pose) continue;
      pin.node.position.set(...pose.pos);
      pin.node.quaternion.set(...pose.quat);
      if (this.t < pin.dripUntil && pin.drip > 0) {
        pin.dripAcc += dt * pin.drip;
        const tip = this.v.set(0, -0.06, 0.1).applyQuaternion(pin.node.quaternion).add(pin.node.position);
        while (pin.dripAcc >= 1) { pin.dripAcc--; this.spray([tip.x, tip.y, tip.z], 1, st.speed * 0.3); }
      }
    }
    for (let i = 0; i < P.n; i++) {
      P.vel[3 * i + 1] -= G * dt;
      for (let k = 0; k < 3; k++) P.pos[3 * i + k] += P.vel[3 * i + k] * dt;
      if (P.pos[3 * i + 1] > 0.004) continue;
      // landed: a splat where it hit, the particle gone (swap with the last)
      if (st.decal !== 'none') {
        const j = D.next;
        D.at[3 * j] = P.pos[3 * i]; D.at[3 * j + 1] = 0.003 + 0.0001 * (j % 20); D.at[3 * j + 2] = P.pos[3 * i + 2];
        D.size[j] = P.size[i] * st.decalScale * (0.7 + 0.6 * this.rand()); D.age[j] = 0; D.rot[j] = this.rand() * Math.PI;
        this.decals.setColorAt(j, new THREE.Color(st.colors[0]).multiplyScalar(0.8 + 0.2 * this.rand()));
        D.next = (j + 1) % MAX_DECALS; D.n = Math.min(MAX_DECALS, D.n + 1);
        if (this.decals.instanceColor) this.decals.instanceColor.needsUpdate = true;
      }
      const last = --P.n;
      if (i !== last) {
        for (let k = 0; k < 3; k++) { P.pos[3 * i + k] = P.pos[3 * last + k]; P.vel[3 * i + k] = P.vel[3 * last + k]; }
        P.size[i] = P.size[last]; P.spin[i] = P.spin[last];
        const c = new THREE.Color(); this.parts.getColorAt(last, c); this.parts.setColorAt(i, c);
      }
      i--;
    }
    for (let i = 0; i < P.n; i++) {
      this.q.setFromEuler(this.e.set(P.spin[i] * this.t, P.spin[i], 0));
      this.parts.setMatrixAt(i, this.m.compose(this.v.fromArray(P.pos, 3 * i), this.q, this.s.setScalar(P.size[i])));
    }
    this.parts.count = P.n;
    this.parts.instanceMatrix.needsUpdate = true;
    for (let j = 0; j < D.n; j++) {
      D.age[j] += dt;
      const grow = st.decal === 'pool' ? 0.4 + 0.6 * Math.min(1, D.age[j] / 1.5) : 1; // a pool spreads as it soaks
      this.q.setFromAxisAngle(this.s.set(0, 1, 0), D.rot[j]);
      this.decals.setMatrixAt(j, this.m.compose(this.v.fromArray(D.at, 3 * j), this.q, this.s.set(D.size[j] * grow, 1, D.size[j] * grow)));
    }
    this.decals.count = D.n;
    this.decals.instanceMatrix.needsUpdate = true;
    for (const { group, head } of this.stars) {
      const h = head();
      if (!h) continue;
      group.children.forEach((c, k) => {
        const a = this.t * 3 + (k * Math.PI) / 2;
        c.position.set(h[0] + 0.2 * Math.cos(a), h[1] + 0.2 + 0.03 * Math.sin(3 * a), h[2] + 0.2 * Math.sin(a));
        c.rotation.y = -a;
      });
    }
  }

  /** Follow a world: new injuries become effects, and time advances with the simulation (slow motion too). */
  follow(w: World) {
    if (w !== this.world) { this.clear(); this.world = w; this.seen = 0; this.worldTime = w.time; }
    for (const e of w.injuries.slice(this.seen)) {
      const s = w.scene.athletes[e.athlete].state, a = w.athletes[e.athlete], k = a.segIndex.get(e.seg) ?? 0;
      const pose = () => (this.world === w ? { pos: [s.segPos[3 * k], s.segPos[3 * k + 1], s.segPos[3 * k + 2]] as Vec3, quat: [s.segQuat[4 * k], s.segQuat[4 * k + 1], s.segQuat[4 * k + 2], s.segQuat[4 * k + 3]] as Quat } : null);
      if (e.kind === 'break') this.break(e.pos, pose, Math.min(1, e.load / 600), [s.segVel[3 * k], s.segVel[3 * k + 1], s.segVel[3 * k + 2]]);
      else this.ko(() => { const p = pose(); return p ? [p.pos[0], p.pos[1] + 0.1, p.pos[2]] : null; });
    }
    this.seen = w.injuries.length;
    this.step(Math.max(0, Math.min(0.1, w.time - this.worldTime)));
    this.worldTime = w.time;
  }
}
