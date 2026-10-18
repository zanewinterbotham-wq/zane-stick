// Chase camera: follows the pelvis (never the head), critically damped, so it never shakes with the head.
// Shake from big hits is added on top and decays.
import * as THREE from 'three';
import type { World } from '../sim/world';

export class ChaseCamera {
  private pos = new THREE.Vector3(0, 3, -6);
  private look = new THREE.Vector3(0, 1, 0);
  private vel = new THREE.Vector3();
  private lookVel = new THREE.Vector3();
  private shake = 0;
  mode: 'chase' | 'helmet' | 'side' = 'chase';
  target = 0;

  addShake(amount: number) { this.shake = Math.min(0.35, this.shake + amount); }

  update(cam: THREE.PerspectiveCamera, w: World, dt: number, heading: number) {
    const a = w.athletes[this.target];
    const s = w.scene.athletes[this.target].state;
    const pi = a.segIndex.get('pelvis')!;
    const p = new THREE.Vector3(s.segPos[3 * pi], s.segPos[3 * pi + 1], s.segPos[3 * pi + 2]);
    const fwd = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    let want: THREE.Vector3, lookAt: THREE.Vector3;
    if (this.mode === 'helmet') {
      const hi = a.segIndex.get('head')!;
      want = new THREE.Vector3(s.segPos[3 * hi], s.segPos[3 * hi + 1] + 0.12, s.segPos[3 * hi + 2]).addScaledVector(fwd, 0.05);
      lookAt = want.clone().addScaledVector(fwd, 5).setY(want.y - 0.4);
    } else if (this.mode === 'side') {
      want = p.clone().add(new THREE.Vector3(-4.2, 0.4, 0)); // fixed world side view (analysis)
      lookAt = p.clone();
    } else {
      want = p.clone().addScaledVector(fwd, -5.5).setY(p.y + 2.3);
      lookAt = p.clone().addScaledVector(fwd, 3).setY(p.y * 0.9);
    }
    const k = this.mode === 'helmet' ? 40 : 10;
    spring(this.pos, this.vel, want, k, dt);
    spring(this.look, this.lookVel, lookAt, k, dt);
    cam.position.copy(this.pos);
    if (this.shake > 0.001) {
      cam.position.x += (Math.random() - 0.5) * this.shake;
      cam.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-dt * 9);
    }
    cam.lookAt(this.look);
  }

  snap(cam: THREE.PerspectiveCamera, w: World, heading: number) {
    this.vel.set(0, 0, 0); this.lookVel.set(0, 0, 0);
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
