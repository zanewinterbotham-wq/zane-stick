// Small allocation-light vector/quaternion helpers. Frame: Y up, athlete faces +Z, +X is the athlete's left.
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x y z w

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const deg = (d: number) => (d * Math.PI) / 180;
export function norm(a: Vec3): Vec3 {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export function qrot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
export function qaxis(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2), n = norm(axis);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
}
/** Rotation vector (axis × angle) of q, angle in (-π, π]. */
export function qlog(q: Quat): Vec3 {
  const w = q[3] < 0 ? -1 : 1; // shortest arc
  const x = q[0] * w, y = q[1] * w, z = q[2] * w, c = q[3] * w;
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return [2 * x, 2 * y, 2 * z];
  const a = 2 * Math.atan2(s, c);
  return [(x / s) * a, (y / s) * a, (z / s) * a];
}
/** Heading angle about +Y of a forward (+Z) vector. 0 = facing +Z, positive turns toward +X. */
export const headingOf = (f: Vec3) => Math.atan2(f[0], f[2]);
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
