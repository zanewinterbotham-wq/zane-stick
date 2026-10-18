// Joint actuators ("muscles"): every joint axis has a peak torque per direction, and the torque
// available falls as the joint moves faster in the direction it is pushing (Hill torque–velocity) [S4].
// Controllers (hand-built or learned) send MuscleTargets; nothing can exceed these limits.

import type { BodyPlan } from './anatomy/body';
import { HILL } from './anatomy/data';
import { cross, dot, sub, type Vec3 } from './math';

const HILL_K = HILL.k, ECC_MAX = HILL.eccMax;

/** f_v(x), x = shortening velocity / max velocity. 1 at rest, 0 at x = 1, up to ECC_MAX when lengthening. */
export function forceVelocity(x: number): number {
  if (x >= 0) return x >= 1 ? 0 : (1 - x) / (1 + x / HILL_K);
  const e = Math.max(x, -1);
  return ECC_MAX - (ECC_MAX - 1) * (1 + e) / (1 - 5 * e);
}

/** Per-dof targets a controller sends every step (plan dof order). */
export interface MuscleTargets {
  q: Float64Array;    // target joint angle (rad)
  kp: Float64Array;   // stiffness (N·m/rad)
  kd: Float64Array;   // damping (N·m·s/rad)
  tff: Float64Array;  // feed-forward torque (N·m)
}
export const newTargets = (n: number): MuscleTargets => ({ q: new Float64Array(n), kp: new Float64Array(n), kd: new Float64Array(n), tff: new Float64Array(n) });

export class MuscleSet {
  readonly n: number;
  readonly tPos: Float64Array; readonly tNeg: Float64Array; readonly wMax: Float64Array;
  readonly lo: Float64Array; readonly hi: Float64Array;
  /** Rest-pose inertia of everything distal to each dof about its axis (kg·m²): sets swing-limb gains. */
  readonly ieff: Float64Array;
  /** Inertia of the child segment alone about each dof axis (kg·m²): the lightest thing a joint can
   *  spin, which bounds the explicit stiffness that stays numerically stable. */
  readonly ilocal: Float64Array;
  readonly names: string[];
  /** Output of the last compute(): explicit torque (N·m), implicit damping gain (N·m·s/rad), and
   *  effort (|total muscle torque| / peak, 0..1). Total muscle torque = torque − damping·qd. */
  readonly torque: Float64Array; readonly damping: Float64Array; readonly effort: Float64Array;
  strengthScale = 1;

  constructor(plan: BodyPlan) {
    const dofs = plan.joints.flatMap((j) => j.dofs.map((d) => ({ j, d })));
    this.n = dofs.length;
    this.names = dofs.map(({ j, d }) => `${j.name}.${d.name}`);
    this.tPos = Float64Array.from(dofs.map((x) => x.d.tPos));
    this.tNeg = Float64Array.from(dofs.map((x) => x.d.tNeg));
    this.wMax = Float64Array.from(dofs.map((x) => x.d.wMax));
    this.lo = Float64Array.from(dofs.map((x) => x.d.range[0]));
    this.hi = Float64Array.from(dofs.map((x) => x.d.range[1]));
    this.ieff = Float64Array.from(dofs.map(({ j, d }) => distalInertia(plan, j.child, j.pos, d.axis)));
    this.ilocal = Float64Array.from(dofs.map(({ j, d }) => distalInertia(plan, j.child, j.pos, d.axis, false)));
    this.torque = new Float64Array(this.n); this.damping = new Float64Array(this.n); this.effort = new Float64Array(this.n);
  }

  index(name: string) { return this.names.indexOf(name); }

  /** Available torque in direction `sign` at joint velocity `qd`. */
  available(i: number, sign: number, qd: number) {
    const t0 = (sign >= 0 ? this.tPos[i] : this.tNeg[i]) * this.strengthScale;
    return t0 * forceVelocity((sign >= 0 ? qd : -qd) / this.wMax[i]);
  }

  /** PD + feed-forward, clamped to what the muscle can produce at this joint speed. The damping part is
   *  returned separately (integrated implicitly by the engine) and is cut back first if the total would
   *  exceed the muscle's capacity. */
  compute(t: MuscleTargets, q: Float64Array, qd: Float64Array): void {
    for (let i = 0; i < this.n; i++) {
      let explicit = t.kp[i] * (t.q[i] - q[i]) + t.tff[i];
      let kd = t.kd[i];
      const damp = -kd * qd[i];
      const total = explicit + damp;
      const cap = this.available(i, total, qd[i]);
      if (Math.abs(total) > cap) {
        if (Math.abs(damp) >= cap) { kd = cap / Math.max(1e-6, Math.abs(qd[i])); explicit = 0; }
        else explicit = (total >= 0 ? cap : -cap) - damp;
      }
      this.torque[i] = explicit;
      this.damping[i] = kd;
      const applied = explicit - kd * qd[i];
      const peak = (applied >= 0 ? this.tPos[i] : this.tNeg[i]) * this.strengthScale;
      this.effort[i] = peak > 0 ? Math.min(1, Math.abs(applied) / peak) : 0;
    }
  }
}

/** Σ over the subtree distal to `seg`: segment inertia about the axis through `pivot` (rest pose). */
function distalInertia(plan: BodyPlan, seg: string, pivot: Vec3, axis: Vec3, subtree = true): number {
  let total = 0;
  const visit = (name: string) => {
    const s = plan.segments.find((x) => x.name === name)!;
    const I = s.inertia;
    const Ia = axis[0] * (I[0] * axis[0] + I[1] * axis[1] + I[2] * axis[2]) + axis[1] * (I[3] * axis[0] + I[4] * axis[1] + I[5] * axis[2]) + axis[2] * (I[6] * axis[0] + I[7] * axis[1] + I[8] * axis[2]);
    const r = sub(s.com, pivot);
    const perp = cross(axis, r);
    total += Ia + s.mass * dot(perp, perp);
    if (subtree) for (const k of plan.segments) if (k.parent === name) visit(k.name);
  };
  visit(seg);
  return total;
}
