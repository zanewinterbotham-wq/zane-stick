// Tracking motor controller (active ragdoll, design §6.5). The muscles track the animator's pose; the world's
// support carries the body along the animation's root target. When the support levels drop (player contact,
// knocked off balance) the targets blend toward the hand-built balance controller, so a hit athlete steps and
// fights for balance physically; they blend back once the support returns. Everything stays within the muscles.
import type { BodyPlan } from '../anatomy/body';
import { DEFAULT_SUPPORT, newFrame, type AnimFrame, type Animator, type RootTarget, type SupportSettings, type SupportState } from '../anim/types';
import { clamp, cross, dot, type Vec3 } from '../math';
import { newTargets, type MuscleSet, type MuscleTargets } from '../muscles';
import { ProceduralAnimator } from '../anim/procedural';
import { HandController } from './hand';
import type { BodyView, Commands, MotorController } from './types';

const G = 9.81;
/** Same stability reference as the hand controller: gains capped for the slowest preset (240 Hz). */
const DT_REF = 1 / 240;
/** Tracking natural frequency (rad/s) with the distal inertia, per body region. */
const WN = { leg: 35, arm: 20, trunk: 25 };
/** Without support (world without SupportSettings) the hand controller balances alone. */
const NO_SUPPORT: SupportState = { posture: 0, carry: 0, down: false };

export class TrackingController implements MotorController {
  /** The world's support tuning (World.create hands its own object in, so panel edits reach it). */
  supportSettings: SupportSettings = DEFAULT_SUPPORT;
  readonly frame: AnimFrame;
  readonly hand: HandController;
  private animator: Animator;
  private handOut: MuscleTargets;
  private trackOut: MuscleTargets;
  /** Weight of the hand controller's targets 0..1 (−1 until the first step). */
  private blend = -1;
  private mass: number;
  private wn: Float64Array;
  private kMin: Float64Array;
  private isLeg: Uint8Array;
  private chains: number[][];
  private carried: number[][];
  private segMass: Float64Array;
  private pelvisSeg: number;
  /** Fraction of time some foot carries the legs' share of the weight (low-passed): sizes the stance push. */
  private grounded = 0.6;
  private dbg: Record<string, number | string> = {};

  constructor(plan: BodyPlan, private muscles: MuscleSet, animator?: Animator) {
    this.animator = animator ?? new ProceduralAnimator(plan, muscles);
    this.hand = new HandController(plan, muscles);
    this.frame = newFrame(muscles.n);
    this.handOut = newTargets(muscles.n);
    this.trackOut = newTargets(muscles.n);
    this.mass = plan.segments.reduce((a, s) => a + s.mass, 0);
    const S = (n: string) => plan.segments.findIndex((s) => s.name === n);
    const below = (name: string): number[] => [S(name), ...plan.segments.filter((x) => x.parent === name).flatMap((x) => below(x.name))];
    this.carried = plan.joints.flatMap((j) => j.dofs.map(() => below(j.child)));
    this.segMass = Float64Array.from(plan.segments.map((x) => x.mass));
    this.pelvisSeg = S('pelvis');
    const region = (n: string) => (/^(hip|knee|ankle|toe)/.test(n) ? 'leg' : /^(sc|shoulder|elbow|wrist)/.test(n) ? 'arm' : 'trunk');
    this.wn = Float64Array.from(muscles.names.map((n) => WN[region(n)]));
    this.kMin = Float64Array.from(muscles.names, (n, i) => (region(n) === 'leg' ? 2 : 0.6) * 0.5 * (muscles.tPos[i] + muscles.tNeg[i]));
    this.isLeg = Uint8Array.from(muscles.names.map((n) => (region(n) === 'leg' ? 1 : 0)));
    this.chains = ['L', 'R'].map((sx) => ['hip', 'knee', 'ankle'].flatMap((j) => muscles.names.flatMap((n, i) => (n.startsWith(j + sx + '.') ? [i] : []))));
  }

  root(): RootTarget { return this.frame.root; }
  debug() { return this.dbg; }

  compute(v: BodyView, cmd: Commands, out: MuscleTargets) {
    const sup = v.support ?? NO_SUPPORT, set = this.supportSettings, n = this.muscles.n;
    this.animator.update(v, cmd, sup, this.frame);
    // The hand controller runs every step so its gait and balance state are current when it is blended in.
    this.hand.compute(v, cmd, this.handOut);
    const want = 1 - Math.min(sup.posture, sup.carry);
    // in quickly (a hit), out slowly (the animation takes over again once the support is back)
    this.blend = this.blend < 0 ? want : this.blend + clamp(want - this.blend, -v.dt / 0.3, v.dt / 0.08);
    const b = this.blend;
    // share of body weight the legs carry: what the posture support does not
    const legShare = clamp(1 - set.weightShare * sup.posture * set.strength, 0, 1);
    this.track(v, this.trackOut, legShare, set.tracking);
    const h = this.handOut, t = this.trackOut;
    for (let i = 0; i < n; i++) {
      // blend torques, not set points: kp·q and kd·qd are mixed so the spring and damper terms add up exactly
      const kp = t.kp[i] + (h.kp[i] - t.kp[i]) * b, kd = t.kd[i] + (h.kd[i] - t.kd[i]) * b;
      const kq = t.kp[i] * t.q[i] + (h.kp[i] * h.q[i] - t.kp[i] * t.q[i]) * b;
      const kv = t.kd[i] * t.qd[i] + (h.kd[i] * h.qd[i] - t.kd[i] * t.qd[i]) * b;
      out.kp[i] = kp; out.kd[i] = kd;
      out.q[i] = kp > 1e-9 ? kq / kp : t.q[i] + (h.q[i] - t.q[i]) * b;
      out.qd[i] = kd > 1e-9 ? kv / kd : 0;
      // the hand controller's leg forces assume the legs carry all the weight; with support they carry legShare
      out.tff[i] = t.tff[i] + (h.tff[i] * (this.isLeg[i] ? legShare : 1) - t.tff[i]) * b;
    }
    this.dbg = { clip: this.frame.clip, phase: this.frame.phase, blend: b, legShare, mode: String(this.hand.debug().mode ?? '') };
  }

  /** PD toward the frame plus gravity compensation (free segments) and a Jᵀ weight push (planted legs). */
  private track(v: BodyView, out: MuscleTargets, legShare: number, tracking: number) {
    const f = this.frame, ms = this.muscles, s = v.state;
    for (let i = 0; i < ms.n; i++) {
      const I = ms.ieff[i], kpMax = 0.5 * ms.ilocal[i] / (DT_REF * DT_REF);
      // Light distal dofs (toes, ankles, wrists) get at least a fraction of their strength per radian, as in the
      // hand controller: inertia-scaled gains leave them limp, and a landing folds the ankle into its limit.
      const kp = Math.min(clamp(f.gain[i], 0, 1) * tracking * Math.max(I * this.wn[i] * this.wn[i], this.kMin[i]), kpMax);
      out.q[i] = clamp(f.q[i], ms.lo[i], ms.hi[i]);
      out.qd[i] = f.qd[i];
      out.kp[i] = kp;
      out.kd[i] = Math.max(2 * Math.sqrt(kp * I), 0.03 * kp);
      out.tff[i] = 0;
    }
    const stance = [0, 1].filter((k) => f.planted[k] && v.feet[k].touching);
    this.grounded += ((stance.length > 0 ? 1 : 0) - this.grounded) * Math.min(1, v.dt / 0.4);
    const stanceDofs = new Set(stance.flatMap((k) => this.chains[k]));
    for (let i = 0; i < ms.n; i++) if (!stanceDofs.has(i)) this.gravityComp(v, i, out);
    if (stance.length === 0) return;
    // Over a gait cycle the legs deliver legShare of the weight while they are on the ground, so each stance
    // pushes harder the less of the time the feet are down (sprinting).
    // Height feedback keeps a hard stance push from launching the body above the animation's pelvis height.
    const pi = this.pelvisSeg, dh = f.root.height - s.segPos[3 * pi + 1], vy = s.segVel[3 * pi + 1];
    const Fy = legShare * this.mass * G / Math.max(0.3, this.grounded) / stance.length * clamp(1 + 10 * dh - 1.5 * vy, 0, 2);
    for (const k of stance) {
      // Applied at the ankle: hip and knee carry the weight, the ankle only tracks. Pushing at the centre of
      // pressure loaded the ankle with full plantarflexion as a foot landed on its toes, and folded it past its limit.
      const p = this.ankle(v, this.chains[k]);
      for (const i of this.chains[k]) {
        const a = this.vec(s.dofAnchor, i);
        // τ = −Jᵀ F: the leg pushes the turf with −F
        out.tff[i] += -dot(cross(this.vec(s.dofAxis, i), [p[0] - a[0], p[1] - a[1], p[2] - a[2]]), [0, Fy, 0]);
      }
    }
  }

  /** Feed-forward torque that holds up the weight a dof carries (Coros et al. 2010), as in the hand controller. */
  private gravityComp(v: BodyView, i: number, out: MuscleTargets) {
    const s = v.state;
    let m = 0, cx = 0, cz = 0;
    for (const k of this.carried[i]) { const mk = this.segMass[k]; m += mk; cx += mk * s.segCom[3 * k]; cz += mk * s.segCom[3 * k + 2]; }
    const a = this.vec(s.dofAnchor, i), ax = this.vec(s.dofAxis, i);
    out.tff[i] += -(ax[0] * (cz / m - a[2]) * m * G - ax[2] * (cx / m - a[0]) * m * G);
  }

  private ankle(v: BodyView, chain: number[]): Vec3 { const i = chain[chain.length - 1]; return this.vec(v.state.dofAnchor, i); }
  private vec(a: Float64Array, i: number): Vec3 { return [a[3 * i], a[3 * i + 1], a[3 * i + 2]]; }
}
