/// <reference types="vite/client" />
// Character skins: art models (public/models/*.glb, see tools/models/export.ts) that ride the physics segments.
// Each file has one node per standard-detail segment, named like it, with its mesh authored in the rest frame
// about the segment origin. Only the chosen skin is fetched, once.
import * as THREE from 'three';
import { buildBody, DEFAULT_ATHLETE } from '../../sim/anatomy/body';
import list from '../skins.json';

export interface Skin { id: string; label: string; pitch: string; file: string | null; look: string; unlocked: boolean }
export const CLASSIC: Skin = { id: 'classic', label: 'Classic', pitch: 'The physics collision shapes themselves.', file: null, look: 'standard', unlocked: true };
export const SKINS: Skin[] = [...list, CLASSIC];
export const unlockedSkins = () => SKINS.filter((s) => s.unlocked);
/** Unknown or locked ids fall back to Classic. */
export const skinById = (id: string) => unlockedSkins().find((s) => s.id === id) ?? CLASSIC;

/** Per segment name, the meshes of that node (geometry shared, materials restyled for the skin's look). */
export interface SkinTemplate { look: string; parts: Map<string, THREE.Mesh[]> }

const SEGMENTS = buildBody(DEFAULT_ATHLETE, 'standard').segments.map((s) => s.name);

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

export function template(scene: THREE.Object3D, look: string): SkinTemplate {
  const nodes = new Set<THREE.Object3D>();
  for (const n of SEGMENTS) { const o = scene.getObjectByName(n); if (!o) throw new Error(`skin has no node ${n}`); nodes.add(o); }
  const styled = new Map<THREE.Material, THREE.Material>();
  const parts = new Map<string, THREE.Mesh[]>();
  for (const o of nodes) {
    // one primitive: the node is the Mesh; several: a Group of Meshes (other segment nodes are children too)
    const meshes = ((o as THREE.Mesh).isMesh ? [o] : o.children.filter((c) => (c as THREE.Mesh).isMesh && !nodes.has(c))) as THREE.Mesh[];
    for (const m of meshes) {
      const src = m.material as THREE.MeshStandardMaterial;
      if (!styled.has(src)) {
        const mat = restyle(src, look);
        // double-sided faces casting into the shadow map shadow themselves (acne); closed meshes only need back faces
        if (mat.side === THREE.DoubleSide) mat.shadowSide = THREE.BackSide;
        styled.set(src, mat);
      }
      m.material = styled.get(src)!;
    }
    parts.set(o.name, meshes);
  }
  return { look, parts };
}

const cache = new Map<string, Promise<SkinTemplate>>();
/** The skin's model, or null for Classic. Rejects if the file cannot be fetched or parsed. */
export function loadSkin(skin: Skin): Promise<SkinTemplate> | null {
  if (!skin.file) return null;
  let p = cache.get(skin.id);
  if (!p) {
    p = import('three/examples/jsm/loaders/GLTFLoader.js')
      .then(({ GLTFLoader }) => new GLTFLoader().loadAsync(import.meta.env.BASE_URL + skin.file))
      .then((g) => template(g.scene, skin.look));
    p.catch(() => cache.delete(skin.id)); // let a later rep retry
    cache.set(skin.id, p);
  }
  return p;
}
