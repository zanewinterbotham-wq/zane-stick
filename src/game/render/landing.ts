// Where a loose ball in the air will come down: a target ring on the turf that shrinks as the ball nears it.
// Purely visual: reads the ball's pose and velocity, never writes the sim.
import * as THREE from 'three';
import type { World } from '../../sim/world';
import { BALL } from '../../sim/anatomy/equipment';

const G = 9.81; // the scene has gravity only: no air drag on the ball (physics/mujoco.ts), so the flight is a parabola
const REST_Y = BALL.diameter / 2; // centre height of the ball lying on the turf
/** Ring radius (m): wide for a fresh kick, tight as it lands. */
export const RING = { near: 0.4, far: 3, farT: 3 };
/** Below this centre height (m) the ball is rolling or held, not flying. */
const FLIGHT_Y = 0.3;

/** Seconds until a ball at `pos` with velocity `vel` is back at rest height, and where; null if it is already down. */
export function landing(pos: readonly number[], vel: readonly number[], g = G, restY = REST_Y): { t: number; x: number; z: number } | null {
  const h = pos[1] - restY;
  if (h < 0) return null;
  const t = (vel[1] + Math.sqrt(vel[1] * vel[1] + 2 * g * h)) / g;
  return { t, x: pos[0] + vel[0] * t, z: pos[2] + vel[2] * t };
}

/** Ring radius for `t` seconds to landing: linear from `near` at 0 to `far` at `farT`. */
export const ringRadius = (t: number) => RING.near + (RING.far - RING.near) * Math.min(Math.max(t / RING.farT, 0), 1);

export class LandingMarker {
  readonly root = new THREE.Group();
  constructor() {
    // unit-radius pieces scaled each frame: a dark outline ring under a bright ring and a faint fill, all flat on the turf
    const mat = (color: number, opacity: number) => new THREE.MeshBasicMaterial({ color, opacity, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false });
    const flat = (geo: THREE.BufferGeometry, m: THREE.Material, y: number, order: number) => {
      const mesh = new THREE.Mesh(geo.rotateX(-Math.PI / 2), m);
      mesh.position.y = y; mesh.castShadow = mesh.receiveShadow = false; mesh.renderOrder = order; // drawn in layer order: transparent sorting would put the outline over the ring
      this.root.add(mesh);
    };
    flat(new THREE.CircleGeometry(0.78, 40), mat(0xffd23a, 0.22), 0.02, 2);
    flat(new THREE.RingGeometry(0.7, 1.08, 48), mat(0x10161e, 0.85), 0.025, 3);
    flat(new THREE.RingGeometry(0.78, 1, 48), mat(0xffd23a, 1), 0.03, 4);
    this.root.visible = false;
  }

  update(w: World) {
    const bi = w.ballIndex;
    let L = null;
    if (bi >= 0 && w.ballCarrier < 0) {
      const p = w.scene.propPose(bi).pos;
      if (p[1] > FLIGHT_Y) L = landing(p, w.scene.propVel(bi));
    }
    this.root.visible = !!L;
    if (!L) return;
    const r = ringRadius(L.t);
    this.root.position.set(L.x, 0, L.z);
    this.root.scale.set(r, 1, r);
  }
}
