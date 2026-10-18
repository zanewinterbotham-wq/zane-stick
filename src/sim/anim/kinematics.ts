// Forward kinematics of a body plan for a set of joint angles: where every segment would be if the pose were
// reached exactly. Used by tests and tools to check animation frames without running the physics.
import type { BodyPlan } from '../anatomy/body';
import { add, qaxis, qmul, qrot, sub, type Quat, type Vec3 } from '../math';

/** Pelvis orientation the animator assumes for a root target (same convention as the controllers). */
export const rootQuat = (heading: number, pitch: number, roll: number): Quat =>
  qmul(qaxis([0, 1, 0], heading), qmul(qaxis([1, 0, 0], pitch), qaxis([0, 0, -1], roll)));

export interface Pose { pos: Vec3[]; quat: Quat[] }

/** Segment origins and orientations (world) for joint angles `q` (plan dof order), with the root segment's
 *  origin at `rootPos` and orientation `rootRot`. Multi-dof joints compose in listed order, first outermost
 *  (as the physics engine does). */
export function forwardKinematics(plan: BodyPlan, q: ArrayLike<number>, rootPos: Vec3, rootRot: Quat): Pose {
  const n = plan.segments.length, pos: Vec3[] = new Array(n), quat: Quat[] = new Array(n);
  const idx = new Map(plan.segments.map((s, i) => [s.name, i]));
  const dofStart = new Map<string, number>();
  let k = 0;
  for (const j of plan.joints) { dofStart.set(j.child, k); k += j.dofs.length; }
  const visit = (i: number) => {
    for (const j of plan.joints) {
      const p = idx.get(j.parent)!;
      if (p !== i) continue;
      const c = idx.get(j.child)!, ps = plan.segments[p];
      let r = quat[p];
      j.dofs.forEach((d, m) => { r = qmul(r, qaxis(d.axis, q[dofStart.get(j.child)! + m])); });
      pos[c] = add(pos[p], qrot(quat[p], sub(j.pos, ps.origin)));
      quat[c] = r;
      visit(c);
    }
  };
  const root = plan.segments.findIndex((s) => s.parent === null);
  pos[root] = rootPos; quat[root] = rootRot;
  visit(root);
  return { pos, quat };
}

/** World position of a rest-pose point `x` attached to segment `seg`. */
export function pointOn(plan: BodyPlan, pose: Pose, seg: string, x: Vec3): Vec3 {
  const i = plan.segments.findIndex((s) => s.name === seg);
  return add(pose.pos[i], qrot(pose.quat[i], sub(x, plan.segments[i].origin)));
}
