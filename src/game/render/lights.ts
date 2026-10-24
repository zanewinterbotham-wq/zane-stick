// Floodlights for the night stadium (Medium and up): a spotlight per mast on the field, each with a glow where its lamp
// bank is. The masts are in the model (art/blender/stadium.py night(): corners at x ±51.4, z ±70.9 m, 40 m up).
import * as THREE from 'three';

export interface Mast { x: number; z: number; h: number }
/** Stadium id -> its light masts' positions (all four corners, mirrored). */
export const FLOODLIGHTS: Record<string, Mast> = { night: { x: 51.4, z: 70.9, h: 40.5 } };

/** Spot intensity (cd) for the mast distance ~96 m: about 1.1 lux-equivalent on the turf from the four together. */
const INTENSITY = 6000;

export function buildFloodlights(id: string): THREE.Group | null {
  const mast = FLOODLIGHTS[id];
  if (!mast) return null;
  const g = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!, grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,248,225,1)'); grad.addColorStop(0.25, 'rgba(255,236,190,0.55)'); grad.addColorStop(1, 'rgba(255,230,170,0)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
  const halo = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const spot = new THREE.SpotLight(0xfff1d6, INTENSITY, 0, 0.5, 0.55, 2);
    spot.position.set(sx * mast.x, mast.h, sz * mast.z);
    spot.target.position.set(0, 0, 0);
    const s = new THREE.Sprite(halo);
    s.position.set(sx * (mast.x - 1.5), mast.h + 0.6, sz * (mast.z - 1.5));
    s.scale.setScalar(11);
    g.add(spot, spot.target, s);
  }
  return g;
}

/** Free the glow texture and material (the lights have no GPU resources). */
export function disposeFloodlights(g: THREE.Group) {
  g.traverse((o) => { const s = o as THREE.Sprite; if (s.isSprite) { s.material.map?.dispose(); s.material.dispose(); } });
}
