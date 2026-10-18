// Anatomy view (x-ray): bones, joint centres, whole-body COM, its ground projection, base of support,
// and contact force arrows (length ∝ force). All read live from the simulation.
import * as THREE from 'three';
import type { World } from '../../sim/world';

const ARROW_M_PER_N = 1 / 1500; // 1.5 kN draws a 1 m arrow

export class AnatomyOverlay {
  readonly root = new THREE.Group();
  private bones: THREE.LineSegments[] = [];
  private joints: THREE.Points[] = [];
  private coms: THREE.Mesh[] = [];
  private comShadows: THREE.Mesh[] = [];
  private bos: THREE.LineLoop[] = [];
  private arrows: THREE.ArrowHelper[] = [];

  constructor(w: World) {
    const boneMat = new THREE.LineBasicMaterial({ color: 0xf5f0dc, depthTest: false });
    const jointMat = new THREE.PointsMaterial({ color: 0xff3d3d, size: 7, sizeAttenuation: false, depthTest: false });
    for (const a of w.athletes) {
      const n = a.plan.joints.length;
      const bone = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3)), boneMat);
      const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)), jointMat);
      bone.renderOrder = pts.renderOrder = 10; bone.frustumCulled = pts.frustumCulled = false;
      const com = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }));
      const shadow = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.07, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }));
      const loop = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3)), new THREE.LineBasicMaterial({ color: 0x36d6ff, depthTest: false }));
      com.renderOrder = shadow.renderOrder = loop.renderOrder = 11; loop.frustumCulled = false;
      this.root.add(bone, pts, com, shadow, loop);
      this.bones.push(bone); this.joints.push(pts); this.coms.push(com); this.comShadows.push(shadow); this.bos.push(loop);
    }
  }

  update(w: World) {
    w.athletes.forEach((a, ai) => {
      const s = w.scene.athletes[ai].state;
      const bp = this.bones[ai].geometry.getAttribute('position') as THREE.BufferAttribute;
      const jp = this.joints[ai].geometry.getAttribute('position') as THREE.BufferAttribute;
      a.plan.joints.forEach((j, k) => {
        const p = a.segIndex.get(j.parent)!, c = a.segIndex.get(j.child)!;
        // bone from parent COM to joint, joint to child COM
        bp.setXYZ(2 * k, s.segCom[3 * p], s.segCom[3 * p + 1], s.segCom[3 * p + 2]);
        bp.setXYZ(2 * k + 1, s.segPos[3 * c], s.segPos[3 * c + 1], s.segPos[3 * c + 2]);
        jp.setXYZ(k, s.segPos[3 * c], s.segPos[3 * c + 1], s.segPos[3 * c + 2]);
      });
      bp.needsUpdate = jp.needsUpdate = true;
      this.coms[ai].position.set(s.com[0], s.com[1], s.com[2]);
      this.comShadows[ai].position.set(s.com[0], 0.01, s.com[2]);
      // base of support: rectangle around each loaded foot (heel → toe, ± half width)
      const lp = this.bos[ai].geometry.getAttribute('position') as THREE.BufferAttribute;
      const pts: number[][] = [];
      a.feet.forEach((f, k) => {
        if (!f.touching) return;
        const fi = a.footSegs[k].values().next().value as number;
        const q = s.segQuat.subarray(4 * fi, 4 * fi + 4);
        const fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
        const n = Math.hypot(fx, fz) || 1, F = [fx / n, fz / n], R = [F[1], -F[0]];
        const ax = s.segPos[3 * fi], az = s.segPos[3 * fi + 2];
        for (const [f0, r0] of [[-0.06, -0.045], [0.19, -0.045], [0.19, 0.045], [-0.06, 0.045]]) pts.push([ax + F[0] * f0 + R[0] * r0, az + F[1] * f0 + R[1] * r0]);
      });
      const hull = convexHull(pts);
      for (let k = 0; k < 8; k++) { const p = hull[Math.min(k, hull.length - 1)] ?? [s.com[0], s.com[2]]; lp.setXYZ(k, p[0], 0.012, p[1]); }
      lp.needsUpdate = true;
    });
    // contact force arrows (athlete–athlete and athlete–ground above 50 N)
    const contacts = w.scene.contacts().filter((c) => c.force > 50 && (c.a.athlete >= 0 || c.b.athlete >= 0));
    while (this.arrows.length < contacts.length) { const ar = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0x36ff7a); this.root.add(ar); this.arrows.push(ar); }
    this.arrows.forEach((ar, k) => {
      const c = contacts[k];
      ar.visible = !!c;
      if (!c) return;
      const n = new THREE.Vector3(...c.normal);
      if (c.a.athlete < 0 && c.a.seg < 0) n.negate(); // point away from the ground into the body
      if (n.y < 0 && (c.b.athlete < 0 && c.b.seg < 0)) n.negate();
      ar.position.set(...c.pos);
      ar.setDirection(n.normalize());
      ar.setLength(Math.min(2, c.force * ARROW_M_PER_N), 0.06, 0.04);
      ar.setColor(c.a.athlete >= 0 && c.b.athlete >= 0 ? 0xff3df5 : 0x36ff7a);
    });
  }
}

function convexHull(p: number[][]): number[][] {
  if (p.length < 3) return p;
  const pts = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: number[][] = [], upper: number[][] = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
