/// <reference types="vite/client" />
// Stadiums: low-poly environments (public/models/stadiums/*.glb, see tools/models/export.ts) drawn round the playing
// area, each with its own sky, fog and light. The padded wall in the art sits on the physics barrier. Only the
// chosen stadium is fetched, once; Open Field is the plain training look with a procedural wall.
import * as THREE from 'three';
import list from '../stadiums.json';

export interface StadiumScene { sky: string; fog: [string, number, number]; hemi: [string, string, number]; sun: [string, number] }
export interface Stadium { id: string; label: string; pitch: string; file: string | null; preview: string | null; scene: StadiumScene | null; unlocked: boolean }

export const OPEN_FIELD: Stadium = {
  id: 'field', label: 'Open Field', pitch: 'The plain training field under a blue sky, behind a padded wall.', file: null, preview: null, scene: null, unlocked: true,
};
export const STADIUMS: Stadium[] = [...(list as Stadium[]), OPEN_FIELD];
export const unlockedStadiums = () => STADIUMS.filter((s) => s.unlocked);
/** Unknown or locked ids fall back to the Open Field. */
export const stadiumById = (id: string) => unlockedStadiums().find((s) => s.id === id) ?? OPEN_FIELD;

const cache = new Map<string, Promise<THREE.Group>>();

/** The stadium's model, or null for the Open Field. Rejects if the file cannot be fetched or parsed. */
export function loadStadium(s: Stadium): Promise<THREE.Group> | null {
  if (!s.file) return null;
  let p = cache.get(s.id);
  if (!p) {
    p = import('three/examples/jsm/loaders/GLTFLoader.js')
      .then(({ GLTFLoader }) => new GLTFLoader().loadAsync(import.meta.env.BASE_URL + s.file))
      .then((g) => prepare(g.scene));
    p.catch(() => cache.delete(s.id)); // let a later rep retry
    cache.set(s.id, p);
  }
  return p;
}

/** Scenery never moves or shadows: static matrices, no shadow passes, and stars and the moon ignore the fog. */
function prepare(root: THREE.Group): THREE.Group {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = m.receiveShadow = false;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    for (const mat of [m.material].flat() as THREE.MeshStandardMaterial[]) {
      if (mat.name.endsWith('nofog')) mat.fog = false;
      if (mat.map) { // the crowd sprites: sharp up close, mipmapped far away so the rows do not shimmer
        mat.map.minFilter = THREE.LinearMipmapLinearFilter;
        mat.map.anisotropy = 4;
        mat.map.needsUpdate = true;
      }
    }
  });
  root.matrixAutoUpdate = false;
  root.updateMatrixWorld(true);
  return root;
}
