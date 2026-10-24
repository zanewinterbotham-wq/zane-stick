// Turf wear (presentation only, reads the World): turf and dirt kicked up when a foot digs in on a hard cut or stop,
// a spray along a body sliding on the turf, scuff marks that stay until the next rep, and (High/Ultra) soft contact
// shadows under the feet and body, the darkening where an athlete meets the grass.
import * as THREE from 'three';
import type { World } from '../../sim/world';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** How hard a planted foot digs in, 0..1: horizontal acceleration `accel` (m/s², measured on the centre of mass) at
 *  ground `speed` (m/s). A jog's footfalls (about 10 m/s²) throw nothing; a hard plant or cut (40+) throws a lot. */
export function kickIntensity(speed: number, accel: number): number {
  return speed < 3 ? 0 : clamp01((accel - 22) / 45);
}
/** How hard a fallen body scrapes the turf, 0..1, from its sliding `speed` (m/s). */
export function slideIntensity(speed: number): number {
  return speed < 2.5 ? 0 : clamp01((speed - 2.5) / 6);
}

const MAX_P = 320, MAX_S = 280, G = 9.81;
const COLORS = [0x2f6b33, 0x3b7a3d, 0x4a3a22, 0x5a4630, 0x35622f];
/** Minimum sim time between two readings of an athlete's acceleration (s): also averages out a Worker's uneven updates. */
const WINDOW = 0.04;

interface Track { vx: number; vz: number; t: number; kickAt: number; slideAt: number }

export class TurfMarks {
  readonly root = new THREE.Group();
  /** Share of the particles drawn (the quality level's `effects`); scuffs follow it too. */
  density = 1;
  private parts: THREE.InstancedMesh;
  private scuffs: THREE.InstancedMesh;
  private p = { pos: new Float32Array(3 * MAX_P), vel: new Float32Array(3 * MAX_P), size: new Float32Array(MAX_P), n: 0 };
  private s = { at: new Float32Array(3 * MAX_S), rot: new Float32Array(MAX_S), len: new Float32Array(MAX_S), wid: new Float32Array(MAX_S), n: 0, next: 0 };
  private tr: Track[] = [];
  private world: World | null = null;
  private rng = 7;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private sc = new THREE.Vector3(); private up = new THREE.Vector3(0, 1, 0);
  private col = new THREE.Color();

  constructor() {
    this.parts = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), MAX_P);
    this.scuffs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x1e1608, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1.5 }), MAX_S);
    for (const o of [this.parts, this.scuffs]) { o.count = 0; o.frustumCulled = false; this.root.add(o); }
    this.scuffs.renderOrder = 1;
  }

  private rand() { this.rng = (this.rng * 16807) % 2147483647; return this.rng / 2147483647; }

  /** Everything off the turf (a new rep). */
  clear() {
    this.p.n = 0; this.s.n = 0; this.s.next = 0; this.tr = [];
    this.parts.count = this.scuffs.count = 0;
  }

  private kick(x: number, z: number, dirx: number, dirz: number, k: number, count: number) {
    const P = this.p;
    count = Math.round(count * this.density);
    for (let n = 0; n < count && P.n < MAX_P; n++, P.n++) {
      const i = P.n, sp = (1 + 2.5 * k) * (0.4 + 0.6 * this.rand()), a = this.rand() * Math.PI * 2;
      P.pos[3 * i] = x; P.pos[3 * i + 1] = 0.02; P.pos[3 * i + 2] = z;
      P.vel[3 * i] = dirx * sp + 0.5 * Math.cos(a) * sp; P.vel[3 * i + 1] = 1.2 + 2.2 * k * this.rand(); P.vel[3 * i + 2] = dirz * sp + 0.5 * Math.sin(a) * sp;
      P.size[i] = 0.012 + 0.016 * this.rand();
      this.parts.setColorAt(i, this.col.setHex(COLORS[Math.floor(this.rand() * COLORS.length)]));
    }
    if (this.parts.instanceColor) this.parts.instanceColor.needsUpdate = true;
  }

  private scuff(x: number, z: number, dirx: number, dirz: number, len: number, wid: number) {
    if (this.density <= 0) return;
    const S = this.s, j = S.next;
    S.at[3 * j] = x; S.at[3 * j + 1] = 0.0025 + 0.00005 * (j % 20); S.at[3 * j + 2] = z;
    S.rot[j] = Math.atan2(dirx, dirz); S.len[j] = len; S.wid[j] = wid;
    S.next = (j + 1) % MAX_S; S.n = Math.min(MAX_S, S.n + 1); this.dirty = true;
  }

  /** Call every render frame: `poses` are this frame's segment poses (renderer.poses), `dt` the frame's length. */
  follow(w: World, poses: { segPos: ArrayLike<number> }[], dt: number) {
    if (w !== this.world) { this.clear(); this.world = w; }
    w.athletes.forEach((a, i) => {
      const st = w.scene.athletes[i].state, vx = st.comVel[0], vz = st.comVel[2], speed = Math.hypot(vx, vz);
      const tr = this.tr[i] ??= { vx, vz, t: w.time, kickAt: -1, slideAt: -1 };
      const span = w.time - tr.t;
      if (span >= WINDOW) {
        const accel = Math.hypot(vx - tr.vx, vz - tr.vz) / span;
        tr.vx = vx; tr.vz = vz; tr.t = w.time;
        const foot = a.feet.findIndex((f) => f.touching);
        if (a.downBy === null && foot >= 0 && w.time - tr.kickAt > 0.15) {
          const k = kickIntensity(speed, accel);
          if (k > 0) {
            const f = 3 * (a.segIndex.get(foot ? 'footR' : 'footL') ?? 0), sp = poses[i]?.segPos ?? st.segPos, ux = vx / speed, uz = vz / speed;
            tr.kickAt = w.time;
            this.kick(sp[f], sp[f + 2], ux, uz, k, 6 + 16 * k);
            this.scuff(sp[f] - 0.1 * ux, sp[f + 2] - 0.1 * uz, ux, uz, 0.2 + 0.4 * k, 0.05 + 0.04 * k);
          }
        }
      }
      // a fallen body sliding along the turf: a spray from the hips and a long scrape behind it
      if (a.downBy !== null && w.time - tr.slideAt > 0.06) {
        const k = slideIntensity(speed);
        if (k > 0) {
          tr.slideAt = w.time;
          const sp = poses[i]?.segPos ?? st.segPos, h = 3 * (a.segIndex.get('pelvis') ?? 0), ux = vx / speed, uz = vz / speed;
          this.kick(sp[h], sp[h + 2], ux, uz, 0.6 * k, 2 + 5 * k);
          this.scuff(sp[h], sp[h + 2], ux, uz, 0.5 + 0.5 * k, 0.16 + 0.12 * k);
        }
      }
    });
    this.step(dt);
  }

  private step(dt: number) {
    dt = Math.min(dt, 0.1);
    const P = this.p, S = this.s;
    for (let i = 0; i < P.n; i++) {
      P.vel[3 * i + 1] -= G * dt;
      for (let k = 0; k < 3; k++) P.pos[3 * i + k] += P.vel[3 * i + k] * dt;
      if (P.pos[3 * i + 1] > 0.005) continue;
      const last = --P.n; // landed: gone (swap with the last)
      if (i !== last) {
        for (let k = 0; k < 3; k++) { P.pos[3 * i + k] = P.pos[3 * last + k]; P.vel[3 * i + k] = P.vel[3 * last + k]; }
        P.size[i] = P.size[last];
        this.parts.getColorAt(last, this.col); this.parts.setColorAt(i, this.col);
        if (this.parts.instanceColor) this.parts.instanceColor.needsUpdate = true;
      }
      i--;
    }
    for (let i = 0; i < P.n; i++) {
      this.q.identity();
      this.parts.setMatrixAt(i, this.m.compose(this.v.fromArray(P.pos, 3 * i), this.q, this.sc.setScalar(P.size[i])));
    }
    this.parts.count = P.n;
    this.parts.instanceMatrix.needsUpdate = true;
    if (this.dirty) { // scuffs are static: rebuilt only when one was added
      for (let j = 0; j < S.n; j++) {
        this.q.setFromAxisAngle(this.up, S.rot[j]);
        this.scuffs.setMatrixAt(j, this.m.compose(this.v.fromArray(S.at, 3 * j), this.q, this.sc.set(S.wid[j], 1, S.len[j])));
      }
      this.scuffs.count = S.n;
      this.scuffs.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
  }
  private dirty = true;
}

/** Soft contact shadows (High/Ultra): a dark radial blob under each foot and the body, which spreads out when the
 *  athlete is down and shrinks away as he leaves the ground. One draw call. */
export class ContactShadows {
  readonly root = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private s = new THREE.Vector3();

  constructor() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!, g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.55, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    this.tex = tex;
    this.mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    this.geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  }
  private tex: THREE.Texture; private mat: THREE.Material; private geo: THREE.BufferGeometry;

  /** Three blobs per athlete: both feet and the body. */
  update(w: World, poses: { segPos: ArrayLike<number> }[]) {
    const n = w.athletes.length * 3;
    if (!this.mesh || this.mesh.instanceMatrix.count !== n) {
      if (this.mesh) this.root.remove(this.mesh);
      this.mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
      this.mesh.frustumCulled = false; this.mesh.renderOrder = 1;
      this.root.add(this.mesh);
    }
    const mesh = this.mesh;
    w.athletes.forEach((a, i) => {
      const st = w.scene.athletes[i].state, sp = poses[i]?.segPos ?? st.segPos;
      const h = st.com[1], body = h > 1.6 ? 0 : 0.5 + 0.7 * Math.max(0, 1 - h / 0.9); // a lying body casts the widest
      this.put(mesh, 3 * i, st.com[0], st.com[2], body);
      ['footL', 'footR'].forEach((name, k) => {
        const f = 3 * (a.segIndex.get(name) ?? 0), y = sp[f + 1];
        this.put(mesh, 3 * i + 1 + k, sp[f], sp[f + 2], y > 0.35 ? 0 : 0.34 * (1 - y / 0.35));
      });
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  private put(mesh: THREE.InstancedMesh, i: number, x: number, z: number, size: number) {
    mesh.setMatrixAt(i, this.m.compose(this.v.set(x, 0.0035, z), this.q.identity(), this.s.set(size, 1, size)));
  }

  dispose() { this.tex.dispose(); this.mat.dispose(); this.geo.dispose(); this.mesh?.dispose(); }
}
