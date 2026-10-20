// Where a loose ball in the air will come down: a target ring on the turf that shrinks as the ball nears it, and the
// angle it comes in at: a rod up its incoming path with an arrowhead at the spot, and the angle in degrees.
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

/** How the ball arrives there: its velocity at the landing (m/s) and its angle below the horizontal (rad; π/2 straight
 *  down); null if it is already down. */
export function arrival(pos: readonly number[], vel: readonly number[], g = G, restY = REST_Y) {
  const L = landing(pos, vel, g, restY);
  if (!L) return null;
  const v: [number, number, number] = [vel[0], vel[1] - g * L.t, vel[2]];
  return { ...L, v, angle: Math.atan2(-v[1], Math.hypot(v[0], v[2])) };
}

/** The incoming rod's length (m) and the angle label's step (degrees: one texture per step). */
const ROD = 2.2, DEG_STEP = 5;

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
    // the incoming path: a rod from the spot back up the arrival direction (not scaled with the ring), an arrowhead
    // at the spot pointing the way the ball travels, and the angle; dark-cored so it reads on grass and sky
    const solid = (color: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, fog: false });
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, ROD, 8).translate(0, ROD / 2, 0), solid(0xffffff));
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.32, 12).translate(0, 0.16, 0), solid(0xffd23a));
    for (const m of [rod, head]) { m.castShadow = m.receiveShadow = false; m.renderOrder = 5; this.path.add(m); }
    head.rotation.x = Math.PI; // tip down, at the spot (the group's y axis points back up the path)
    this.label.renderOrder = 6;
    this.path.add(this.label);
    this.path.visible = false;
  }
  /** The incoming path (rod, arrowhead, angle label) and the label's sprite (its texture per DEG_STEP). */
  readonly path = new THREE.Group();
  private label = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, fog: false, sizeAttenuation: false }));
  private tex = new Map<number, THREE.CanvasTexture>();
  private shown = -1;
  private up = new THREE.Vector3(0, 1, 0); private dir = new THREE.Vector3();

  private angleTexture(deg: number) {
    let t = this.tex.get(deg);
    if (t) return t;
    const c = document.createElement('canvas'); c.width = 128; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(16,22,30,0.85)'; g.beginPath(); g.roundRect(4, 8, 120, 48, 24); g.fill();
    g.fillStyle = '#ffd23a'; g.font = '700 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(`${deg}°`, 64, 34);
    t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    this.tex.set(deg, t);
    return t;
  }

  update(w: World) {
    const bi = w.ballIndex;
    let L = null;
    if (bi >= 0 && w.ballCarrier < 0) {
      const p = w.scene.propPose(bi).pos;
      if (p[1] > FLIGHT_Y) L = arrival(p, w.scene.propVel(bi));
    }
    this.root.visible = this.path.visible = !!L;
    if (!L) return;
    const r = ringRadius(L.t);
    this.root.position.set(L.x, 0, L.z);
    this.root.scale.set(r, 1, r);
    // the path group's y axis points back up the incoming direction, from the spot
    this.path.position.set(L.x, 0.03, L.z);
    this.dir.set(-L.v[0], -L.v[1], -L.v[2]).normalize();
    this.path.quaternion.setFromUnitVectors(this.up, this.dir);
    const deg = Math.round((L.angle * 180) / Math.PI / DEG_STEP) * DEG_STEP;
    if (deg !== this.shown) { this.shown = deg; this.label.material.map = this.angleTexture(deg); this.label.material.needsUpdate = true; }
    this.label.position.set(0, ROD + 0.35, 0);
    this.label.scale.set(0.07, 0.035, 1);
  }
}
