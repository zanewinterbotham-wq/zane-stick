// The QB throw schemes' aim aids (passing/schemes.ts Aid): an icon over the target receiver, a ring on the turf, and a
// dotted arc preview of the flight. A handful of unlit, shadowless meshes: cheap on the Potato preset. Visual only.
import * as THREE from 'three';
import type { Vec3 } from '../../sim/math';
import { throwVelocity } from '../../sim/throw';
import type { Aid } from '../passing/schemes';

const G = 9.81, DOTS = 28;
/** The icon floats this far above the receiver's catch point (m): over his helmet. */
const ICON_UP = 0.95;

export class PassAim {
  readonly root = new THREE.Group();
  private icon: THREE.Mesh;
  private ring: THREE.Mesh;
  private dots: THREE.Points;
  private pos = new Float32Array(3 * DOTS);

  constructor() {
    const mat = (color: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
    this.icon = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.4, 4).rotateX(Math.PI), mat(0xffd23a)); // a diamond point, tip down
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 40).rotateX(-Math.PI / 2), mat(0x5fd7ff));
    this.ring.renderOrder = 5;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.dots = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.1, transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
    this.dots.frustumCulled = false; // its bounds change every frame
    this.root.add(this.icon, this.ring, this.dots);
    this.set(null, [0, 0, 0]);
  }

  /** This frame's aids for a throw from `from` (null: none). */
  set(aid: Aid | null, from: Vec3) {
    this.icon.visible = !!aid?.icon;
    if (aid?.icon) { this.icon.position.set(aid.icon[0], aid.icon[1] + ICON_UP, aid.icon[2]); this.icon.rotation.y += 0.04; }
    this.ring.visible = !!aid?.reticle;
    if (aid?.reticle) this.ring.position.set(aid.reticle[0], 0.03, aid.reticle[2]);
    this.dots.visible = !!aid?.arc;
    if (!aid?.arc) return;
    const { vel, time } = throwVelocity(from, aid.arc.at, aid.arc.loft);
    for (let k = 0; k < DOTS; k++) {
      const t = time * (k + 1) / DOTS;
      this.pos[3 * k] = from[0] + vel[0] * t;
      this.pos[3 * k + 1] = Math.max(0.02, from[1] + vel[1] * t - 0.5 * G * t * t);
      this.pos[3 * k + 2] = from[2] + vel[2] * t;
    }
    this.dots.geometry.attributes.position.needsUpdate = true;
  }
}
