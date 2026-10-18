import type { BodyPlan, GeomPlan } from './body';
import type { Vec3 } from '../math';

function aabb(g: GeomPlan): [Vec3, Vec3] {
  if (g.type === 'capsule') {
    const [a, b] = g.fromto!, r = g.size[0];
    return [[0, 1, 2].map((i) => Math.min(a[i], b[i]) - r) as Vec3, [0, 1, 2].map((i) => Math.max(a[i], b[i]) + r) as Vec3];
  }
  const h = g.type === 'sphere' ? [g.size[0], g.size[0], g.size[0]] : g.size;
  return [[0, 1, 2].map((i) => g.pos![i] - h[i]) as Vec3, [0, 1, 2].map((i) => g.pos![i] + h[i]) as Vec3];
}
const overlap = (a: [Vec3, Vec3], b: [Vec3, Vec3], m: number) => [0, 1, 2].every((i) => a[0][i] - m < b[1][i] && b[0][i] - m < a[1][i]);

/** Pairs of own segments that must not collide: those whose shapes overlap in the rest pose
 *  (e.g. upper arm inside the shoulder pads). Parent–child pairs are excluded by the engine. */
export function selfCollisionExcludes(plan: BodyPlan, margin = 0.01): [string, string][] {
  const out: [string, string][] = [];
  const S = plan.segments;
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
    if (S[i].parent === S[j].name || S[j].parent === S[i].name) continue;
    if (S[i].geoms.some((a) => S[j].geoms.some((b) => overlap(aabb(a), aabb(b), margin)))) out.push([S[i].name, S[j].name]);
  }
  return out;
}
