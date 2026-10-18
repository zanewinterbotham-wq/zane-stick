// Tracking motor controller (active ragdoll, design §6.5). The muscles track the animator's pose; the world's
// support carries the body along the animation's root target. When the support levels drop (player contact,
// knocked off balance) the targets blend toward the hand-built balance controller, so a hit athlete steps and
// fights for balance physically; they blend back once the support returns. Everything stays within the muscles.
import type { BodyPlan } from '../anatomy/body';
import { DEFAULT_SUPPORT, newFrame, type AnimFrame, type Animator, type RootTarget, type SupportSettings, type SupportState } from '../anim/types';
import { clamp, cross, dot, qconj, qrot, type Quat, type Vec3 } from '../math';
import { newTargets, type MuscleSet, type MuscleTargets } from '../muscles';
import { GAIT_SPEED, HandController } from './hand';
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
    this.animator = animator ?? new BasicAnimator(plan, muscles);
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

/** Root acceleration toward the commanded speed (m/s²): quick, as the owner asked for (sprint starts ~7). */
const ROOT_ACCEL = { walk: 3, jog: 5, sprint: 7 };

type AnimLeg = { side: 1 | -1; L1: number; L2: number; hipOff: Vec3; ankleH: number; hip: number[]; knee: number; ankle: number };
const legIK = (HandController.prototype as unknown as { legIK: (L: object, rel: Vec3, rot: number) => [number, number, number] }).legIK;

/** Minimal stand-in until the procedural animator is plugged in through the constructor: a standing pose and a
 *  phase-based gait whose stance foot sweeps back at the body's measured speed (so planted feet do not slide),
 *  solved by the hand controller's exact leg IK from the actual pelvis pose. */
class BasicAnimator implements Animator {
  private phase = 0;
  private vel: Vec3 | null = null;
  private heading: number | null = null;
  private prevQ: Float64Array;
  private legs: AnimLeg[];
  private arms: { flex: number; abd: number; rot: number; elbow: number }[];
  private pelvis: number; private lumbar: number;
  private pelvisH: number;

  constructor(private plan: BodyPlan, private muscles: MuscleSet) {
    const D = (n: string) => muscles.index(n), S = (n: string) => plan.segments.findIndex((x) => x.name === n);
    this.pelvis = S('pelvis'); this.lumbar = D('lumbar.flex');
    const pel = plan.segments[this.pelvis];
    this.pelvisH = pel.origin[1];
    this.legs = ([1, -1] as const).map((side) => {
      const sx = side > 0 ? 'L' : 'R', J = (n: string) => plan.joints.find((j) => j.name === n + sx)!;
      const hip = J('hip'), knee = J('knee'), ank = J('ankle');
      return {
        side, L1: hip.pos[1] - knee.pos[1], L2: knee.pos[1] - ank.pos[1], ankleH: ank.pos[1],
        hipOff: [hip.pos[0] - pel.origin[0], hip.pos[1] - pel.origin[1], hip.pos[2] - pel.origin[2]],
        hip: ['flex', 'abd', 'intRot'].map((d) => D(`hip${sx}.${d}`)), knee: D(`knee${sx}.flex`), ankle: D(`ankle${sx}.dorsi`),
      };
    });
    this.arms = ['L', 'R'].map((sx) => ({ flex: D(`shoulder${sx}.flex`), abd: D(`shoulder${sx}.abd`), rot: D(`shoulder${sx}.intRot`), elbow: D(`elbow${sx}.flex`) }));
    this.prevQ = new Float64Array(muscles.n).fill(NaN);
  }

  update(v: BodyView, cmd: Commands, _sup: SupportState, out: AnimFrame) {
    const s = v.state, dt = v.dt, cv = s.comVel;
    // root velocity: slews toward the command, never far ahead of the actual speed (gentle carry after a hit)
    const cap = GAIT_SPEED[cmd.gait] * this.plan.params.speed, mvLen = Math.hypot(cmd.move.x, cmd.move.z), mv = Math.min(1, mvLen);
    const want: Vec3 = mv > 0.05 ? [(cmd.move.x / mvLen) * mv * cap, 0, (cmd.move.z / mvLen) * mv * cap] : [0, 0, 0];
    const vel = this.vel ?? [cv[0], 0, cv[2]]; // start from the body's own velocity
    const dv: Vec3 = [want[0] - vel[0], 0, want[2] - vel[2]], dl = Math.hypot(dv[0], dv[2]), step = ROOT_ACCEL[cmd.gait] * dt;
    if (dl > step) { dv[0] *= step / dl; dv[2] *= step / dl; }
    this.vel = [clamp(vel[0] + dv[0], cv[0] - 1.5, cv[0] + 1.5), 0, clamp(vel[2] + dv[2], cv[2] - 1.5, cv[2] + 1.5)];
    if (mv <= 0.05 && Math.hypot(this.vel[0], this.vel[2]) < 0.1) this.vel = [0, 0, 0];
    const pq: Quat = [s.segQuat[4 * this.pelvis], s.segQuat[4 * this.pelvis + 1], s.segQuat[4 * this.pelvis + 2], s.segQuat[4 * this.pelvis + 3]];
    const pf = qrot(pq, [0, 0, 1]);
    if (this.heading === null) this.heading = Math.atan2(pf[0], pf[2]);
    const face = cmd.face ?? (Math.hypot(want[0], want[2]) > 0.3 ? { x: want[0], z: want[2] } : null);
    if (face) { const d = Math.atan2(face.x, face.z) - this.heading; this.heading += clamp(Math.atan2(Math.sin(d), Math.cos(d)), -10 * dt, 10 * dt); }

    // gait timing from the measured speed: cadence and contact time [S4]; contact shrinks to what the leg can reach
    const sp = Math.hypot(cv[0], cv[2]), moving = sp > 0.15 || Math.hypot(this.vel[0], this.vel[2]) > 0.1;
    const travel: Vec3 = sp > 0.3 ? [cv[0] / sp, 0, cv[2] / sp] : [Math.sin(this.heading), 0, Math.cos(this.heading)];
    const sink = clamp(cmd.sink, 0, 1), height = this.pelvisH - 0.03 - 0.007 * sp - 0.25 * sink;
    const Tst = 2 / clamp(1.75 + 0.32 * sp, 1.75, 4.8);
    const L = this.legs[0], reach = 0.97 * (L.L1 + L.L2), vert = height + L.hipOff[1] - L.ankleH;
    const Xmax = Math.sqrt(Math.max(0.01, reach * reach - vert * vert));
    const d = moving ? clamp(Math.min(clamp(0.62 - 0.045 * sp, 0.22, 0.62), 2 * Xmax / Math.max(0.1, sp * Tst)), 0.12, 0.62) : 1;
    const X = moving ? sp * d * Tst / 2 : 0;
    if (moving) this.phase = (this.phase + dt / Tst) % 1;
    const pelvisPos: Vec3 = [s.segPos[3 * this.pelvis], s.segPos[3 * this.pelvis + 1], s.segPos[3 * this.pelvis + 2]];
    const pelvisPitch = -Math.asin(clamp(pf[1], -1, 1));
    out.gain.fill(1);
    for (let i = 0; i < this.muscles.n; i++) out.q[i] = 0;
    const hipFlex: number[] = [];
    this.legs.forEach((leg, k) => {
      const psi = (this.phase + 0.5 * k) % 1, stance = psi < d;
      let along: number, lift = 0;
      if (stance) along = X * (1 - 2 * psi / d);
      else {
        const u = (psi - d) / (1 - d), e = Math.min(1, u / 0.85);
        along = -X + 2 * X * e * e * (3 - 2 * e);
        lift = (0.05 + 0.03 * sp) * Math.sin(Math.PI * u);
      }
      out.planted[k] = stance;
      const hoff = qrot(pq, leg.hipOff), hip: Vec3 = [pelvisPos[0] + hoff[0], pelvisPos[1] + hoff[1], pelvisPos[2] + hoff[2]];
      // stance target a little below the turf so the leg presses into it
      const tgt: Vec3 = [hip[0] + travel[0] * along, leg.ankleH + lift - (stance ? 0.01 : 0), hip[2] + travel[2] * along];
      const rel = qrot(qconj(pq), [tgt[0] - hip[0], tgt[1] - hip[1], tgt[2] - hip[2]]);
      const [fl, ab, kn] = legIK(leg, rel, 0);
      hipFlex.push(fl);
      out.q[leg.hip[0]] = fl; out.q[leg.hip[1]] = ab; out.q[leg.knee] = kn;
      // foot level in the swing; in stance the ankle mostly follows the turf and plantarflexes late (push-off)
      out.q[leg.ankle] = stance ? -0.35 * clamp(psi / d - 0.5, 0, 1) * clamp(sp / 3, 0, 1) : pelvisPitch - fl + kn + 0.1;
    });
    const running = sp > 2.6;
    this.arms.forEach((A, k) => {
      const own = hipFlex[k], opp = hipFlex[1 - k];
      out.q[A.flex] = -(running ? clamp(0.5 + 0.06 * sp, 0, 1.1) : 0.6) * (own - opp) * 0.9;
      out.q[A.abd] = 0.12; out.q[A.elbow] = running ? 1.4 : 0.35;
      if (cmd.carry === k + 1) { out.q[A.flex] = 0.35; out.q[A.abd] = -0.05; out.q[A.rot] = 0.7; out.q[A.elbow] = 1.9; }
      else for (const i of [A.flex, A.abd, A.rot, A.elbow]) out.gain[i] = 0.6;
    });
    // trunk lean with speed and with the speed still to gain (sprint start), plus the commanded sink and lean
    const lean = clamp(0.02 * sp + 0.2 * (Math.hypot(this.vel[0], this.vel[2]) - sp), -0.1, 0.35) + 0.5 * sink + 0.45 * cmd.lean.fwd;
    if (this.lumbar >= 0) out.q[this.lumbar] = 0.3 * lean;
    // target speeds: how fast each target moves (damping follows the motion instead of resisting it)
    for (let i = 0; i < this.muscles.n; i++) {
      out.qd[i] = Number.isNaN(this.prevQ[i]) ? 0 : clamp((out.q[i] - this.prevQ[i]) / dt, -20, 20);
      this.prevQ[i] = out.q[i];
    }
    out.root.vel = this.vel; out.root.height = height; out.root.heading = this.heading;
    out.root.pitch = lean; out.root.roll = 0.3 * cmd.lean.side;
    out.phase = this.phase; out.clip = !moving ? 'idle' : running ? 'run' : 'walk';
    if (!moving) out.planted = [true, true];
  }
}
