// Athlete meshes generated from the same geometry the physics uses, so what is seen is what is simulated.
// Each segment is a Group posed from the physics state every frame; nothing here moves bodies.
import * as THREE from 'three';
import type { BodyPlan, GeomPlan, SegmentPlan } from '../../sim/anatomy/body';

export interface TeamColors { jersey: number; trim: number; pants: number; helmet: number; mask: number; skin: number; socks: number; cleats: number }
export const TEAMS: TeamColors[] = [
  { jersey: 0x1f3a68, trim: 0xf2f2ec, pants: 0xe9e6dc, helmet: 0x1f3a68, mask: 0xd8d8d8, skin: 0x8d5a3b, socks: 0x1f3a68, cleats: 0x161616 }, // Harbor Gulls
  { jersey: 0xd9631e, trim: 0x2b2b2b, pants: 0x2f2f33, helmet: 0xf07a2b, mask: 0x222222, skin: 0xd9a77e, socks: 0x2b2b2b, cleats: 0xf2f2f2 }, // Ridge Foxes
];

function colorFor(seg: SegmentPlan, g: GeomPlan, t: TeamColors): number {
  if (g.role === 'helmet') return t.helmet;
  if (g.role === 'facemask') return t.mask;
  if (g.role === 'pad') return t.jersey;
  if (g.role === 'foot') return t.cleats;
  if (g.role === 'hand') return t.skin;
  const n = seg.name;
  if (/thorax|lumbar|trunk|clavicle/.test(n)) return t.jersey;
  if (/upperArm/.test(n)) return t.jersey;
  if (/pelvis|thigh/.test(n)) return t.pants;
  if (/shank/.test(n)) return t.socks;
  return t.skin;
}

export class AthleteMesh {
  readonly root = new THREE.Group();
  readonly segs: THREE.Group[] = [];
  readonly materials: THREE.MeshStandardMaterial[][] = [];
  private base: THREE.Color[][] = [];

  constructor(plan: BodyPlan, team: TeamColors, quality: 'low' | 'high') {
    const caps = quality === 'high' ? [10, 6] : [7, 3];
    for (const s of plan.segments) {
      const grp = new THREE.Group();
      const mats: THREE.MeshStandardMaterial[] = [];
      const bases: THREE.Color[] = [];
      for (const g of s.geoms) {
        const color = colorFor(s, g, team);
        const mat = new THREE.MeshStandardMaterial({ color, roughness: g.role === 'helmet' ? 0.35 : 0.75, metalness: g.role === 'facemask' ? 0.4 : 0 });
        let mesh: THREE.Mesh;
        if (g.type === 'capsule') {
          const [a, b] = g.fromto!;
          const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          const len = dir.length();
          mesh = new THREE.Mesh(new THREE.CapsuleGeometry(g.size[0], len, caps[1], caps[0]), mat);
          mesh.position.set((a[0] + b[0]) / 2 - s.origin[0], (a[1] + b[1]) / 2 - s.origin[1], (a[2] + b[2]) / 2 - s.origin[2]);
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        } else if (g.type === 'box') {
          mesh = new THREE.Mesh(new THREE.BoxGeometry(2 * g.size[0], 2 * g.size[1], 2 * g.size[2]), mat);
          mesh.position.set(g.pos![0] - s.origin[0], g.pos![1] - s.origin[1], g.pos![2] - s.origin[2]);
        } else {
          mesh = new THREE.Mesh(new THREE.SphereGeometry(g.size[0], caps[0] + 4, caps[0]), mat);
          mesh.position.set(g.pos![0] - s.origin[0], g.pos![1] - s.origin[1], g.pos![2] - s.origin[2]);
        }
        mesh.castShadow = true;
        mesh.receiveShadow = quality === 'high';
        grp.add(mesh);
        mats.push(mat);
        bases.push(new THREE.Color(color));
      }
      this.root.add(grp);
      this.segs.push(grp);
      this.materials.push(mats);
      this.base.push(bases);
    }
  }

  /** Pose every segment from physics arrays (positions 3·n, quaternions x y z w 4·n). */
  pose(segPos: ArrayLike<number>, segQuat: ArrayLike<number>) {
    this.segs.forEach((g, i) => {
      g.position.set(segPos[3 * i], segPos[3 * i + 1], segPos[3 * i + 2]);
      g.quaternion.set(segQuat[4 * i], segQuat[4 * i + 1], segQuat[4 * i + 2], segQuat[4 * i + 3]);
    });
  }

  /** Effort shading: tint each segment toward hot orange as its muscles near their limit (0..1). */
  private static HOT = new THREE.Color(0xff5a1f);
  shade(effortPerSeg: ArrayLike<number> | null) {
    this.materials.forEach((mats, i) => mats.forEach((m, k) => {
      const e = effortPerSeg ? Math.max(0, (effortPerSeg[i] - 0.55) / 0.45) : 0;
      m.color.copy(this.base[i][k]).lerp(AthleteMesh.HOT, Math.min(1, e) * 0.75);
    }));
  }

  setXray(on: boolean) {
    for (const mats of this.materials) for (const m of mats) { m.transparent = on; m.opacity = on ? 0.22 : 1; m.depthWrite = !on; }
  }
}
