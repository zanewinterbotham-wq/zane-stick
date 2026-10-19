// Leg inverse kinematics shared by the animator (same solution as HandController.legIK, which stays in hand.ts).
import { clamp, type Vec3 } from '../math';

export interface LegGeom { side: 1 | -1; L1: number; L2: number }

/** Hip flexion, abduction and knee flexion that put the ankle at `rel` (from the hip centre, pelvis frame) for
 *  a given hip internal rotation. Exact for the hip's flex → abd → rotation joint order: with the knee bent,
 *  rotation swings the shank sideways and abduction moves only the hip-to-knee-plane part of the leg. A target
 *  out of reach is pulled in to 99.5 % of the leg length. */
export function legIK(L: LegGeom, rel: Vec3, rot: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  legIKInto(L, rel[0], rel[1], rel[2], Math.hypot(rel[0], rel[1], rel[2]), Math.sin(rot), Math.cos(rot), out);
  return out;
}

/** legIK without allocations, for the animator's inner loops: `n` = |rel|, the rotation as its sine and cosine;
 *  writes hip flexion, abduction, knee flexion to out[0..2] (the same numbers, bit for bit). */
export function legIKInto(L: LegGeom, r0: number, r1: number, r2: number, n: number, sinRot: number, cosRot: number, out: number[]) {
  n ||= 1;
  const d = Math.min(n, (L.L1 + L.L2) * 0.995);
  const knee = Math.PI - Math.acos(clamp((L.L1 ** 2 + L.L2 ** 2 - d * d) / (2 * L.L1 * L.L2), -1, 1));
  // ankle in the hip frame before flexion: (side·(A·sin a + Bs·cos a), Bs·sin a − A·cos a, −B·cos r)
  const A = L.L1 + L.L2 * Math.cos(knee), B = L.L2 * Math.sin(knee), Bs = B * sinRot;
  const p0 = r0 * d / n, p1 = r1 * d / n, p2 = r2 * d / n;
  const abd = Math.asin(clamp(L.side * p0 / Math.hypot(A, Bs), -1, 1)) - Math.atan2(Bs, A);
  const fl = Math.atan2(-B * cosRot, Bs * Math.sin(abd) - A * Math.cos(abd)) - Math.atan2(p2, p1);
  out[0] = Math.atan2(Math.sin(fl), Math.cos(fl)); out[1] = abd; out[2] = knee;
}

/** Forward kinematics of the same chain: ankle relative to the hip centre, pelvis frame. */
export function legFK(L: LegGeom, flex: number, abd: number, knee: number, rot: number): Vec3 {
  const A = L.L1 + L.L2 * Math.cos(knee), B = L.L2 * Math.sin(knee);
  const x = L.side * (A * Math.sin(abd) + B * Math.sin(rot) * Math.cos(abd)), y = B * Math.sin(rot) * Math.sin(abd) - A * Math.cos(abd), z = -B * Math.cos(rot);
  return [x, y * Math.cos(flex) + z * Math.sin(flex), -y * Math.sin(flex) + z * Math.cos(flex)];
}
