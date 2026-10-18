// Over-the-shoulder chase camera: orbits a pivot that follows the pelvis (never the head, so it never shakes
// with the head). Yaw and pitch come from the mouse, or trail the athlete's heading in automatic mode.
// Shake and a punch toward the hit are added on top and decay.
import * as THREE from 'three';
import type { World } from '../sim/world';

/** Orbit pitch (rad, + = above looking down): default and limits. The default aims level for the arms. */
export const PITCH0 = 0.22;
const PITCH_MIN = -0.25, PITCH_MAX = 1.0;
/** Distance behind the pivot, pivot height above the pelvis and shoulder offset to the right (m). */
const DIST = 3.0, PIVOT_UP = 0.75, SHOULDER = 0.55;

export class ChaseCamera {
  private pivot = new THREE.Vector3(0, 1.6, 0);
  private pivotVel = new THREE.Vector3();
  private pos = new THREE.Vector3(0, 3, -6);
  private vel = new THREE.Vector3();
  private shake = 0;
  private punchOff = new THREE.Vector3();
  mode: 'chase' | 'helmet' | 'side' = 'chase';
  target = 0;
  /** World heading the camera looks along (rad, 0 = +Z) and orbit pitch. */
  yaw = 0;
  pitch = PITCH0;
  /** Automatic camera: yaw trails the athlete's heading; false = mouse / right stick look. */
  follow = true;

  /** Turn the view: x > 0 turns right, y > 0 looks down (rad). */
  look(x: number, y: number) {
    this.yaw -= x;
    this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitch + y));
  }
  /** Elevation of the aim above the horizontal (rad): the default view aims level. */
  get aimPitch() { return PITCH0 - this.pitch; }

  addShake(amount: number) { this.shake = Math.min(0.35, this.shake + amount); }
  /** Lurch the camera toward a hit (horizontal direction x, z). Called every contact step: keeps the largest. */
  punch(x: number, z: number, amount: number) {
    if (amount <= this.punchOff.length()) return;
    const n = Math.hypot(x, z) || 1;
    this.punchOff.set(x / n, 0, z / n).multiplyScalar(amount);
  }

  update(cam: THREE.PerspectiveCamera, w: World, dt: number, heading: number) {
    const a = w.athletes[this.target];
    const s = w.scene.athletes[this.target].state;
    const pi = a.segIndex.get('pelvis')!;
    const p = new THREE.Vector3(s.segPos[3 * pi], s.segPos[3 * pi + 1], s.segPos[3 * pi + 2]);
    if (this.follow) {
      const k = 1 - Math.exp(-dt * 3);
      this.yaw += Math.atan2(Math.sin(heading - this.yaw), Math.cos(heading - this.yaw)) * k;
      this.pitch += (PITCH0 - this.pitch) * k;
    }
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    if (this.mode === 'helmet') {
      const hi = a.segIndex.get('head')!;
      const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      spring(this.pos, this.vel, new THREE.Vector3(s.segPos[3 * hi], s.segPos[3 * hi + 1] + 0.12, s.segPos[3 * hi + 2]).addScaledVector(fwd, 0.05), 40, dt);
      cam.position.copy(this.pos);
      cam.lookAt(this.pos.clone().add(new THREE.Vector3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch - PITCH0 + 0.08), Math.cos(this.yaw) * cp)));
    } else if (this.mode === 'side') {
      spring(this.pos, this.vel, p.clone().add(new THREE.Vector3(-4.2, 0.4, 0)), 10, dt); // fixed world side view (analysis)
      cam.position.copy(this.pos);
      cam.lookAt(p);
    } else {
      // rotation is applied directly (mouse look must not lag); only the pivot is smoothed
      spring(this.pivot, this.pivotVel, p.clone().setY(p.y + PIVOT_UP), 60, dt);
      const at = this.pivot.clone().addScaledVector(right, SHOULDER);
      cam.position.copy(at).addScaledVector(dir, -DIST);
      cam.position.y = Math.max(0.3, cam.position.y);
      cam.lookAt(at.addScaledVector(dir, 4));
    }
    cam.position.add(this.punchOff);
    this.punchOff.multiplyScalar(Math.exp(-dt * 10));
    if (this.shake > 0.001) {
      cam.position.x += (Math.random() - 0.5) * this.shake;
      cam.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-dt * 9);
    }
  }

  /** Start of a rep: look along the athlete's heading. */
  snap(cam: THREE.PerspectiveCamera, w: World, heading: number) {
    this.yaw = heading; this.pitch = PITCH0;
    this.vel.set(0, 0, 0); this.pivotVel.set(0, 0, 0);
    for (let i = 0; i < 200; i++) this.update(cam, w, 0.05, heading);
  }
}

/** Critically damped spring step. */
function spring(x: THREE.Vector3, v: THREE.Vector3, target: THREE.Vector3, k: number, dt: number) {
  const w = Math.sqrt(k);
  const a = target.clone().sub(x).multiplyScalar(k).addScaledVector(v, -2 * w);
  v.addScaledVector(a, dt);
  x.addScaledVector(v, dt);
}
