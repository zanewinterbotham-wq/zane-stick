import type { Vec3 } from '../math';

/** Symmetric 3×3 inertia tensor, row-major [xx, xy, xz, yx, yy, yz, zx, zy, zz]. */
export type Mat3 = number[];

export const diag = (d: Vec3): Mat3 => [d[0], 0, 0, 0, d[1], 0, 0, 0, d[2]];
export const madd = (a: Mat3, b: Mat3): Mat3 => a.map((x, i) => x + b[i]);
export const msub = (a: Mat3, b: Mat3): Mat3 => a.map((x, i) => x - b[i]);

/** Parallel-axis term m(|d|²I − d dᵀ) for a point mass offset d from the reference point. */
export function parallel(m: number, d: Vec3): Mat3 {
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const r: Mat3 = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(m * ((i === j ? dd : 0) - d[i] * d[j]));
  return r;
}

export const boxInertia = (m: number, half: Vec3): Vec3 => {
  const [a, b, c] = half.map((h) => 2 * h);
  return [(m / 12) * (b * b + c * c), (m / 12) * (a * a + c * c), (m / 12) * (a * a + b * b)];
};
/** Solid cylinder with its axis along `axis` (0=x, 1=y, 2=z). */
export function cylinderInertia(m: number, r: number, l: number, axis: 0 | 1 | 2): Vec3 {
  const t = (m / 12) * (3 * r * r + l * l), a = 0.5 * m * r * r;
  const d: Vec3 = [t, t, t];
  d[axis] = a;
  return d;
}

/** Check that a tensor is a physically valid inertia (positive definite, triangle inequality on the diagonal). */
export function validInertia(I: Mat3): boolean {
  const [a, b, c] = [I[0], I[4], I[8]];
  if (!(a > 0 && b > 0 && c > 0)) return false;
  if (a + b < c * 0.999 || a + c < b * 0.999 || b + c < a * 0.999) return false;
  const det = I[0] * (I[4] * I[8] - I[5] * I[7]) - I[1] * (I[3] * I[8] - I[5] * I[6]) + I[2] * (I[3] * I[7] - I[4] * I[6]);
  return det > 0;
}
