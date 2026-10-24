// Athlete meshes generated from the same geometry the physics uses, so what is seen is what is simulated.
// Each segment is a Group posed from the physics state every frame; nothing here moves bodies.
// A skin (art model, see skin.ts) can be worn over them; the classic shapes then show only in the anatomy view.
import * as THREE from 'three';
import { buildBody, DEFAULT_ATHLETE, type BodyPlan, type GeomPlan, type SegmentPlan } from '../../sim/anatomy/body';
import { BROW_STYLES, Brows } from './brows';
import { fitAnchor, Mouth, skinAnchor, sphereAnchor, STYLES, type Anchor } from './mouth';
import { disposeTree } from './renderer';
import type { SkinTemplate } from './skin';
import { decalMesh, helmetMaterial, jerseyMaterial, skinSpots, STAIN_COLOR, STAIN_MAX, type Ident } from './uniform';

/** Optional looks (render/uniform.ts): `ident` puts a number and name on the jersey and a mark on the helmet (Medium
 *  and up), `stain` is the starting grass-stain level 0..1. */
export interface Extras { ident?: Ident; stain?: number }
/** A colour that grass stains pull toward green: the live material colour (`base`: what shade() resets it to) and the clean one. */
interface Stainable { mat: { color: THREE.Color }; base: THREE.Color; orig: THREE.Color }

export interface TeamColors { jersey: number; trim: number; pants: number; helmet: number; mask: number; skin: number; socks: number; cleats: number; glow: number }
export const TEAMS: TeamColors[] = [
  { jersey: 0x1f3a68, trim: 0xf2f2ec, pants: 0xe9e6dc, helmet: 0x1f3a68, mask: 0xd8d8d8, skin: 0x8d5a3b, socks: 0x1f3a68, cleats: 0x161616, glow: 0x6bdaff }, // Harbor Gulls
  { jersey: 0xd9631e, trim: 0x2b2b2b, pants: 0x2f2f33, helmet: 0xf07a2b, mask: 0x222222, skin: 0xd9a77e, socks: 0x2b2b2b, cleats: 0xf2f2f2, glow: 0xffae38 }, // Ridge Foxes
];

/** At minimum detail these segments are fused into a parent (toMinimum in sim/anatomy/body.ts); their skin
 *  meshes ride on it rigidly. The fused neck+head keeps the neck's frame under the name 'head'. */
const FUSED_INTO: Record<string, string> = {
  clavicleL: 'trunk', clavicleR: 'trunk', lumbar: 'trunk', thorax: 'trunk', neck: 'head',
  handL: 'forearmL', handR: 'forearmR', toesL: 'footL', toesR: 'footR',
};

/** One skin node: which physics segment carries it and its rest-frame offset from that segment's origin. */
interface SkinPart { node: THREE.Group; seg: number; off: THREE.Vector3 }

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
  readonly classic = new THREE.Group();
  readonly skin = new THREE.Group();
  readonly segs: THREE.Group[] = [];
  readonly parts: SkinPart[] = [];
  readonly materials: THREE.MeshStandardMaterial[][] = [];
  private base: THREE.Color[][] = [];
  /** The face's mouth (it rides the head, so the helmet camera hides it with the head). */
  mouth: Mouth | null = null;
  /** The face's eyebrows, which carry the mood (render/brows.ts). */
  brows: Brows | null = null;
  private headOn = true; private shaded = false;
  private stainable: Stainable[] = [];
  private stain = 0;

  constructor(private plan: BodyPlan, team: TeamColors, quality: 'low' | 'high', skin: SkinTemplate | null = null, private extra: Extras = {}) {
    this.root.add(this.classic, this.skin);
    if (skin) this.wear(plan, team, quality, skin);
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
        if (g.role !== 'helmet' && g.role !== 'facemask' && (color === team.jersey || color === team.pants || color === team.socks)) {
          this.stainable.push({ mat, base: bases[bases.length - 1], orig: new THREE.Color(color) });
        }
      }
      if (extra.ident) this.markClassic(grp, s, team);
      if (s.name === 'head' && !skin) {
        // the helmet is a bare sphere: the mouth sits on its lower front, under the facemask bar
        const h = s.geoms.find((g) => g.role === 'helmet')!, c = h.pos!.map((v, k) => v - s.origin[k]);
        this.mouth = new Mouth(STYLES.classic, sphereAnchor(c, h.size[0], -0.1), team.glow);
        grp.add(this.mouth.mesh);
        const b = BROW_STYLES.classic, c0 = c as [number, number, number];
        this.brows = new Brows(b, [-b.x, b.x].map((dx) => sphereAnchor(c0, h.size[0], b.y, dx)) as [Anchor, Anchor]);
        grp.add(this.brows.mesh);
      }
      this.classic.add(grp);
      this.segs.push(grp);
      this.materials.push(mats);
      this.base.push(bases);
    }
    this.setXray(false);
    this.setStain(extra.stain ?? 0);
  }

  /** Number and name on the back and number on the chest of the classic torso's pads, a mark on both sides of the helmet. */
  private markClassic(grp: THREE.Group, s: SegmentPlan, team: TeamColors) {
    const id = this.extra.ident!, rel = (p: number[]) => p.map((v, k) => v - s.origin[k]) as [number, number, number];
    const pad = s.geoms.find((g) => g.role === 'pad'), helmet = s.geoms.find((g) => g.role === 'helmet');
    if (pad) {
      const [x, y, z] = rel(pad.pos!), size = Math.min(0.38, 1.6 * pad.size[0]);
      grp.add(decalMesh(jerseyMaterial(id, team, 'back'), [x, y, z - pad.size[2] - 0.004], Math.PI, size));
      grp.add(decalMesh(jerseyMaterial(id, team, 'front'), [x, y, z + pad.size[2] + 0.004], 0, size * 0.6));
    }
    if (helmet) {
      const [x, y, z] = rel(helmet.pos!), r = helmet.size[0], mat = helmetMaterial(id, team);
      grp.add(decalMesh(mat, [x + r + 0.006, y, z - 0.01], Math.PI / 2, 1.1 * r), decalMesh(mat, [x - r - 0.006, y, z - 0.01], -Math.PI / 2, 1.1 * r));
    }
  }

  /** Grass stains 0..1: jerseys, pants and socks fade toward green-brown (cheap enough to call every frame). */
  setStain(level: number) {
    if (Math.abs(level - this.stain) < 0.02 && !(level === 0 && this.stain !== 0)) return;
    this.stain = level;
    for (const s of this.stainable) {
      s.base.copy(s.orig).lerp(STAIN_COLOR, level * STAIN_MAX);
      if (!this.shaded) s.mat.color.copy(s.base);
    }
  }

  /** Skin nodes go on the physics segments with the file's A-pose rotations dropped: the mesh data is in the rest
   *  frame, so segment pose × rest offset is the whole transform. Materials are cloned per athlete for team colours. */
  private wear(plan: BodyPlan, team: TeamColors, quality: 'low' | 'high', skin: SkinTemplate) {
    const rest = new Map(buildBody(plan.params, 'standard').segments.map((s) => [s.name, s.origin]));
    const index = new Map(plan.segments.map((s, i) => [s.name, i]));
    const mats = new Map<THREE.Material, THREE.Material>();
    const colours = team as unknown as Record<string, number | undefined>;
    // the models are built for the reference athlete; scale them to this one's stature
    const k = plan.params.height / DEFAULT_ATHLETE.height;
    for (const [name, meshes] of skin.parts) {
      const seg = index.get(plan.detail === 'minimum' ? FUSED_INTO[name] ?? name : name)!;
      const o = rest.get(name)!, so = plan.segments[seg].origin;
      const node = new THREE.Group();
      node.scale.setScalar(k);
      for (const m of meshes) {
        let mat = mats.get(m.material as THREE.Material);
        if (!mat) {
          mat = (m.material as THREE.Material).clone();
          const hex = colours[mat.name];
          if (hex !== undefined) {
            const c = mat as THREE.MeshStandardMaterial;
            c.color.setHex(hex);
            if (mat.name === 'glow') c.emissive.setHex(hex);
            if (mat.name === 'jersey' || mat.name === 'pants' || mat.name === 'socks') this.stainable.push({ mat: c, base: c.color, orig: c.color.clone() });
          }
          mats.set(m.material as THREE.Material, mat);
        }
        const mesh = new THREE.Mesh(m.geometry, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = quality === 'high';
        node.add(mesh);
      }
      if (name === 'head' && skin.id && STYLES[skin.id]) {
        const style = STYLES[skin.id];
        this.mouth = new Mouth(style, skinAnchor(skin, style), team.glow);
        node.add(this.mouth.mesh);
        const b = BROW_STYLES[skin.id];
        this.brows = new Brows(b, [-b.x, b.x].map((x) => fitAnchor(skin, b.mat, x, b.y, b.hw)) as [Anchor, Anchor], team.glow);
        node.add(this.brows.mesh);
      }
      if (this.extra.ident && (name === 'thorax' || name === 'head')) {
        // skins differ in shape: the decals go where rays at the skin's own meshes say its surface is
        const id = this.extra.ident, sp = skinSpots(name, meshes);
        if (sp.back) node.add(decalMesh(jerseyMaterial(id, team, 'back'), sp.back.pos, Math.PI, sp.back.size));
        if (sp.front) node.add(decalMesh(jerseyMaterial(id, team, 'front'), sp.front.pos, 0, sp.front.size));
        if (sp.headL) node.add(decalMesh(helmetMaterial(id, team), sp.headL.pos, Math.PI / 2, sp.headL.size));
        if (sp.headR) node.add(decalMesh(helmetMaterial(id, team), sp.headR.pos, -Math.PI / 2, sp.headR.size));
      }
      this.skin.add(node);
      this.parts.push({ node, seg, off: new THREE.Vector3(o[0] - so[0], o[1] - so[1], o[2] - so[2]) });
    }
  }

  /** Pose every segment from physics arrays (positions 3·n, quaternions x y z w 4·n). */
  pose(segPos: ArrayLike<number>, segQuat: ArrayLike<number>) {
    if (this.classic.visible) this.segs.forEach((g, i) => {
      g.position.set(segPos[3 * i], segPos[3 * i + 1], segPos[3 * i + 2]);
      g.quaternion.set(segQuat[4 * i], segQuat[4 * i + 1], segQuat[4 * i + 2], segQuat[4 * i + 3]);
    });
    if (this.skin.visible) for (const { node, seg: i, off } of this.parts) {
      node.quaternion.set(segQuat[4 * i], segQuat[4 * i + 1], segQuat[4 * i + 2], segQuat[4 * i + 3]);
      node.position.copy(off).applyQuaternion(node.quaternion);
      node.position.x += segPos[3 * i]; node.position.y += segPos[3 * i + 1]; node.position.z += segPos[3 * i + 2];
    }
  }

  /** The classic shapes are this athlete's own; the skin's geometry is the shared template's (only its face is his). */
  dispose() { disposeTree(this.classic); this.mouth?.dispose(); this.brows?.dispose(); }

  /** Show or hide the head, neck, helmet and facemask (classic and skin): the helmet camera sits inside them. */
  setHeadVisible(on: boolean) {
    if (on === this.headOn) return; // called every frame
    this.headOn = on;
    const head = (i: number) => /^(head|neck)$/.test(this.plan.segments[i].name);
    this.segs.forEach((g, i) => { if (head(i)) g.visible = on; });
    for (const p of this.parts) if (head(p.seg)) p.node.visible = on;
  }

  /** Effort shading: tint each segment toward hot orange as its muscles near their limit (0..1). */
  private static HOT = new THREE.Color(0xff5a1f);
  shade(effortPerSeg: ArrayLike<number> | null) {
    if (!effortPerSeg && !this.shaded) return; // the base colours already (every frame outside the anatomy view)
    this.shaded = !!effortPerSeg;
    this.materials.forEach((mats, i) => mats.forEach((m, k) => {
      const e = effortPerSeg ? Math.max(0, (effortPerSeg[i] - 0.55) / 0.45) : 0;
      m.color.copy(this.base[i][k]).lerp(AthleteMesh.HOT, Math.min(1, e) * 0.75);
    }));
  }

  /** The anatomy view shows the classic shapes (they are the physics bodies; the skins' big heads are not), so a
   *  skin is hidden there rather than made translucent. */
  setXray(on: boolean) {
    for (const mats of this.materials) for (const m of mats) { m.transparent = on; m.opacity = on ? 0.22 : 1; m.depthWrite = !on; }
    this.skin.visible = !on && this.parts.length > 0;
    this.classic.visible = !this.skin.visible;
  }
}
