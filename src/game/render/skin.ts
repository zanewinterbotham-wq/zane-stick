/// <reference types="vite/client" />
// Character skins: art models (public/models/*.glb, see tools/models/export.ts) that ride the physics segments.
// Each file has one node per standard-detail segment, named like it, with its mesh authored in the rest frame
// about the segment origin; or (rigged) one SkinnedMesh with a bone per segment, bound in the A-pose. Only the chosen
// skin is fetched, once.
import * as THREE from 'three';
import { buildBody, DEFAULT_ATHLETE } from '../../sim/anatomy/body';
import list from '../skins.json';

export interface Skin { id: string; label: string; pitch: string; file: string | null; preview?: string | null; look: string; unlocked: boolean }
export const CLASSIC: Skin = { id: 'classic', label: 'Classic', pitch: 'The physics collision shapes themselves.', file: null, preview: null, look: 'standard', unlocked: true };
export const SKINS: Skin[] = [...list, CLASSIC];
export const unlockedSkins = () => SKINS.filter((s) => s.unlocked);
/** Unknown or locked ids fall back to Classic. */
export const skinById = (id: string) => unlockedSkins().find((s) => s.id === id) ?? CLASSIC;

/** A rigged skin (SkinnedMesh, one bone per physics segment): its meshes (geometry shared, materials restyled), its
 *  bones in skin-joint order with their fixed offset `off` (a segment's bone: from the segment frame, O = S_bind⁻¹ ·
 *  B_bind; a bone with no segment, `parent` ≥ 0: from its parent bone) and the file's inverse bind matrices. */
export interface Rig { meshes: THREE.SkinnedMesh[]; bones: { name: string; parent: number; off: THREE.Matrix4 }[]; inverses: THREE.Matrix4[] }

/** Per segment name, the meshes of that node (geometry shared, materials restyled for the skin's look). A rigged skin
 *  draws its `rig` instead; its parts are only the head and thorax surfaces (rest frame) the face and decals are fitted to. */
export interface SkinTemplate { look: string; id?: string; parts: Map<string, THREE.Mesh[]>; rig?: Rig }

const BODY = buildBody(DEFAULT_ATHLETE, 'standard').segments;
const SEGMENTS = BODY.map((s) => s.name);

// common.A_POSE (art/blender/common.py) in physics axes: Blender Y is physics -Z, so the arms swing out about +z
const A_POSE: Record<string, number> = { upperArmL: 38, upperArmR: -38, forearmL: 6, forearmR: -6 };
const Z = new THREE.Vector3(0, 0, 1);

/** Each segment's world frame in the pose rigged skins are bound in: the physics rest pose (segment frames world-aligned
 *  at their origins, as the rigid skins use) with the A-pose arm rotations. Parents must come before children. */
export function bindFrames(segs: { name: string; parent: string | null; origin: number[] }[]): Map<string, THREE.Matrix4> {
  const out = new Map<string, THREE.Matrix4>(), at = new Map(segs.map((s) => [s.name, s.origin]));
  for (const s of segs) {
    const p = s.parent ? at.get(s.parent)! : [0, 0, 0];
    const m = new THREE.Matrix4().makeTranslation(s.origin[0] - p[0], s.origin[1] - p[1], s.origin[2] - p[2])
      .multiply(new THREE.Matrix4().makeRotationAxis(Z, THREE.MathUtils.degToRad(A_POSE[s.name] ?? 0)));
    out.set(s.name, s.parent ? out.get(s.parent)!.clone().multiply(m) : m);
  }
  return out;
}

/** Bone offsets: a segment's bone keeps O = S_bind⁻¹ · B_bind, so S_now · O puts it where the segment now is; any other
 *  bone keeps its bind transform relative to its parent bone (it follows the parent). `bind`: bone world matrices at bind. */
export function boneOffsets(names: string[], parents: number[], bind: THREE.Matrix4[], frames: Map<string, THREE.Matrix4>): Rig['bones'] {
  return names.map((name, i) => {
    const f = frames.get(name);
    if (f) return { name, parent: -1, off: f.clone().invert().multiply(bind[i]) };
    if (parents[i] < 0) throw new Error(`skin bone ${name} has no segment and no parent bone`);
    return { name, parent: parents[i], off: bind[parents[i]].clone().invert().multiply(bind[i]) };
  });
}

// three-band cel ramp for the toon looks
const RAMP = new THREE.DataTexture(new Uint8Array([70, 160, 255]), 3, 1, THREE.RedFormat);
RAMP.minFilter = RAMP.magFilter = THREE.NearestFilter;
RAMP.needsUpdate = true;

function restyle(m: THREE.MeshStandardMaterial, look: string): THREE.Material {
  const { name, color, side } = m;
  if (name === 'ink') return new THREE.MeshBasicMaterial({ name, color, side }); // outline shell: unlit, back faces culled
  if (look === 'toon') return new THREE.MeshToonMaterial({ name, color, side, gradientMap: RAMP });
  if (look === 'paper') return new THREE.MeshBasicMaterial({ name, color, side }); // printed card: no shading
  if (look === 'clay' && name !== 'mask') { m.roughness = 1; m.metalness = 0; }
  return m;
}

function styler(look: string) {
  const styled = new Map<THREE.Material, THREE.Material>();
  return (m: THREE.Mesh) => {
    const src = m.material as THREE.MeshStandardMaterial;
    if (!styled.has(src)) {
      const mat = restyle(src, look);
      // double-sided faces casting into the shadow map shadow themselves (acne); closed meshes only need back faces
      if (mat.side === THREE.DoubleSide) mat.shadowSide = THREE.BackSide;
      styled.set(src, mat);
    }
    m.material = styled.get(src)!;
  };
}

export function template(scene: THREE.Object3D, look: string): SkinTemplate {
  const skinned: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
  if (skinned.length) return rigTemplate(skinned, look);
  const nodes = new Set<THREE.Object3D>();
  for (const n of SEGMENTS) { const o = scene.getObjectByName(n); if (!o) throw new Error(`skin has no node ${n}`); nodes.add(o); }
  const style = styler(look);
  const parts = new Map<string, THREE.Mesh[]>();
  for (const o of nodes) {
    // one primitive: the node is the Mesh; several: a Group of Meshes (other segment nodes are children too)
    const meshes = ((o as THREE.Mesh).isMesh ? [o] : o.children.filter((c) => (c as THREE.Mesh).isMesh && !nodes.has(c))) as THREE.Mesh[];
    meshes.forEach(style);
    parts.set(o.name, meshes);
  }
  return { look, parts };
}

/** A rigged skin: bound at the origin in the A-pose (art/models/<id>/build.py), all primitives on one skeleton. */
function rigTemplate(meshes: THREE.SkinnedMesh[], look: string): SkinTemplate {
  const sk = meshes[0].skeleton, names = sk.bones.map((b) => b.name);
  for (const n of SEGMENTS) if (!names.includes(n)) throw new Error(`skin has no bone ${n}`);
  meshes.forEach(styler(look));
  const frames = bindFrames(BODY);
  const bind = sk.boneInverses.map((m) => m.clone().invert());
  const bones = boneOffsets(names, sk.bones.map((b) => sk.bones.indexOf(b.parent as THREE.Bone)), bind, frames);
  // the face and decals are fitted by rays at the head and thorax surfaces: the faces mostly weighted to that bone,
  // moved into the segment's rest frame
  const parts = new Map<string, THREE.Mesh[]>(SEGMENTS.map((n) => [n, []]));
  for (const seg of ['head', 'thorax']) {
    const j = names.indexOf(seg), inv = frames.get(seg)!.clone().invert(), p = new THREE.Vector3();
    for (const m of meshes) {
      const g = m.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      const top = (v: number) => { let b = 0; for (let k = 1; k < 4; k++) if (sw.getComponent(v, k) > sw.getComponent(v, b)) b = k; return si.getComponent(v, b); };
      const idx = g.index ? Array.from(g.index.array) : Array.from({ length: pos.count }, (_, i) => i), out: number[] = [];
      for (let t = 0; t < idx.length; t += 3) {
        const tri = idx.slice(t, t + 3);
        if (tri.filter((v) => top(v) === j).length < 2) continue;
        for (const v of tri) out.push(...p.fromBufferAttribute(pos, v).applyMatrix4(inv).toArray());
      }
      if (!out.length) continue;
      const probe = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
      parts.get(seg)!.push(new THREE.Mesh(probe, m.material));
    }
  }
  return { look, parts, rig: { meshes, bones, inverses: sk.boneInverses } };
}

const cache = new Map<string, Promise<SkinTemplate>>();
/** The skin's model, or null for Classic. Rejects if the file cannot be fetched or parsed. */
export function loadSkin(skin: Skin): Promise<SkinTemplate> | null {
  if (!skin.file) return null;
  let p = cache.get(skin.id);
  if (!p) {
    p = import('three/examples/jsm/loaders/GLTFLoader.js')
      .then(({ GLTFLoader }) => new GLTFLoader().loadAsync(import.meta.env.BASE_URL + skin.file))
      .then((g) => ({ ...template(g.scene, skin.look), id: skin.id })); // the id picks the skin's mouth style
    p.catch(() => cache.delete(skin.id)); // let a later rep retry
    cache.set(skin.id, p);
  }
  return p;
}
