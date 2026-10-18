// Engine-neutral test humanoid for the engine benchmark (Y up, facing +Z, metres/kg).
// Deliberately simpler than the game's anatomy model: the point is to load every engine the same way.

export type Vec3 = [number, number, number];
export type Shape =
  | { type: 'box'; half: Vec3 }
  | { type: 'capsule'; r: number; hl: number } // axis along local Y, hl = half length of the cylinder part
  | { type: 'sphere'; r: number };

export interface BodySpec { name: string; parent: number; pos: Vec3; shape: Shape; mass: number }
export interface JointSpec {
  child: number; // index of child body; parent = bodies[child].parent
  type: 'ball' | 'hinge';
  anchor: Vec3; // world, rest pose
  axis?: Vec3; // hinge axis (world)
  lo?: number; hi?: number; // hinge limits (rad)
  swing?: number; twist?: number; // ball: cone half angle and ± twist (rad)
  tmax: number; // peak joint torque used by the random-torque stress test (N·m)
}

const b = (name: string, parent: number, pos: Vec3, shape: Shape, mass: number): BodySpec => ({ name, parent, pos, shape, mass });

export function makeHumanoid(): { bodies: BodySpec[]; joints: JointSpec[] } {
  const bodies: BodySpec[] = [
    b('pelvis', -1, [0, 1.0, 0], { type: 'box', half: [0.16, 0.09, 0.11] }, 11),
    b('torso', 0, [0, 1.35, 0], { type: 'box', half: [0.19, 0.25, 0.12] }, 33),
    b('head', 1, [0, 1.73, 0], { type: 'sphere', r: 0.11 }, 7),
  ];
  const joints: JointSpec[] = [
    { child: 1, type: 'ball', anchor: [0, 1.09, 0], swing: 0.6, twist: 0.5, tmax: 300 },
    { child: 2, type: 'ball', anchor: [0, 1.61, 0], swing: 0.7, twist: 1.2, tmax: 60 },
  ];
  for (const s of [-1, 1]) {
    const ua = bodies.push(b('upperarm', 1, [0.25 * s, 1.41, 0], { type: 'capsule', r: 0.05, hl: 0.1 }, 3)) - 1;
    joints.push({ child: ua, type: 'ball', anchor: [0.25 * s, 1.56, 0], swing: 1.4, twist: 1.0, tmax: 110 });
    const fa = bodies.push(b('forearm', ua, [0.25 * s, 1.11, 0], { type: 'capsule', r: 0.04, hl: 0.11 }, 2.2)) - 1;
    joints.push({ child: fa, type: 'hinge', anchor: [0.25 * s, 1.26, 0], axis: [1, 0, 0], lo: -2.6, hi: 0, tmax: 90 });
    const th = bodies.push(b('thigh', 0, [0.09 * s, 0.735, 0], { type: 'capsule', r: 0.08, hl: 0.135 }, 14)) - 1;
    joints.push({ child: th, type: 'ball', anchor: [0.09 * s, 0.95, 0], swing: 1.2, twist: 0.7, tmax: 320 });
    const sh = bodies.push(b('shank', th, [0.09 * s, 0.305, 0], { type: 'capsule', r: 0.055, hl: 0.16 }, 4.5)) - 1;
    joints.push({ child: sh, type: 'hinge', anchor: [0.09 * s, 0.52, 0], axis: [1, 0, 0], lo: 0, hi: 2.4, tmax: 300 });
    const ft = bodies.push(b('foot', sh, [0.09 * s, 0.045, 0.05], { type: 'box', half: [0.05, 0.04, 0.13] }, 1.4)) - 1;
    joints.push({ child: ft, type: 'hinge', anchor: [0.09 * s, 0.09, 0], axis: [1, 0, 0], lo: -0.6, hi: 0.4, tmax: 220 });
  }
  // Scale to exactly 100 kg (the spec's collision test uses two 100 kg bodies).
  const total = bodies.reduce((a, x) => a + x.mass, 0);
  for (const x of bodies) x.mass *= 100 / total;
  return { bodies, joints };
}

export const HUMANOID = makeHumanoid();

/** Mulberry32 — tiny seeded PRNG so every engine sees the same torque sequence. */
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
