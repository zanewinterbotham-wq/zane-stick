import { HUMANOID, rng, type Vec3 } from './humanoid';

export type Quat = [number, number, number, number]; // x y z w

export interface Placement { offset: Vec3; yaw: number }

export interface WorldOpts { hz: number; ccd: boolean; humanoids: Placement[]; iterations?: number }

/** What every adapter must expose. Kept tiny on purpose. */
export interface BenchWorld {
  nHumanoids: number;
  setLinVel(h: number, v: Vec3): void;
  /** Equal-and-opposite world-frame torque on the joint's parent and child bodies for the next step. */
  applyJointTorque(h: number, j: number, t: Vec3): void;
  step(): void;
  pos(h: number, b: number): Vec3;
  quat(h: number, b: number): Quat;
  speed(h: number, b: number): number;
  /** Total contact normal force between bodies of different humanoids during the last step (N), or NaN if unsupported. */
  interHumanoidForce(): number;
  destroy(): void;
}

export interface BenchEngine {
  name: string;
  init(): Promise<void>;
  create(opts: WorldOpts): BenchWorld;
  /** 100 kg box resting on the ground: reported normal force (N), averaged over 0.5 s. NaN if unsupported. */
  restingForce(hz: number): number;
  /** 0.5 kg ball (r 4 cm) at 40 m/s toward a 5 cm wall. Returns true if it tunnelled through. */
  tunnels(hz: number, ccd: boolean): boolean;
  /** 10 kg, 1 m rod on a motorised hinge, motor holds horizontal with the given torque limit. Returns sag (rad) after 1 s. */
  motorSag(hz: number, torqueLimit: number): number;
  notes: string[];
}

export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export function qrot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export const yawQuat = (yaw: number): Quat => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** World-space rest pose for one placed humanoid. */
export function place(p: Placement) {
  const q = yawQuat(p.yaw);
  const bodies = HUMANOID.bodies.map((b) => add(qrot(q, b.pos), p.offset));
  const anchors = HUMANOID.joints.map((j) => add(qrot(q, j.anchor), p.offset));
  const axes = HUMANOID.joints.map((j) => (j.axis ? qrot(q, j.axis) : null));
  // Joint anchor in each body's local frame (all bodies share rotation q at rest).
  const local = HUMANOID.joints.map((j) => {
    const par = HUMANOID.bodies[j.child].parent;
    return { parent: sub(j.anchor, HUMANOID.bodies[par].pos), child: sub(j.anchor, HUMANOID.bodies[j.child].pos) };
  });
  return { q, bodies, anchors, axes, local };
}

/** Max distance (m) between where parent and child think each joint anchor is. */
export function jointError(w: BenchWorld, h: number): number {
  let worst = 0;
  HUMANOID.joints.forEach((j, ji) => {
    const par = HUMANOID.bodies[j.child].parent;
    const l = place({ offset: [0, 0, 0], yaw: 0 }).local[ji];
    const a = add(w.pos(h, par), qrot(w.quat(h, par), l.parent));
    const b = add(w.pos(h, j.child), qrot(w.quat(h, j.child), l.child));
    worst = Math.max(worst, len(sub(a, b)));
  });
  return worst;
}

/** Random world-frame joint torques, rerolled every 0.1 s, identical for every engine. */
export function torqueDriver(seed: number, hz: number, nH: number) {
  const r = rng(seed);
  const reroll = Math.max(1, Math.round(hz * 0.1));
  let cur: Vec3[][] = [];
  let n = 0;
  return (w: BenchWorld, axesFor: (h: number, j: number) => Vec3 | null) => {
    if (n++ % reroll === 0) {
      cur = [];
      for (let h = 0; h < nH; h++) {
        cur.push(HUMANOID.joints.map((j, ji) => {
          const ax = axesFor(h, ji);
          if (ax) { const s = (2 * r() - 1) * j.tmax; return [ax[0] * s, ax[1] * s, ax[2] * s] as Vec3; }
          const d: Vec3 = [2 * r() - 1, 2 * r() - 1, 2 * r() - 1];
          const m = len(d) || 1, s = (r() * j.tmax) / m;
          return [d[0] * s, d[1] * s, d[2] * s] as Vec3;
        }));
      }
    }
    for (let h = 0; h < nH; h++) cur[h].forEach((t, j) => w.applyJointTorque(h, j, t));
  };
}

/** Hinge axis of joint j of humanoid h in world frame, from the parent body's current orientation. */
export function hingeAxisWorld(w: BenchWorld, h: number, j: number): Vec3 | null {
  const js = HUMANOID.joints[j];
  if (!js.axis) return null;
  return qrot(w.quat(h, HUMANOID.bodies[js.child].parent), js.axis);
}

export function hashWorld(w: BenchWorld): string {
  const arr: number[] = [];
  for (let h = 0; h < w.nHumanoids; h++) for (let b = 0; b < HUMANOID.bodies.length; b++) arr.push(...w.pos(h, b), ...w.quat(h, b));
  const f = new Float64Array(arr), u = new Uint8Array(f.buffer);
  let x = 0x811c9dc5;
  for (const byte of u) x = Math.imul(x ^ byte, 0x01000193) >>> 0;
  return x.toString(16).padStart(8, '0');
}
