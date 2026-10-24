// Over-the-shoulder chase camera: orbits a pivot that follows the pelvis (never the head, so it never shakes
// with the head); the helmet view is pinned to the eyes instead. Yaw and pitch come from the mouse, or trail the
// athlete's heading in automatic mode.
// Shake and a punch toward the hit are added on top and decay.
import * as THREE from 'three';
import type { World } from '../sim/world';

/** Orbit pitch (rad, + = above looking down): default and limits. The default aims level for the arms. */
export const PITCH0 = 0.22;
// up to ~86° above level (the arms then reach straight overhead) and ~65° below
const PITCH_MIN = PITCH0 - 1.5, PITCH_MAX = 1.35;
/** Distance behind the pivot, pivot height above the pelvis and shoulder offset to the right (m). */
const DIST = 3.0, PIVOT_UP = 0.75, SHOULDER = 0.55;
/** Helmet view: eyes below and ahead of the helmet centre (head frame, m), and how far the look turns off the body
 *  (neck ~80° plus the eyes). */
const EYE = [0, -0.02, 0.07], HELMET_YAW = 1.7;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Automatic-camera yaw step. Looks along the smoothed travel direction (vx, vz, m/s) once he moves, and along his
 *  body facing only when nearly stopped, so a spin (facing turning fast, travel steady) never turns the view.
 *  Turns faster the further the view is off his travel, so he stays on screen. */
export function autoYaw(yaw: number, heading: number, vx: number, vz: number, headingRate: number, dt: number): number {
  const speed = Math.hypot(vx, vz);
  const wMove = Math.min(1, Math.max(0, (speed - 0.6) / 1.4));
  // facing counts less the faster the body is spinning (full below ~2 rad/s, none above ~5)
  const wFace = (1 - wMove) * Math.min(1, Math.max(0, (5 - Math.abs(headingRate)) / 3));
  const toMove = wrap(Math.atan2(vx, vz) - yaw);
  const turn = wMove * toMove + wFace * wrap(heading - yaw);
  const rate = 3 + 7 * Math.min(1, Math.abs(toMove) / 1.0) * wMove; // 3 /s, up to 10 /s when well off his travel
  return yaw + turn * (1 - Math.exp(-dt * rate));
}

export class ChaseCamera {
  private lastP: THREE.Vector3 | null = null;
  private lastHeading = 0;
  private vSm = new THREE.Vector2();
  private headingRate = 0;
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
  /** Side shuffle on: the automatic camera keeps looking forward (he faces the camera's way and strafes, so following
   *  his travel would turn the view he is facing along). */
  shuffle = false;

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

  /** `pose`: the target athlete's segment poses this frame (the renderer's interpolated ones), else his physics state. */
  update(cam: THREE.PerspectiveCamera, w: World, dt: number, heading: number, pose?: { segPos: ArrayLike<number>; segQuat: ArrayLike<number> }) {
    const a = w.athletes[this.target];
    const s = pose ?? w.scene.athletes[this.target].state;
    const pi = a.segIndex.get('pelvis')!;
    const p = new THREE.Vector3(s.segPos[3 * pi], s.segPos[3 * pi + 1], s.segPos[3 * pi + 2]);
    if (this.follow) {
      const k = 1 - Math.exp(-dt * 3);
      if (dt > 0 && this.lastP) {
        const vx = (p.x - this.lastP.x) / dt, vz = (p.z - this.lastP.z) / dt, a = 1 - Math.exp(-dt / 0.2);
        if (Math.hypot(vx, vz) > 20) this.vSm.set(0, 0); // teleport (new rep), not motion
        else this.vSm.x += (vx - this.vSm.x) * a, this.vSm.y += (vz - this.vSm.y) * a;
        this.headingRate += (wrap(heading - this.lastHeading) / dt - this.headingRate) * (1 - Math.exp(-dt / 0.1));
      }
      this.lastP = p.clone(); this.lastHeading = heading;
      if (!this.shuffle) this.yaw = autoYaw(this.yaw, heading, this.vSm.x, this.vSm.y, this.headingRate, dt);
      this.pitch += (PITCH0 - this.pitch) * k;
    }
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    if (this.mode === 'helmet') {
      // pinned to the eyes every frame (no spring: any lag lets the view drift out of the head); the look turns
      // at most HELMET_YAW off the body's heading, as a neck would
      const hi = a.segIndex.get('head')!, h = a.plan.segments[hi], c = h.geoms.find((g) => g.role === 'helmet')?.pos ?? h.com;
      const eye = new THREE.Vector3(c[0] - h.origin[0], c[1] - h.origin[1] + EYE[1], c[2] - h.origin[2] + EYE[2])
        .applyQuaternion(new THREE.Quaternion(s.segQuat[4 * hi], s.segQuat[4 * hi + 1], s.segQuat[4 * hi + 2], s.segQuat[4 * hi + 3]));
      this.pos.set(s.segPos[3 * hi], s.segPos[3 * hi + 1], s.segPos[3 * hi + 2]).add(eye);
      this.vel.set(0, 0, 0);
      const off = Math.atan2(Math.sin(this.yaw - heading), Math.cos(this.yaw - heading));
      this.yaw = heading + Math.max(-HELMET_YAW, Math.min(HELMET_YAW, off));
      cam.position.copy(this.pos);
      const e = this.pitch - PITCH0 + 0.08, ce = Math.cos(e);
      cam.lookAt(this.pos.clone().add(new THREE.Vector3(Math.sin(this.yaw) * ce, -Math.sin(e), Math.cos(this.yaw) * ce)));
    } else if (this.mode === 'side') {
      spring(this.pos, this.vel, p.clone().add(new THREE.Vector3(-4.2, 0.4, 0)), 10, dt); // fixed world side view (analysis)
      cam.position.copy(this.pos);
      cam.lookAt(p);
    } else {
      // rotation is applied directly (mouse look must not lag); only the pivot is smoothed
      spring(this.pivot, this.pivotVel, p.clone().setY(p.y + PIVOT_UP), 60, dt);
      const at = this.pivot.clone().addScaledVector(right, SHOULDER);
      // looking up, the camera slides in toward the pivot instead of into the turf
      const dist = dir.y > 0 ? Math.max(0.3, Math.min(DIST, (at.y - 0.3) / dir.y)) : DIST;
      cam.position.copy(at).addScaledVector(dir, -dist);
      cam.position.y = Math.max(0.3, cam.position.y);
      cam.lookAt(at.addScaledVector(dir, 4));
    }
    const k = this.mode === 'helmet' ? 0.25 : 1; // the helmet view stays near the eyes even on a big hit
    cam.position.addScaledVector(this.punchOff, k);
    this.punchOff.multiplyScalar(Math.exp(-dt * 10));
    if (this.shake > 0.001) {
      cam.position.x += (Math.random() - 0.5) * this.shake * k;
      cam.position.y += (Math.random() - 0.5) * this.shake * k;
      this.shake *= Math.exp(-dt * 9);
    }
  }

  /** Start of a rep: look along the athlete's heading. */
  snap(cam: THREE.PerspectiveCamera, w: World, heading: number) {
    this.yaw = heading; this.pitch = PITCH0;
    this.vel.set(0, 0, 0); this.pivotVel.set(0, 0, 0);
    this.lastP = null; this.vSm.set(0, 0); this.headingRate = 0;
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

/** Ghost camera for instant replay and photo mode: flies freely (not tied to any athlete, through bodies), turns like
 *  the chase camera (x > 0 turns right, y > 0 looks down), never below the turf. */
export class FreeCamera {
  pos = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  /** Flying speed (m/s), set by the wheel. */
  speed = 6;

  /** Start from where `cam` is and looks now. */
  from(cam: THREE.Camera) {
    const d = cam.getWorldDirection(new THREE.Vector3());
    this.pos.copy(cam.position);
    this.yaw = Math.atan2(d.x, d.z);
    this.pitch = -Math.asin(Math.max(-1, Math.min(1, d.y)));
  }
  look(x: number, y: number) {
    this.yaw -= x;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + y));
  }
  /** Wheel delta (pixels): scrolling up flies faster. */
  wheel(dy: number) { this.speed = Math.max(0.5, Math.min(40, this.speed * Math.exp(-dy * 0.002))); }
  /** Fly `dt` s: x right, y forward (along the view, so looking down flies down), z up; each −1..1, `fast` ×3. */
  update(cam: THREE.Camera, x: number, y: number, z: number, dt: number, fast = false) {
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const v = this.speed * (fast ? 3 : 1) * dt;
    this.pos.addScaledVector(dir, y * v).addScaledVector(right, x * v);
    this.pos.y = Math.max(0.05, this.pos.y + z * v);
    cam.position.copy(this.pos);
    cam.lookAt(this.pos.clone().add(dir));
    cam.updateMatrixWorld();
  }
}
