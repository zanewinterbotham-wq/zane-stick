// Hand-built motor controller. Body state + Commands in, muscle targets out, every physics step.
//
// Structure (all of it ends in per-joint PD targets + feed-forward torque, limited by the muscles):
//  - Balance: divergent-component-of-motion (capture point) control picks where the centre of pressure
//    should be; the stance legs produce that ground force through Jacobian-transpose feed-forward
//    (ankle strategy) and by sharing load between the feet (lateral balance).
//  - Trunk attitude (SIMBICON): world-frame orientation error of pelvis, thorax and head becomes joint
//    target offsets on the stance hips, the spine and the neck.
//  - Stepping: capture-point / Raibert foot placement with a phase-based gait whose cadence and contact
//    time grow with speed; swing feet follow an IK trajectory.
//  - Contact-mode body-part commands reshape arm, trunk and leg targets.
import type { BodyPlan } from '../anatomy/body';
import { clamp, cross, dot, headingOf, lerp, qaxis, qconj, qlog, qmul, qrot, type Quat, type Vec3 } from '../math';
import type { MuscleSet, MuscleTargets } from '../muscles';
import type { BodyView, Commands, MotorController } from './types';

export interface Gains {
  /** Joint stiffness as a fraction of the joint's mean peak torque per radian: kp = s·T0. */
  posture: number; stanceKnee: number; stanceAnkle: number; stanceHip: number; spine: number; neck: number;
  /** Swing-leg and arm natural frequency (rad/s) with the distal inertia. */
  swingWn: number; armWn: number;
  /** Damping time constant (s): kd ≥ kp·dampT (integrated implicitly, so any value is stable). */
  dampT: number;
  /** World-attitude feedback: how strongly orientation error becomes joint target offset. */
  pelvisAtt: number; thoraxAtt: number; headAtt: number;
  /** Capture-point convergence rate (1/s) and COM height PD (1/s², 1/s). */
  dcmK: number; heightKp: number; heightKd: number;
  /** Foot-placement feedback on velocity error (s) and step width between the feet (m). */
  footK: number; stepWidth: number; footMargin: number;
  /** Farthest foothold ahead of the COM (m) and narrowest step outward of the stance foot (m). */
  stepMax: number; stepWidthMin: number;
  /** Trunk balance through the stance hip, in units of m·g·h per rad and per rad/s. */
  torsoKp: number; torsoKd: number;
  /** Gait shape: minimum walking step time (s), touchdown gate (fraction of step), swing clearance (m),
   *  stance knee bend (rad), walking arm swing, how far the speed reference may lead the actual speed (m/s). */
  stepTMin: number; touchFrac: number; clearance: number; stanceKneeBend: number; armSwing: number; vLead: number;
  /** Trunk lean with speed (rad per m/s) and with the speed still to gain (rad per m/s). */
  leanSpeed: number; leanAccel: number;
  /** Push-off: start (fraction of the step) and ankle plantarflexion depth (rad). */
  pushStart: number; pushAnkle: number;
  /** Pelvis yaw control strength relative to pitch/roll (capped by cleat rotational traction). */
  yawGain: number;
  /** Swing phase from which the foot reaches below the turf at the foothold (straight-leg landing). */
  reachStart: number;
  /** Trunk balance torque through the loaded feet while standing (hip strategy), relative to torsoKp/torsoKd. */
  standTorso: number;
  /** Swing clearance of chopping steps (m): the feet barely leave the turf. */
  chopClear: number;
  /** Running: vertical push scale, apex height feedback (1/m), horizontal acceleration (1/s), Raibert foot
   *  placement on speed error (s), heel recovery fold (rad). */
  runPush: number; runHeightK: number; runAccel: number; runFootK: number; runHeel: number;
}
export const DEFAULT_GAINS: Gains = {
  // Hand-set, physically motivated starting values; bench/tune refines them.
  posture: 0.6, stanceKnee: 2.5, stanceAnkle: 0.5, stanceHip: 2.0, spine: 2.0, neck: 2.5,
  swingWn: 30, armWn: 20, dampT: 0.03,
  pelvisAtt: 1.0, thoraxAtt: 1.0, headAtt: 1.0,
  dcmK: 2.5, heightKp: 60, heightKd: 15,
  footK: 0.1, stepWidth: 0.3, footMargin: 0.05,
  stepMax: 0.3, stepWidthMin: 0.21,
  torsoKp: 1.5, torsoKd: 0.2,
  stepTMin: 0.4, touchFrac: 0.6, clearance: 0.09, stanceKneeBend: 0.12, armSwing: 0.6, vLead: 0.6,
  leanSpeed: 0.015, leanAccel: 0.04,
  pushStart: 0.55, pushAnkle: 0.35,
  yawGain: 0.6, reachStart: 0.7, standTorso: 1.3,
  chopClear: 0.025,
  runPush: 1.02, runHeightK: 0.31, runAccel: 0.95, runFootK: 0.023, runHeel: 2.43,
};

/** Target speeds (m/s) for the reference athlete; the body's own limits decide what is reached. */
export const GAIT_SPEED = { walk: 1.6, jog: 4.2, sprint: 10.5 };
/** Acceleration the foot placement aims for (m/s²); sprint starts reach ~5–7 m/s² [S4]. */
export const GAIT_ACCEL = { walk: 1.5, jog: 3, sprint: 6 };

const G = 9.81;
/** Running cycle shape, tuned on the headless run scenario (scratch CMA-ES over these values). */
const RUN = {
  X: 0.36, Xb: 0.56,         // COM travel behind / past the ball of the foot during contact (m)
  cop: 0.13,                 // stance centre of pressure ahead of the ankle: the ball of the foot (m)
  flight: 0.02,              // minimum flight time per step (s): short flights, the hips are slow to swing
  force: 3.4,                // stance push through Jᵀ relative to the planned ground force (muscles saturate it)
  kv: 12,                    // stance vertical-velocity feedback (1/s)
  kl: 37,                    // whole-body angular momentum feedback in stance (1/s)
  kneeBend: 0.15, kneeStiff: 3.6, // stance knee spring set point (rad) and stiffness (× stanceKnee)
  torsoKp: 1.8, torsoKd: 0.66,    // trunk balance through the stance hip (m·g·h per rad, per rad/s)
  swingWn: 40,               // swing-leg natural frequency (rad/s)
  tdFrac: 0.53,              // a contact counts as touchdown after this fraction of the predicted swing
  reachAt: 0.27, foldEnd: 0.72, // swing fraction by which the thigh reaches forward / the heel fold ends
  reachBelow: 0.057,         // touchdown IK target below the turf, so the leg arrives extended (m)
  retract: 0.74, retractT: 0.04, // retraction rate (× foot ground speed) and its duration (s)
  nearH: 0.18, nearK: 0.16,  // ankle height that triggers ground-speed matching (m), and its gain (s)
  clear: 0.006,              // ankle clearance kept until the thigh is forward (m)
  width: 0.17,               // foot placement out from the COM (m)
  lean: 2.0, back: 0.38,     // trunk lean back per unit forward angular momentum (rad·kg/(kg·m²/s)), and constant (rad)
};
/** Gains are capped for stability at the slowest supported physics rate (240 Hz) and NOT re-scaled at
 *  faster rates, so the same athlete behaves the same on every preset. */
const DT_REF = 1 / 240;

type Leg = {
  k: 0 | 1; side: 1 | -1;
  hip: number[]; knee: number[]; ankle: number[]; toe: number;
  chain: number[];               // hip, knee, ankle dofs (for Jacobians)
  foot: number;
  L1: number; L2: number;        // thigh and shank length (m)
  hipOff: Vec3;                  // hip joint centre relative to pelvis origin, pelvis frame
  ankleH: number;                // ankle height above the ground at rest (m)
  phase: 'stance' | 'swing'; t: number; liftPos: Vec3; target: Vec3; ankT?: Vec3;
  kneeLand: number;              // knee flexion at this leg's last touchdown (rad)
  liftQ: number[];               // hip flexion and knee angle at lift-off (running swing starts from them)
};

export class HandController implements MotorController {
  gains: Gains = { ...DEFAULT_GAINS };
  private legs: Leg[];
  private D: (n: string) => number;
  private S: (n: string) => number;
  private mass: number;
  private standCom: number;
  private pelvisSeg: number; private thoraxSeg: number; private headSeg: number;
  private lumbarDofs: number[]; private thoracicDofs: number[]; private neckDofs: number[];
  private arms: { side: 1 | -1; flex: number; abd: number; rot: number; elbow: number; pron: number; wrist: number[]; sc: number[] }[];
  private standing = true;
  private dbg: Record<string, number | string> = {};
  private thrustT = 0; private diveT = 0;
  private headingHold: number | null = null;
  private stanceIdx: 0 | 1 = 0;
  private walkT = 0;
  /** The current step is a chop step (latched when the step starts, so a step keeps its own timing). */
  private chopStep = false;
  private runMode = false;
  private vRef: Vec3 = [0, 0, 0];
  private prevQ: Float64Array;
  private carried: number[][] = [];
  private segMass!: Float64Array;
  /** 1 for free-limb dofs whose damping should follow the moving target. */
  private tracking: Uint8Array;
  private qdFilt: Float64Array;
  private T0: Float64Array;

  constructor(private plan: BodyPlan, private muscles: MuscleSet) {
    this.D = (n) => muscles.index(n);
    this.S = (n) => plan.segments.findIndex((s) => s.name === n);
    this.mass = plan.segments.reduce((a, s) => a + s.mass, 0);
    this.T0 = muscles.tPos.map((t, i) => 0.5 * (t + muscles.tNeg[i]));
    this.prevQ = new Float64Array(muscles.n).fill(NaN);
    // segments carried by each dof (its joint's child and everything below it), for gravity compensation
    const below = (name: string): number[] => [this.S(name), ...plan.segments.filter((x) => x.parent === name).flatMap((x) => below(x.name))];
    this.carried = plan.joints.flatMap((j) => j.dofs.map(() => below(j.child)));
    this.segMass = Float64Array.from(plan.segments.map((x) => x.mass));
    this.tracking = new Uint8Array(muscles.n);
    this.qdFilt = new Float64Array(muscles.n);
    this.pelvisSeg = this.S('pelvis');
    this.thoraxSeg = this.S('thorax') >= 0 ? this.S('thorax') : this.S('trunk');
    this.headSeg = this.S('head');
    this.standCom = plan.segments.reduce((a, s) => a + s.com[1] * s.mass, 0) / this.mass;
    const pelvis = plan.segments[this.pelvisSeg];
    this.legs = ([1, -1] as const).map((side, k) => {
      const sx = side > 0 ? 'L' : 'R';
      const hipJ = plan.joints.find((j) => j.name === 'hip' + sx)!, kneeJ = plan.joints.find((j) => j.name === 'knee' + sx)!, ankJ = plan.joints.find((j) => j.name === 'ankle' + sx)!;
      const hip = ['flex', 'abd', 'intRot'].map((d) => this.D(`hip${sx}.${d}`));
      const knee = ['flex', 'intRot'].map((d) => this.D(`knee${sx}.${d}`));
      const ankle = ['dorsi', 'inv'].map((d) => this.D(`ankle${sx}.${d}`));
      return {
        k: k as 0 | 1, side, hip, knee, ankle, toe: this.D(`toe${sx}.ext`), chain: [...hip, ...knee, ...ankle],
        foot: this.S('foot' + sx),
        L1: hipJ.pos[1] - kneeJ.pos[1], L2: kneeJ.pos[1] - ankJ.pos[1],
        hipOff: [hipJ.pos[0] - pelvis.origin[0], hipJ.pos[1] - pelvis.origin[1], hipJ.pos[2] - pelvis.origin[2]],
        ankleH: ankJ.pos[1],
        phase: 'stance', t: 0, liftPos: [0, 0, 0], target: [0, 0, 0], kneeLand: 0, liftQ: [0, 0],
      } as Leg;
    });
    const spine = (j: string) => ['flex', 'latL', 'rotL'].map((d) => this.D(`${j}.${d}`)).filter((i) => i >= 0);
    this.lumbarDofs = spine('lumbar');
    this.thoracicDofs = spine('thoracic');
    this.neckDofs = [...spine('neckLow'), ...spine('neckUp')];
    this.arms = ([1, -1] as const).map((side) => {
      const sx = side > 0 ? 'L' : 'R';
      return {
        side, flex: this.D(`shoulder${sx}.flex`), abd: this.D(`shoulder${sx}.abd`), rot: this.D(`shoulder${sx}.intRot`),
        elbow: this.D(`elbow${sx}.flex`), pron: this.D(`elbow${sx}.pron`), wrist: ['flex', 'radDev'].map((d) => this.D(`wrist${sx}.${d}`)),
        sc: ['elev', 'protr'].map((d) => this.D(`sc${sx}.${d}`)),
      };
    });
  }

  debug() { return this.dbg; }

  // ---------------------------------------------------------------- joint helpers
  /** Stiffness-style PD: kp = s·T0 (N·m/rad), capped for numerical stability on the lightest segment. */
  private stiff(out: MuscleTargets, i: number, q: number, s: number) {
    if (i < 0) return;
    const ms = this.muscles, kpMax = 0.5 * ms.ilocal[i] / (DT_REF * DT_REF);
    const kp = Math.min(s * this.T0[i], kpMax);
    out.q[i] = clamp(q, ms.lo[i], ms.hi[i]);
    out.kp[i] = kp;
    out.kd[i] = Math.max(kp * this.gains.dampT, 1.6 * Math.sqrt(kp * ms.ieff[i]));
    this.tracking[i] = 0;
  }
  /** Natural-frequency PD with the distal inertia (free limbs). */
  private freq(out: MuscleTargets, i: number, q: number, wn: number) {
    if (i < 0) return;
    const ms = this.muscles, I = ms.ieff[i], kpMax = 0.5 * ms.ilocal[i] / (DT_REF * DT_REF);
    const kp = Math.min(I * wn * wn, kpMax);
    out.q[i] = clamp(q, ms.lo[i], ms.hi[i]);
    out.kp[i] = kp;
    out.kd[i] = 2 * Math.sqrt(kp * I);
    this.tracking[i] = 1;
  }
  /** Gravity compensation: feed-forward torque that holds up the weight each dof carries, so joint
   *  stiffness only has to correct errors (Coros et al. 2010). */
  private gravityComp(v: BodyView, dofs: number[], out: MuscleTargets) {
    const s = v.state;
    for (const i of dofs) {
      if (i < 0) continue;
      let m = 0, cx = 0, cy = 0, cz = 0;
      for (const k of this.carried[i]) { const mk = this.segMass[k]; m += mk; cx += mk * s.segCom[3 * k]; cy += mk * s.segCom[3 * k + 1]; cz += mk * s.segCom[3 * k + 2]; }
      const a = this.anchor(v, i), ax = this.axis(v, i);
      const rx = cx / m - a[0], rz = cz / m - a[2];
      // gravity torque on the carried part: r × (0, −mg, 0) = (rz·mg, 0, −rx·mg); the joint supplies the opposite
      out.tff[i] += -(ax[0] * rz * m * G - ax[2] * rx * m * G);
      void cy;
    }
  }

  /** The torque a dof will actually produce for these targets: the PD request clamped to what the muscle
   *  can deliver at this speed (unclamped PD estimates can be thousands of N·m). */
  private estTorque(out: MuscleTargets, i: number, q: number, qd: number) {
    const want = out.kp[i] * (out.q[i] - q) + out.kd[i] * (out.qd[i] - qd) + out.tff[i];
    const cap = this.muscles.available(i, want, qd);
    return clamp(want, -cap, cap);
  }

  /** Whole-body angular momentum about the COM (kg·m²/s, world frame). */
  private angMom(v: BodyView): Vec3 {
    const s = v.state, segs = this.plan.segments, L: Vec3 = [0, 0, 0];
    for (let k = 0; k < segs.length; k++) {
      const mk = segs[k].mass, I = segs[k].inertia, q = this.segQuat(v, k);
      const r: Vec3 = [s.segCom[3 * k] - s.com[0], s.segCom[3 * k + 1] - s.com[1], s.segCom[3 * k + 2] - s.com[2]];
      const u: Vec3 = [s.segVel[3 * k] - s.comVel[0], s.segVel[3 * k + 1] - s.comVel[1], s.segVel[3 * k + 2] - s.comVel[2]];
      const wb = qrot(qconj(q), this.segVec(s.segAngVel, k));
      const Iw = qrot(q, [I[0] * wb[0] + I[1] * wb[1] + I[2] * wb[2], I[3] * wb[0] + I[4] * wb[1] + I[5] * wb[2], I[6] * wb[0] + I[7] * wb[1] + I[8] * wb[2]]);
      const rxu = cross(r, u);
      for (let j = 0; j < 3; j++) L[j] += mk * rxu[j] + Iw[j];
    }
    return L;
  }

  private segQuat(v: BodyView, s: number): Quat { const q = v.state.segQuat; return [q[4 * s], q[4 * s + 1], q[4 * s + 2], q[4 * s + 3]]; }
  private segVec(a: Float64Array, s: number): Vec3 { return [a[3 * s], a[3 * s + 1], a[3 * s + 2]]; }
  private axis(v: BodyView, i: number): Vec3 { const a = v.state.dofAxis; return [a[3 * i], a[3 * i + 1], a[3 * i + 2]]; }
  private anchor(v: BodyView, i: number): Vec3 { const a = v.state.dofAnchor; return [a[3 * i], a[3 * i + 1], a[3 * i + 2]]; }

  /** Joint-angle changes on `dofs` that rotate the child side by world rotation vector r (least squares). */
  private rotToDofs(v: BodyView, dofs: number[], r: Vec3): number[] {
    const A = dofs.map((i) => this.axis(v, i));
    const M = [0, 1, 2].map((a) => [0, 1, 2].map((b) => A.reduce((s, x) => s + x[a] * x[b], 0) + (a === b ? 1e-4 : 0)));
    const y = solve3(M, r);
    return A.map((x) => dot(x, y));
  }

  private orient(heading: number, pitchFwd: number, rollLeft: number): Quat {
    return qmul(qaxis([0, 1, 0], heading), qmul(qaxis([1, 0, 0], pitchFwd), qaxis([0, 0, -1], rollLeft)));
  }
  private err(qd: Quat, q: Quat): Vec3 { return qlog(qmul(qd, qconj(q))); }

  // ---------------------------------------------------------------- main
  compute(v: BodyView, cmd: Commands, out: MuscleTargets) {

    const g = this.gains, s = v.state, m = this.mass;
    out.tff.fill(0);
    for (let i = 0; i < this.muscles.n; i++) this.stiff(out, i, 0, g.posture);

    const pq = this.segQuat(v, this.pelvisSeg);
    const heading = headingOf(qrot(pq, [0, 0, 1]));
    const c = s.com, cv = s.comVel;
    const speedCap = GAIT_SPEED[cmd.gait] * this.plan.params.speed;
    const mvLen = Math.hypot(cmd.move.x, cmd.move.z), mv = Math.min(1, mvLen);
    const vdRaw: Vec3 = mv > 0.05 ? [(cmd.move.x / mvLen) * mv * speedCap, 0, (cmd.move.z / mvLen) * mv * speedCap] : [0, 0, 0];
    // The velocity the legs aim for slews toward the command at a human acceleration rate, starting from
    // the current velocity: placing feet for an instant jump to full speed would outrun the stance leg.
    const aMax = GAIT_ACCEL[cmd.gait];
    const vdx = this.vRef[0] + clamp(vdRaw[0] - this.vRef[0], -aMax * v.dt, aMax * v.dt);
    const vdz = this.vRef[2] + clamp(vdRaw[2] - this.vRef[2], -aMax * v.dt, aMax * v.dt);
    // never let the reference run ahead of the actual speed by more than a short ramp
    const lead = g.vLead;
    this.vRef = [clamp(vdx, s.comVel[0] - lead, s.comVel[0] + lead), 0, clamp(vdz, s.comVel[2] - lead, s.comVel[2] + lead)];
    if (mv <= 0.05) this.vRef = [0, 0, 0];
    const vd: Vec3 = this.vRef;
    const vdMag = Math.hypot(vd[0], vd[2]);
    const faceDir = cmd.face ?? (Math.hypot(vdRaw[0], vdRaw[2]) > 0.3 ? { x: vdRaw[0], z: vdRaw[2] } : null);
    // Hold the last commanded heading when there is no command (otherwise yaw would be uncontrolled).
    if (this.headingHold === null) this.headingHold = heading;
    if (faceDir) this.headingHold = Math.atan2(faceDir.x, faceDir.z);
    const headingD = this.headingHold;
    const speed = Math.hypot(cv[0], cv[2]);
    const fwdD: Vec3 = [Math.sin(headingD), 0, Math.cos(headingD)];
    const rightD: Vec3 = [-Math.cos(headingD), 0, Math.sin(headingD)]; // athlete faces +Z, +X is LEFT

    // ---- gait timing: cadence and contact time vary with speed [S4]
    const vRef = Math.max(speed, vdMag);
    // Step duration: ~0.4 s walking down to ~0.21 s at sprint cadence [S4]. A swing leg cannot cross
    // faster than its hip flexors allow, so walking/recovery steps never go below 0.38 s.
    let stepT = 1 / clamp(1.75 + 0.32 * vRef, 1.75, 4.8);
    const running = vRef > 2.6;
    // Recovery steps are quicker: shorten the step as the capture point leaves the base of support.
    if (vRef < 2.6) stepT = clamp(stepT, Math.max(0.36, g.stepTMin), 0.6); // ~0.5 s steps at a brisk walk, like people
    const walkStepT = stepT;
    if (this.chopStep) stepT = 0.22; // chopping steps (~4.5 steps/s, short and quick)

    // ---- posture intent: COM height, trunk lean
    const sink = clamp(cmd.sink, 0, 1);
    let hd = this.standCom - 0.01 * vRef - sink * 0.3 * (this.plan.params.height / 1.83);
    const accelFwd = dot([vd[0] - cv[0], 0, vd[2] - cv[2]], fwdD);
    let pitchD = clamp(g.leanSpeed * vRef + g.leanAccel * accelFwd, -0.1, 0.45) + 0.55 * sink + 0.45 * cmd.lean.fwd;
    // Running: the trunk leans back as a counterweight against forward-pitching whole-body momentum (a trip),
    // which also moves the COM back over the feet.
    if (this.runMode) { const L = this.angMom(v); pitchD -= clamp(RUN.lean * (L[0] * fwdD[2] - L[2] * fwdD[0]) / this.mass, -0.1, 0.5) + RUN.back; }
    const rollD = 0.3 * cmd.lean.side;
    if (cmd.thrustHips && this.thrustT <= 0) this.thrustT = 0.3;
    if (this.thrustT > 0) { this.thrustT -= v.dt; hd += 0.1; pitchD -= 0.25; }
    if (cmd.dive && this.diveT <= 0 && (v.feet[0].touching || v.feet[1].touching)) this.diveT = 0.7;
    if (this.diveT > 0) {
      this.diveT -= v.dt;
      this.dive(v, cmd, out, headingD);
      return;
    }

    // ---- balance state
    const feet = v.feet;
    const w0 = Math.sqrt(G / Math.max(0.4, c[1]));
    const xi: Vec3 = [c[0] + cv[0] / w0, 0, c[2] + cv[2] / w0];        // capture point (DCM)
    const ank = this.legs.map((L) => this.segVec(s.segPos, L.foot));
    const footFwd = this.legs.map((L) => { const f = qrot(this.segQuat(v, L.foot), [0, 0, 1]); const n = Math.hypot(f[0], f[2]) || 1; return [f[0] / n, 0, f[2] / n] as Vec3; });
    const mid: Vec3 = [(ank[0][0] + ank[1][0]) / 2, 0, (ank[0][2] + ank[1][2]) / 2];
    const cpOut = this.outsideSupport(xi, ank, headingD);

    // ---- mode: quiet standing (capture-point balance) or stepping (SIMBICON-style cycle)
    // chop feet: quick short steps in place (breaking down on approach); also keeps stepping while held.
    // A foot left off the ground (e.g. after the last chop) is set back down with a step: standing balance
    // only holds the hip of a leg it has no load on, and that leg drifts away while the body tips over the other.
    const footUp = this.legs.some((L) => ank[L.k][1] > L.ankleH + 0.02);
    const wantMove = vdMag > 0.15 || speed > 0.45 || cpOut > 0.03 || cmd.chopFeet || footUp;
    if (this.standing && wantMove) {
      this.standing = false;
      // first swing: the leg on the side the capture point is leaving through, else the less loaded one
      const first = cpOut > 0.03 ? this.sideToward(xi, mid, rightD) : feet[0].force < feet[1].force ? 0 : 1;
      this.stanceIdx = (1 - first) as 0 | 1;
      this.walkT = 0; this.chopStep = cmd.chopFeet;
      this.legs[first].liftPos = ank[first];
    }
    // running (flight phases) above ~3 m/s, back to walking below ~2 m/s
    if (!this.standing && !this.runMode && speed > 2.6 && vdMag > 2.8) {
      this.runMode = true;
      // the walking swing leg carries on as the running swing leg from where it is now
      const sw = this.legs[1 - this.stanceIdx];
      if (sw.phase === 'swing') { sw.t = this.walkT; sw.liftQ = [s.q[sw.hip[0]], s.q[sw.knee[0]]]; }
    }
    if (this.runMode && (speed < 2.0 || this.standing)) this.runMode = false;
    if (!this.standing && !this.runMode) {
      this.walkT += v.dt;
      const sw = this.legs[1 - this.stanceIdx];
      // Touchdown counts once the swing foot is past the stance foot along the direction of travel
      // (a toe scuff behind the body is not a step), or when the step has run long.
      const travel: Vec3 = speed > 0.2 ? [cv[0] / speed, 0, cv[2] / speed] : fwdD;
      const st = this.legs[this.stanceIdx];
      // A swing foot that has taken most of the weight has landed wherever it is: a recovery step can end
      // behind the stance foot, and treating that loaded foot as still swinging leaves the trunk uncontrolled.
      // Only the fore–aft part of travel counts: when moving sideways a foot cannot pass the other one.
      const tf = dot(travel, fwdD);
      const ahead = dot([ank[sw.k][0] - ank[st.k][0], 0, ank[sw.k][2] - ank[st.k][2]], fwdD) * tf > -0.05
        || (feet[sw.k].force > 0.5 * m * G && feet[sw.k].force > feet[st.k].force);
      // A toe scuff mid-swing is not a landing: the foot must take real weight, or the planned set-down must be due.
      const landed = feet[sw.k].touching && (feet[sw.k].force > 0.25 * m * G || this.walkT > 0.9 * stepT);
      if ((landed && this.walkT > clamp(g.touchFrac, 0.5, 0.9) * stepT && ahead) || this.walkT > 1.5 * stepT) {
        // step complete: stop if nothing is pushing us on, otherwise the other leg swings next
        if (vdMag < 0.1 && speed < 0.35 && cpOut === 0 && !cmd.chopFeet) this.standing = true;
        else { this.stanceIdx = sw.k; this.walkT = 0; this.chopStep = cmd.chopFeet; this.legs[1 - sw.k].liftPos = ank[1 - sw.k]; sw.kneeLand = s.q[sw.knee[0]]; }
      }
    }
    // A step keeps the timing it started with: releasing chop mid-step must not stretch a 0.22 s step whose
    // foothold was planned for it into a 0.4 s one (the body falls over the stance foot meanwhile).
    stepT = this.chopStep ? 0.22 : walkStepT;

    // ---- trunk attitude: world error → joint target offsets (stance hips, spine, neck)
    const ePel = this.err(this.orient(headingD, clamp(0.3 * pitchD, -0.1, 0.25), 0.3 * rollD), pq);
    const tq = this.segQuat(v, this.thoraxSeg);
    const eTh = this.err(this.orient(headingD, pitchD, rollD), tq);
    const hq = this.segQuat(v, this.headSeg);
    const eHd = this.err(this.orient(headingD, cmd.headTuck ? 0.6 : -0.05 + 0.2 * sink + 0.3 * Math.max(0, pitchD - 0.3), 0), hq);
    // Spine and neck get ABSOLUTE targets: the rotation from the pelvis (thorax) to the desired thorax
    // (head) orientation, shared over the joints of the chain, plus world-error feedback. Absolute targets
    // keep the chain from drifting into an S-bend that world feedback alone cannot see.
    const spineDofs = [...this.lumbarDofs, ...this.thoracicDofs];
    const qThD = this.orient(headingD, pitchD, rollD);
    const rSp = qlog(qmul(qThD, qconj(pq)));
    const tSp = this.rotToDofs(v, spineDofs, [rSp[0] + eTh[0] * (g.thoraxAtt - 1), rSp[1] + eTh[1] * (g.thoraxAtt - 1), rSp[2] + eTh[2] * (g.thoraxAtt - 1)]);
    spineDofs.forEach((i, k) => this.stiff(out, i, tSp[k], g.spine));
    const qHdD = this.orient(headingD, cmd.headTuck ? 0.6 : -0.05 + 0.2 * sink + 0.3 * Math.max(0, pitchD - 0.3), 0);
    const rNk = qlog(qmul(qHdD, qconj(tq)));
    const tNk = this.rotToDofs(v, this.neckDofs, [rNk[0] + eHd[0] * (g.headAtt - 1), rNk[1] + eHd[1] * (g.headAtt - 1), rNk[2] + eHd[2] * (g.headAtt - 1)]);
    this.neckDofs.forEach((i, k) => this.stiff(out, i, tNk[k], g.neck));

    // ---- legs
    if (this.standing) {
      for (const L of this.legs) L.phase = 'stance';
      const stance = this.legs.filter((L) => feet[L.k].touching);
      const xiD: Vec3 = [mid[0] + 0.03 * fwdD[0], 0, mid[2] + 0.03 * fwdD[2]];
      let p: Vec3 = [xi[0] + (g.dcmK / w0) * (xi[0] - xiD[0]), 0, xi[2] + (g.dcmK / w0) * (xi[2] - xiD[2])];
      p = this.clampToFeet(p, stance.map((L) => ank[L.k]), stance.map((L) => footFwd[L.k]));
      const Fy = Math.max(0, m * (G + g.heightKp * (hd - c[1]) - g.heightKd * cv[1]));
      const h = Math.max(0.4, c[1]);
      const F: Vec3 = [Fy * (c[0] - p[0]) / h, Fy, Fy * (c[2] - p[2]) / h];
      // Load share: where p lies between the feet across the heading (lateral balance by weight transfer).
      const shares = [0, 0];
      if (stance.length === 2) {
        const rl = dot(ank[0], rightD), rr = dot(ank[1], rightD), rp = dot(p, rightD);
        const a = clamp((rr - rp) / ((rr - rl) || 1e-6), 0, 1);
        shares[0] = a; shares[1] = 1 - a;
      } else if (stance.length === 1) shares[stance[0].k] = 1;
      for (const L of this.legs) this.stanceLeg(v, L, out, F, shares[L.k], p, ank[L.k], footFwd[L.k], ePel, stance.length);
      // Hip strategy: the trunk balance torque of the stepping cycle, through the feet that carry weight. Its
      // reaction moves the ground force beyond the centre of pressure, which is what lets a person caught on
      // one foot after a shove stop the fall without stepping.
      const pw = this.segVec(s.segAngVel, this.pelvisSeg), mgh = m * G * this.standCom * g.standTorso, fSum = feet[0].force + feet[1].force;
      const Tt: Vec3 = [mgh * (g.torsoKp * ePel[0] - g.torsoKd * pw[0]), 0, mgh * (g.torsoKp * ePel[2] - g.torsoKd * pw[2])];
      if (fSum > 0) for (const L of this.legs) {
        const wk = feet[L.k].force / fSum, tH = this.rotToDofs(v, L.hip, [-Tt[0] * wk, 0, -Tt[2] * wk]);
        L.hip.forEach((i, k) => (out.tff[i] += tH[k]));
      }
      this.dbg = { mode: 'stand', cpOut, speed, px: p[0], pz: p[2], shareL: shares[0] };
    } else if (this.runMode) {
      this.runCycle(v, out, c, cv, vd, headingD, fwdD, rightD, ank, footFwd, pitchD, rollD, hd, speed);
    } else {
      const st = this.legs[this.stanceIdx], sw = this.legs[1 - this.stanceIdx];
      st.phase = 'stance'; sw.phase = 'swing';
      this.stepCycle(v, st, sw, out, c, cv, vd, headingD, fwdD, rightD, w0, stepT, running, this.chopStep, pitchD, rollD, ank[st.k], footFwd[st.k], hd);
      this.dbg = { mode: 'step', stance: st.k, t: this.walkT, stepT, cpOut, speed, vd: vdMag };
    }

    this.armsControl(v, cmd, out, running, vRef);
    this.gravityComp(v, [...this.lumbarDofs, ...this.thoracicDofs, ...this.neckDofs], out);
    for (const A of this.arms) this.gravityComp(v, [...A.sc, A.flex, A.abd, A.rot, A.elbow, A.pron, ...A.wrist], out);
    if (!this.standing && !this.runMode) this.gravityComp(v, this.legs[1 - this.stanceIdx].chain, out);
    // Target velocity = how fast each final target moves (lets damping follow motion instead of resisting it).
    for (let i = 0; i < this.muscles.n; i++) {
      const prev = this.prevQ[i];
      const raw = this.tracking[i] && !Number.isNaN(prev) ? clamp((out.q[i] - prev) / v.dt, -10, 10) : 0;
      this.qdFilt[i] += (raw - this.qdFilt[i]) * Math.min(1, v.dt / 0.03); // ~30 ms smoothing
      out.qd[i] = this.tracking[i] ? this.qdFilt[i] : 0;
      this.prevQ[i] = out.q[i];
    }
  }



  /** Dive (whole-body move): legs drive explosively (hip and knee extension, ankles plantarflex) while the
   *  trunk pitches forward and the arms reach; stepping and balance are released. Physics decides how far
   *  and where the body goes. */
  private dive(v: BodyView, cmd: Commands, out: MuscleTargets, headingD: number) {
    const s = v.state, g = this.gains;
    // phases: load (lean the trunk forward over the feet, bend the knees, arms back), explode (knees and
    // ankles extend while the COM is ahead of the feet, so the push sends the body forward), fly/land.
    const t = 0.7 - this.diveT;
    const phase = t < 0.18 ? 'load' : t < 0.38 ? 'explode' : 'fly';
    const pq = this.segQuat(v, this.pelvisSeg);
    for (const L of this.legs) {
      const hip = phase === 'load' ? 0.9 : phase === 'explode' ? 0.5 : 0.1;
      const knee = phase === 'load' ? 0.9 : phase === 'explode' ? 0.0 : 0.3;
      const ankle = phase === 'load' ? 0.2 : phase === 'explode' ? -0.8 : -0.3;
      this.stiff(out, L.hip[0], hip, 3);
      this.stiff(out, L.hip[1], 0, 1.5);
      this.stiff(out, L.hip[2], 0, 1);
      this.stiff(out, L.knee[0], knee, 3);
      this.stiff(out, L.ankle[0], ankle, 3);
      this.stiff(out, L.toe, phase === 'explode' ? 0.5 : 0.1, 1);
    }
    // trunk rotates forward toward horizontal (spine flexes, pelvis tips through the hips)
    const qD = this.orient(headingD, 1.25, 0.3 * cmd.lean.side);
    const r = qlog(qmul(qD, qconj(pq)));
    const spineDofs = [...this.lumbarDofs, ...this.thoracicDofs];
    const ts = this.rotToDofs(v, spineDofs, [r[0] * 0.3, r[1] * 0.3, r[2] * 0.3]);
    spineDofs.forEach((i, k) => this.stiff(out, i, ts[k], g.spine));
    this.neckDofs.forEach((i) => this.stiff(out, i, s.q[i] * 0.5 - 0.2 * (i === this.neckDofs[0] ? 1 : 0), g.neck));
    for (const A of this.arms) {
      this.freq(out, A.flex, phase === 'load' ? -0.6 : 2.3, g.armWn * 1.5);
      this.freq(out, A.abd, 0.1, g.armWn);
      this.freq(out, A.rot, 0, g.armWn);
      this.freq(out, A.elbow, cmd.wrap ? 1.4 : 0.2, g.armWn * 1.5);
      for (const w of A.wrist) this.freq(out, w, 0, g.armWn * 0.5);
    }
    this.gravityComp(v, [...spineDofs, ...this.neckDofs], out);
    this.dbg = { mode: 'dive', t: this.diveT };
  }

  /** One SIMBICON-style step: the swing thigh is aimed by balance feedback (capture point), the stance
   *  hip holds the trunk upright and cancels the swing hip's reaction, the stance knee/ankle carry weight. */
  private stepCycle(v: BodyView, st: Leg, sw: Leg, out: MuscleTargets, c: Vec3, cv: Vec3, vd: Vec3, headingD: number, fwdD: Vec3, rightD: Vec3,
    w0: number, T: number, running: boolean, chop: boolean, pitchD: number, rollD: number, stAnkle: Vec3, stFwd: Vec3, hd: number) {
    const s = v.state, g = this.gains, m = this.mass;
    const pq = this.segQuat(v, this.pelvisSeg), pw = this.segVec(s.segAngVel, this.pelvisSeg);
    const sPh = clamp(this.walkT / T, 0, 1);
    // --- swing thigh: where the foot should land relative to the COM (heading frame)
    const outD: Vec3 = [-rightD[0] * sw.side, 0, -rightD[2] * sw.side]; // outward for the swing side
    const vS = dot(cv, fwdD), vL = dot(cv, outD), vdS = dot(vd, fwdD), vdL = dot(vd, outD);
    const b = 1 / (Math.exp(w0 * T) - 1);
    // Aim a little short of the capture point (footMargin) so the stance ankle can finish the job. No farther
    // ahead than stepMax: from upright hips a straight leg only reaches the turf close under the body, so a
    // foothold that chases a receding capture point keeps the foot in the air while the body falls; a big
    // push is caught over several shorter steps instead (N-step capturability).
    const offS = clamp(vS / w0 + g.footK * (vS - vdS) - vdS * T * b - (vS > vdS ? g.footMargin : 0), -0.15, g.stepMax);
    // Lateral: periodic capture-point gait (Englsberger 2015): land outside the capture point by
    // W / (1 + e^(ωT)) for a step width W. This is deadbeat: any sway error is gone after one step. Extra
    // feedback on top over-places the foot, and the error comes back e^(ωT) ≈ 4× larger the next step.
    // The swing foot never lands closer than about the hip width (stepWidthMin) to the stance foot: a crossover
    // step drives the thighs and feet into each other (contacts of 1–2 kN that trap the swing leg), and a foot set
    // down in line with the other leaves no lateral base.
    const offL = Math.max(clamp(vL / w0 + g.stepWidth / (1 + Math.exp(w0 * T)) - vdL * T * b, -0.12, 0.55),
      dot([stAnkle[0] - c[0], 0, stAnkle[2] - c[2]], outD) + g.stepWidthMin);
    // Foothold from balance feedback; the foot travels there from where it lifted off along a clearance
    // arc (over the foothold by 80 % of the step, then sets down), solved by leg IK.
    const hold: Vec3 = [c[0] + fwdD[0] * offS + outD[0] * offL, 0, c[2] + fwdD[2] * offS + outD[2] * offL];
    sw.target = hold;
    // The trajectory runs ~30 ms ahead of the clock: the swing joints track their targets with about that
    // lag, and without the lead the foot arrives late, behind and still high.
    const wPh = clamp((this.walkT + 0.03) / T, 0, 1);
    const u = Math.min(1, wPh / 0.8), ease = u * u * (3 - 2 * u);
    // Chopping steps barely lift the feet: a walking-height lift in a 0.22 s step has no time to come back
    // down, so the leg lands late on a bent knee, the foot misses its foothold and the swing whips the pelvis.
    const clear = running ? g.clearance + 0.02 + 0.02 * Math.hypot(cv[0], cv[2]) : chop ? g.chopClear : g.clearance;
    // height starts from where the ankle lifted off (heel up after push-off), else the IK would press the toes into the turf
    // Late in the swing the target sinks below the turf at the foothold: the IK then reaches out with a straight
    // leg and the foot lands when the leg arrives (a bent-knee landing has to straighten under full load, which
    // bounces the body off the ground).
    const reach = clamp((wPh - g.reachStart) / Math.max(0.05, 1 - g.reachStart), 0, 1);
    const ankT: Vec3 = [lerp(sw.liftPos[0], hold[0], ease), lerp(Math.max(sw.ankleH, sw.liftPos[1]), sw.ankleH, ease) + clear * Math.sin(Math.PI * Math.min(1, wPh / 0.9)) ** 2 - 0.06 * reach * reach * (3 - 2 * reach), lerp(sw.liftPos[2], hold[2], ease)];
    sw.ankT = ankT;
    const pelvisPos = this.segVec(s.segPos, this.pelvisSeg);
    const hoff = qrot(pq, sw.hipOff);
    const rel = qrot(qconj(pq), [ankT[0] - pelvisPos[0] - hoff[0], ankT[1] - pelvisPos[1] - hoff[1], ankT[2] - pelvisPos[2] - hoff[2]]);
    // The swing thigh is not rotated toward the heading: turning it in the hip yaws the pelvis the other
    // way (the stance foot can return only ~40 N·m), which grows the heading error it was meant to fix and
    // spun the pelvis ±25° per step even at 0.5 m/s. The trunk yaw torque through the stance hip turns the body.
    const hipRot = 0;
    const [hipFlex, hipAbd, kneeIK] = this.legIK(sw, rel, hipRot);
    const knee = kneeIK + (running ? 1.0 * Math.sin(Math.PI * Math.min(1, sPh / 0.7)) : 0); // heel recovery when running
    const pelvisPitch = -Math.asin(clamp(qrot(pq, [0, 0, 1])[1], -1, 1));
    this.freq(out, sw.hip[0], hipFlex, g.swingWn);
    this.freq(out, sw.hip[1], hipAbd, g.swingWn);
    this.freq(out, sw.hip[2], hipRot, g.swingWn * 1.5);
    this.freq(out, sw.knee[0], knee, g.swingWn);
    this.freq(out, sw.knee[1], 0, g.swingWn * 0.5);
    // foot kept level-to-toes-up through the swing so the toes cannot catch the turf
    this.freq(out, sw.ankle[0], pelvisPitch - hipFlex + knee + 0.15, g.swingWn * 2);
    // sole kept level side to side (an adducted or abducted leg would otherwise land on the foot's edge)
    this.freq(out, sw.ankle[1], this.levelSole(v, sw), g.swingWn * 0.5);
    this.freq(out, sw.toe, 0.15, g.swingWn * 0.5);
    // --- stance knee and ankle: posture + gravity compensation through J-transpose at the mid-foot
    // A foot that lands on a bent knee yields first and extends over ~0.2 s (loading response): snapping
    // straight under full load vaults the body up, unloads the foot and leaves it trailing.
    const yieldK = Math.max(0, st.kneeLand - g.stanceKneeBend) * Math.max(0, 1 - this.walkT / 0.2);
    this.stiff(out, st.knee[0], g.stanceKneeBend + yieldK, g.stanceKnee);
    this.stiff(out, st.knee[1], 0, g.stanceKnee * 0.5);
    // Push-off: late in stance the heel rises and the ankle plantarflexes (toes stay down), which lengthens
    // the trailing leg and drives the body forward, as in human walking and running. Push-off work grows with
    // the speed the athlete wants (full from 1 m/s); stepping to stop after a shove it would drive the body on.
    // (This also covers chopping the feet in place: the foot is under the body, and a push-off would shove it back.)
    const push = clamp((sPh - g.pushStart) / Math.max(0.05, 1 - g.pushStart), 0, 1) * clamp(vdS, 0, 1);
    this.stiff(out, st.ankle[0], -g.pushAnkle * push, g.stanceAnkle * (1 + 3 * push));
    this.stiff(out, st.ankle[1], this.levelSole(v, st), g.stanceAnkle); // flat on the turf under a leaning leg
    this.stiff(out, st.toe, 0.5 * push, g.posture * (1 + 2 * push));
    // In-stance balance: the capture-point law picks the centre of pressure inside the stance foot and
    // the matching ground force (ankle strategy), as in quiet standing.
    const xi: Vec3 = [c[0] + cv[0] / w0, 0, c[2] + cv[2] / w0];
    const xiD: Vec3 = [xi[0] + (vd[0] - cv[0]) / w0, 0, xi[2] + (vd[2] - cv[2]) / w0];
    // The DCM moves at ω(ξ − p): to carry it along at the desired speed the pressure sits vd/ω behind it
    // (under the COM when on speed). Without that term p = ξ, a full v/ω ahead of the COM, and every stance
    // braked (walking topped out at ~0.8 m/s).
    const pDes: Vec3 = [xi[0] - vd[0] / w0 + (g.dcmK / w0) * (xi[0] - xiD[0]), 0, xi[2] - vd[2] / w0 + (g.dcmK / w0) * (xi[2] - xiD[2])];
    // during push-off the pressure may move out to the ball of the foot
    const pf = push > 0 ? this.clampToFootRange(pDes, stAnkle, stFwd, HandController.TOE + 0.06 * push) : this.clampToFeet(pDes, [stAnkle], [stFwd]);
    const h = Math.max(0.4, c[1]);
    // The knee pushes for the height-regulating vertical force (keeps the hips up so the next foot lands
    // on a nearly straight leg). The ankle is scaled by the load this foot actually carries: asking it for
    // torque against weight that is not on the foot just rolls the foot onto its toes. It never exceeds
    // the planned force either: a landing or bounce spike (1.5–2 g) fed straight back into ankle torque
    // pushed the heel up, which raised the load further and launched the body.
    const Fy = clamp(m * (G + g.heightKp * (hd - c[1]) - g.heightKd * cv[1]), 0, 2.5 * m * G);
    const load = Math.min(Fy, clamp(v.feet[st.k].force, 0, 1.5 * m * G));
    // A stance foot that has been pushed off the ground cannot push back: every ground-force and trunk
    // torque through it is scaled by how loaded it actually is (otherwise it flings the leg).
    const grounded = clamp(v.feet[st.k].force / (0.3 * m * G), 0, 1);
    const Fk: Vec3 = [grounded * Fy * (c[0] - pf[0]) / h, grounded * Fy, grounded * Fy * (c[2] - pf[2]) / h];
    const Fa: Vec3 = [load * (c[0] - pf[0]) / h, load, load * (c[2] - pf[2]) / h];
    for (const [dofs, F] of [[st.knee, Fk], [st.ankle, Fa]] as const) for (const i of dofs) {
      const a = this.anchor(v, i);
      out.tff[i] += -dot(cross(this.axis(v, i), [pf[0] - a[0], pf[1] - a[1], pf[2] - a[2]]), F);
    }
    // --- stance hip: trunk balance torque on the pelvis, plus cancel the swing hip's reaction on it
    const e = this.err(this.orient(headingD, clamp(0.3 * pitchD, -0.1, 0.25), 0.3 * rollD), pq);
    const mgh = m * G * this.standCom;
    // Yaw: full trunk control, but the yaw torque is capped at what the stance foot can transmit through
    // cleat rotational traction (~50 N·m per kN of load [S5]); more would just spin the foot.
    const yawCap = 0.8 * 0.05 * Math.max(0, v.feet[st.k].force);
    const yawT = clamp(mgh * (g.torsoKp * g.yawGain * e[1] - g.torsoKd * g.yawGain * pw[1]), -yawCap, yawCap);
    const Ttorso: Vec3 = [mgh * (g.torsoKp * e[0] - g.torsoKd * pw[0]), yawT, mgh * (g.torsoKp * e[2] - g.torsoKd * pw[2])];
    const R: Vec3 = [0, 0, 0];
    for (const i of sw.hip) {
      const tau = this.estTorque(out, i, s.q[i], s.qd[i]);
      const a = this.axis(v, i);
      R[0] += tau * a[0]; R[1] += tau * a[1]; R[2] += tau * a[2];
    }
    // the whole yaw torque through the stance foot (trunk + swing reaction) must stay under cleat traction
    const yawAll = clamp(Ttorso[1] + R[1], -yawCap, yawCap);
    const tH = this.rotToDofs(v, st.hip, [-(Ttorso[0] + R[0]) * grounded, -yawAll * grounded, -(Ttorso[2] + R[2]) * grounded]);
    st.hip.forEach((i, k) => { this.stiff(out, i, s.q[i], 0.1); out.tff[i] += tH[k]; });
  }

  /** Leg IK in the pelvis frame: hip flexion, abduction and knee flexion that put the ankle at `rel` (from
   *  the hip centre) for a given hip internal rotation. Exact for the hip's flex → abd → rotation joint order:
   *  with the knee bent, rotation swings the shank sideways and abduction moves only the hip-to-knee-plane
   *  part of the leg, so both are solved for instead of treating the leg as a straight line. */
  private legIK(L: Leg, rel: Vec3, rot: number): [number, number, number] {
    const n = Math.hypot(...rel) || 1, d = Math.min(n, (L.L1 + L.L2) * 0.995);
    const knee = Math.PI - Math.acos(clamp((L.L1 ** 2 + L.L2 ** 2 - d * d) / (2 * L.L1 * L.L2), -1, 1));
    // ankle in the hip frame before flexion: (side·(A·sin a + Bs·cos a), Bs·sin a − A·cos a, −B·cos r)
    const A = L.L1 + L.L2 * Math.cos(knee), B = L.L2 * Math.sin(knee), Bs = B * Math.sin(rot);
    const p: Vec3 = [rel[0] * d / n, rel[1] * d / n, rel[2] * d / n];
    const abd = Math.asin(clamp(L.side * p[0] / Math.hypot(A, Bs), -1, 1)) - Math.atan2(Bs, A);
    const fl = Math.atan2(-B * Math.cos(rot), Bs * Math.sin(abd) - A * Math.cos(abd)) - Math.atan2(p[2], p[1]);
    return [Math.atan2(Math.sin(fl), Math.cos(fl)), abd, knee];
  }

  /** Ankle inversion angle that sets the sole level side to side. */
  private levelSole(v: BodyView, L: Leg) {
    const fu = qrot(this.segQuat(v, L.foot), [0, 1, 0]);
    return v.state.q[L.ankle[1]] + this.rotToDofs(v, [L.ankle[1]], cross(fu, [0, 1, 0]))[0];
  }

  /** Footprint of a foot: from heel to toe tip along its forward direction, ± half width. */
  // TOE stops at the ball of the foot (~MTP): pressing further rolls the foot onto its toes, where
  // rotational grip is small and the foot spins.
  private static readonly HEEL = 0.05; private static readonly TOE = 0.13; private static readonly HALF_W = 0.04;

  private clampToFeet(p: Vec3, ankles: Vec3[], fwds: Vec3[]): Vec3 {
    if (ankles.length === 0) return p;
    // Clamp into the union of foot rectangles (exact for one foot; for two, clamp to the nearer region of
    // the convex hull by clamping in each foot's frame and taking the closest result, or keep p if inside the hull).
    const local = (a: Vec3, f: Vec3) => { const r: Vec3 = [f[2], 0, -f[0]]; const d: Vec3 = [p[0] - a[0], 0, p[2] - a[2]]; return [dot(d, f), dot(d, r), r] as const; };
    if (ankles.length === 2) {
      // Inside the hull of the two feet? test against the quadrilateral spanned by both feet's centres.
      const [f0, r0] = local(ankles[0], fwds[0]), [f1, r1] = local(ankles[1], fwds[1]);
      const inF = Math.max(f0, f1) > -HandController.HEEL && Math.min(f0, f1) < HandController.TOE;
      const between = (r0 >= -HandController.HALF_W || r1 >= -HandController.HALF_W) && (r0 <= HandController.HALF_W || r1 <= HandController.HALF_W);
      const lat = Math.sign(r0) !== Math.sign(r1);
      if (inF && (lat || between)) {
        // limit fore–aft to the feet's range
        const fa = clamp(f0, -HandController.HEEL, HandController.TOE) - f0;
        return [p[0] + fa * fwds[0][0], 0, p[2] + fa * fwds[0][2]];
      }
    }
    let best = p, bd = Infinity;
    ankles.forEach((a, k) => {
      const [fw, rt, r] = local(a, fwds[k]);
      const cf = clamp(fw, -HandController.HEEL, HandController.TOE), cr = clamp(rt, -HandController.HALF_W, HandController.HALF_W);
      const q: Vec3 = [a[0] + cf * fwds[k][0] + cr * r[0], 0, a[2] + cf * fwds[k][2] + cr * r[2]];
      const d = Math.hypot(q[0] - p[0], q[2] - p[2]);
      if (d < bd) { bd = d; best = q; }
    });
    return best;
  }


  /** Running (spring-mass / Raibert), built around what goes wrong in this body:
   *  - the stance phase is measured by where the COM is over the foot (not by a clock), so it starts and ends
   *    with the real contact, and a late or early landing just enters the push profile part-way;
   *  - the stance leg pushes a half-sine force along the foot–COM line, sized to carry body weight over the
   *    whole step, plus vertical-velocity feedback; its horizontal part is offset to take out whole-body
   *    angular momentum (a foot that is dragged or lands moving trips the body forward);
   *  - swing legs are timed by the predicted next touchdown, reach their foothold early, fold the knee for
   *    clearance and retract before touchdown so the foot lands with little ground speed;
   *  - speed comes from Raibert foot placement relative to the COM.
   *  Contact and cadence follow Weyand et al. [S4], scaled to this body's leg reach and hip speed. */
  private runCycle(v: BodyView, out: MuscleTargets, c: Vec3, cv: Vec3, vd: Vec3, headingD: number, fwdD: Vec3, rightD: Vec3,
    ank: Vec3[], footFwd: Vec3[], pitchD: number, rollD: number, hd: number, speed: number) {
    const s = v.state, g = this.gains, m = this.mass, feet = v.feet;
    const vRef = Math.max(speed, Math.hypot(vd[0], vd[2]));
    const travel: Vec3 = speed > 0.3 ? [cv[0] / speed, 0, cv[2] / speed] : fwdD;
    const vAlong = dot(cv, travel);
    // contact: the COM travels from X behind the ball of the foot to Xb past it
    const Tc = clamp((RUN.X + RUN.Xb) / Math.max(vAlong, 1), 0.12, 0.4);
    const Ts = Math.max(Tc + RUN.flight, 1 / clamp(2.6 + 0.22 * vRef, 2.6, 4.8));
    this.walkT += v.dt;
    const ball = (k: number): Vec3 => [ank[k][0] + RUN.cop * footFwd[k][0], 0, ank[k][2] + RUN.cop * footFwd[k][2]];
    // stance phase 0..1 from the COM's position over the foot (0.5 = COM above the ball of the foot)
    const phOf = (k: number) => { const r = dot([c[0] - ball(k)[0], 0, c[2] - ball(k)[2]], travel); return clamp(r < 0 ? 0.5 + 0.5 * r / RUN.X : 0.5 + 0.5 * r / RUN.Xb, 0, 1); };
    const lift = (L: Leg) => { L.phase = 'swing'; L.t = 0; L.liftPos = ank[L.k]; L.liftQ = [s.q[L.hip[0]], s.q[L.knee[0]]]; };
    const st = this.legs[this.stanceIdx], nl = this.legs[1 - this.stanceIdx];
    // stance leg lifts once the COM has passed over it, or once it has unloaded after mid-stance
    if (st.phase === 'stance' && (phOf(st.k) >= 1 || (phOf(st.k) > 0.6 && feet[st.k].force < 0.1 * m * G) || this.walkT > 2 * Tc)) lift(st);
    if (nl.phase !== 'swing') lift(nl);
    for (const L of this.legs) if (L.phase === 'swing') L.t += v.dt;
    // Time left to the next touchdown: the rest of the contact, then the ballistic fall to the height where the
    // extended leg meets the turf at the foothold. Swing legs are timed by it, so a short flight finds the leg
    // already reaching instead of mid-swing.
    const legL = this.legs[0].L1 + this.legs[0].L2;
    const hTD = this.standCom - legL + Math.sqrt(Math.max(0, (0.97 * legL) ** 2 - (vAlong * Tc / 2) ** 2));
    const fall = (y: number, vy: number) => (y > hTD ? (vy + Math.sqrt(vy * vy + 2 * G * (y - hTD))) / G : 0);
    const nextIn = () => (this.legs[this.stanceIdx].phase === 'stance' ? (1 - phOf(this.stanceIdx)) * Tc + fall(c[1], G * (Ts - Tc) / 2) : fall(c[1], cv[1]));
    // touchdown of the next leg (real load, past the first part of its swing) starts its stance
    if (feet[nl.k].touching && feet[nl.k].force > 0.1 * m * G && nl.t > RUN.tdFrac * (nl.t + nextIn())) {
      this.stanceIdx = nl.k; this.walkT = 0; nl.phase = 'stance';
      if (st.phase === 'stance') lift(st);
    }
    const tNext = nextIn();
    const pq = this.segQuat(v, this.pelvisSeg), pw = this.segVec(s.segAngVel, this.pelvisSeg);
    const pelvisPitch = -Math.asin(clamp(qrot(pq, [0, 0, 1])[1], -1, 1));
    const mgh = m * G * this.standCom;
    const Lw = this.angMom(v);
    let Tpel: Vec3 = [0, 0, 0];
    for (const L of this.legs) {
      if (L.phase === 'stance') {
        // --- stance: half-sine push along the foot–COM line, through the whole leg at the ball of the foot
        const ph = phOf(L.k);
        const kh = clamp(1 + g.runHeightK * (hd - c[1]), 0.6, 1.5);
        // vertical velocity feedback toward the spring-mass profile: −v_TO at touchdown to +v_TO at take-off
        const vTO = G * (Ts - Tc) / 2, vyErr = -vTO * Math.cos(Math.PI * ph) - cv[1];
        const Fy = clamp((m * G * (Ts / Tc) * (Math.PI / 2) * kh * g.runPush + m * RUN.kv * vyErr) * Math.sin(Math.PI * ph), 0, 2.5 * m * G);
        const pf = ball(L.k), h = Math.max(0.4, c[1]);
        // speed is held by foot placement; a small drive through the foot trims the remaining error
        const Fh = clamp(m * g.runAccel * (dot(vd, travel) - vAlong), -0.3 * Fy, 0.3 * Fy);
        const gr = clamp(feet[L.k].force / (0.2 * m * G), 0, 1);
        // Whole-body angular momentum: a horizontal ground force at the foot, h below the COM, turns the body
        // (r × F = −h ŷ × F), so the force line is moved off the COM to take out pitch and roll momentum.
        const kl = RUN.kl / h;
        const F: Vec3 = [(Fy * (c[0] - pf[0]) / h + travel[0] * Fh - kl * Lw[2]) * gr, Fy * gr, (Fy * (c[2] - pf[2]) / h + travel[2] * Fh + kl * Lw[0]) * gr];
        for (const i of L.chain) {
          const a = this.anchor(v, i);
          out.tff[i] += -RUN.force * dot(cross(this.axis(v, i), [pf[0] - a[0], pf[1] - a[1], pf[2] - a[2]]), F);
        }
        this.stiff(out, L.knee[0], RUN.kneeBend, g.stanceKnee * RUN.kneeStiff);
        this.stiff(out, L.knee[1], 0, g.stanceKnee * 0.5);
        this.stiff(out, L.ankle[0], s.q[L.ankle[0]], g.stanceAnkle);
        this.stiff(out, L.ankle[1], 0, g.stanceAnkle);
        this.stiff(out, L.toe, 0.3 * ph, g.posture * 2);
        // trunk balance torque, applied after the swing legs are known (see below)
        const e = this.err(this.orient(headingD, clamp(0.3 * pitchD, -0.1, 0.3), 0.3 * rollD), pq);
        const yawCap = 0.8 * 0.05 * Math.max(0, feet[L.k].force);
        const yawT = clamp(mgh * (RUN.torsoKp * g.yawGain * e[1] - RUN.torsoKd * g.yawGain * pw[1]), -yawCap, yawCap);
        Tpel = [mgh * (RUN.torsoKp * e[0] - RUN.torsoKd * pw[0]), yawT, mgh * (RUN.torsoKp * e[2] - RUN.torsoKd * pw[2])];
        L.hip.forEach((i) => this.stiff(out, i, s.q[i], 0.1));
      } else {
        // --- swing, in joint space as in running kinematics: the thigh travels from where it lifted to the
        // touchdown angle that puts the foot on the Raibert foothold, the knee folds the leg to swing it
        // (heel recovery) and is straight again before touchdown. Its duration: the next leg lands in tNext,
        // the trailing one a step after that.
        const Tl = L.t + (L.k === this.stanceIdx ? tNext + Ts : tNext);
        const sPh = clamp(L.t / Tl, 0, 1);
        const outD: Vec3 = [-rightD[0] * L.side, 0, -rightD[2] * L.side];
        // Raibert: neutral point (COM travel to mid-stance) plus feedback on the velocity error, per axis; the
        // feet stay a hip width apart, or the thighs collide as the swing leg passes the stance leg
        const land: Vec3 = [cv[0] * Tc / 2 + g.runFootK * (cv[0] - vd[0]) + outD[0] * RUN.width, 0, cv[2] * Tc / 2 + g.runFootK * (cv[2] - vd[2]) + outD[2] * RUN.width];
        // touchdown pose by leg IK to the foothold, a little below the turf so the leg arrives extended
        const ankT: Vec3 = [c[0] + land[0], L.ankleH - RUN.reachBelow, c[2] + land[2]];
        L.target = ankT; L.ankT = ankT;
        const pelvisPos = this.segVec(s.segPos, this.pelvisSeg), hoff = qrot(pq, L.hipOff);
        const rel = qrot(qconj(pq), [ankT[0] - pelvisPos[0] - hoff[0], ankT[1] - pelvisPos[1] - hoff[1], ankT[2] - pelvisPos[2] - hoff[2]]);
        const n = Math.hypot(...rel) || 1, d = Math.min(n, legL * 0.995);
        const dir: Vec3 = [rel[0] / n, rel[1] / n, rel[2] / n];
        const kneeTD = Math.PI - Math.acos(clamp((L.L1 ** 2 + L.L2 ** 2 - d * d) / (2 * L.L1 * L.L2), -1, 1));
        const alpha = Math.acos(clamp((L.L1 ** 2 + d * d - L.L2 ** 2) / (2 * L.L1 * d), -1, 1));
        const hipTD = Math.atan2(dir[2], -dir[1]) + alpha, hipAbd = Math.asin(clamp(dir[0] * L.side, -1, 1));
        const u = Math.min(1, sPh / RUN.reachAt), ease = u * u * (3 - 2 * u);
        const fold = g.runHeel * clamp(vRef / 5, 0.5, 1) * Math.sin(Math.PI * Math.min(1, sPh / RUN.foldEnd));
        // Swing-leg retraction: in the last moments the thigh rotates back at the rate that brings the foot's
        // ground speed toward zero at touchdown (a forward-moving foot is braked by friction and trips the body).
        const tR = Math.max(RUN.reachAt * Tl, Tl - RUN.retractT), wr = RUN.retract * Math.max(0, vAlong) / legL;
        let hipFlex = L.t < tR ? lerp(L.liftQ[0], hipTD + wr * (Tl - tR), ease) : Math.max(hipTD - 0.3, hipTD + wr * (Tl - L.t));
        // About to touch down anyway (foot near the turf and falling): retract to match the foot's ground speed.
        const footV = this.segVec(s.segVel, L.foot);
        if (sPh > 0.3 && ank[L.k][1] - L.ankleH < RUN.nearH && footV[1] < 0) hipFlex = Math.min(hipFlex, s.q[L.hip[0]] - RUN.nearK * dot(footV, travel) / legL);
        let knee = lerp(L.liftQ[1], kneeTD, ease) + fold;
        // Clearance from the actual leg: until the thigh is near its touchdown angle, the knee folds at least
        // enough to keep the ankle above the turf (a foot that lands behind the body while swinging trips it).
        const th = s.q[L.hip[0]] - pelvisPitch, hipY = this.anchor(v, L.hip[0])[1];
        if (th < hipTD - pelvisPitch - 0.3) knee = Math.max(knee, th + Math.acos(clamp((hipY - L.L1 * Math.cos(th) - L.ankleH - RUN.clear) / L.L2, -1, 1)));
        this.freq(out, L.hip[0], hipFlex, RUN.swingWn);
        this.freq(out, L.hip[1], hipAbd, RUN.swingWn);
        this.freq(out, L.hip[2], 0, RUN.swingWn * 0.6);
        this.freq(out, L.knee[0], knee, RUN.swingWn);
        this.freq(out, L.knee[1], 0, RUN.swingWn * 0.5);
        this.freq(out, L.ankle[0], pelvisPitch - hipFlex + knee + 0.15, RUN.swingWn * 2);
        this.freq(out, L.ankle[1], 0, RUN.swingWn * 0.5);
        this.freq(out, L.toe, 0.15, RUN.swingWn * 0.5);
        this.gravityComp(v, L.chain, out);
      }
    }
    // stance hip: trunk balance plus cancelling both swing hips' reactions on the pelvis
    const stance = this.legs.find((L) => L.phase === 'stance');
    if (stance) {
      const R: Vec3 = [0, 0, 0];
      for (const L of this.legs) if (L !== stance) for (const i of L.hip) {
        const tau = this.estTorque(out, i, s.q[i], s.qd[i]);
        const a = this.axis(v, i);
        R[0] += tau * a[0]; R[1] += tau * a[1]; R[2] += tau * a[2];
      }
      const gr = clamp(feet[stance.k].force / (0.2 * m * G), 0, 1);
      const tH = this.rotToDofs(v, stance.hip, [-(Tpel[0] + R[0]) * gr, -(Tpel[1] + R[1]) * gr, -(Tpel[2] + R[2]) * gr]);
      stance.hip.forEach((i, k) => (out.tff[i] += tH[k]));
    }
    this.dbg = { mode: 'run', stance: this.stanceIdx, t: this.walkT, Tc, Ts, speed, vd: Math.hypot(vd[0], vd[2]), ph: stance ? phOf(stance.k) : -1 };
  }

  /** Clamp into one foot with a custom toe limit, on the foot's centreline. (Keeping the lateral range here
   *  measured worse: jog falls more often.) */
  private clampToFootRange(p: Vec3, ankle: Vec3, fwd: Vec3, toe: number): Vec3 {
    const fw = clamp(dot([p[0] - ankle[0], 0, p[2] - ankle[2]], fwd), -HandController.HEEL, toe);
    return [ankle[0] + fw * fwd[0], 0, ankle[2] + fw * fwd[2]];
  }


  /** Distance the point lies outside the support region (feet ± foot size), 0 if inside. */
  private outsideSupport(p: Vec3, feet: Vec3[], heading: number) {
    const f: Vec3 = [Math.sin(heading), 0, Math.cos(heading)], r: Vec3 = [f[2], 0, -f[0]];
    const coords = feet.map((q) => [dot([q[0], 0, q[2]], f), dot([q[0], 0, q[2]], r)]);
    const pf = dot([p[0], 0, p[2]], f), pr = dot([p[0], 0, p[2]], r);
    const fMin = Math.min(...coords.map((x) => x[0])) - HandController.HEEL, fMax = Math.max(...coords.map((x) => x[0])) + HandController.TOE;
    const rMin = Math.min(...coords.map((x) => x[1])) - HandController.HALF_W, rMax = Math.max(...coords.map((x) => x[1])) + HandController.HALF_W;
    return Math.max(fMin - pf, pf - fMax, rMin - pr, pr - rMax, 0);
  }
  private sideToward(p: Vec3, mid: Vec3, right: Vec3): 0 | 1 {
    return dot([p[0] - mid[0], 0, p[2] - mid[2]], right) > 0 ? 1 : 0;
  }

  private stanceLeg(v: BodyView, L: Leg, out: MuscleTargets, F: Vec3, share: number, p: Vec3, ankle: Vec3, ffwd: Vec3, ePel: Vec3, nStance: number) {
    const s = v.state, g = this.gains;
    // This foot's own centre of pressure: on its centreline (lateral balance is done by load share),
    // fore–aft where p wants it, within heel..toe.
    const fw = clamp(dot([p[0] - ankle[0], 0, p[2] - ankle[2]], ffwd), -HandController.HEEL, HandController.TOE);
    const pf: Vec3 = [ankle[0] + fw * ffwd[0], 0, ankle[2] + fw * ffwd[2]];
    const Fi: Vec3 = [F[0] * share, F[1] * share, F[2] * share];
    // Feed-forward: τ = −Jᵀ F with the pelvis as base (the foot pushes the ground with −F at pf).
    for (const i of L.chain) {
      const a = this.anchor(v, i);
      out.tff[i] += -dot(cross(this.axis(v, i), [pf[0] - a[0], pf[1] - a[1], pf[2] - a[2]]), Fi);
    }
    // Pelvis attitude: rotating the pelvis by +e means the stance hip angles change by −e.
    const w = nStance === 2 ? 0.5 + 0.5 * share : 1;
    // Yaw is corrected gently and capped: cleat rotational traction is only ~50 N·m [S5], so a hard
    // yaw correction through the stance hip just spins the foot. Later steps re-aim the body instead.
    const yawErr = clamp(ePel[1], -0.15, 0.15) * 0.35;
    const dH = this.rotToDofs(v, L.hip, [-ePel[0] * g.pelvisAtt, -yawErr * g.pelvisAtt, -ePel[2] * g.pelvisAtt]);
    L.hip.forEach((i, k) => this.stiff(out, i, s.q[i] + dH[k], g.stanceHip * w));
    this.stiff(out, L.knee[0], 0.12, g.stanceKnee);
    this.stiff(out, L.knee[1], 0, g.stanceKnee * 0.5);
    this.stiff(out, L.ankle[0], s.q[L.ankle[0]], g.stanceAnkle); // ankle follows the ground; torque comes from the COP law
    this.stiff(out, L.ankle[1], s.q[L.ankle[1]], g.stanceAnkle);
    this.stiff(out, L.toe, 0, g.posture);
  }

  private armsControl(v: BodyView, cmd: Commands, out: MuscleTargets, running: boolean, vRef: number) {
    const g = this.gains;
    const hipL = v.state.q[this.legs[0].hip[0]], hipR = v.state.q[this.legs[1].hip[0]];
    for (const A of this.arms) {
      const reach = A.side > 0 ? cmd.armL : cmd.armR;
      // Arms swing against the legs: cancels the yaw the swinging leg puts on the trunk.
      const swingAmp = running ? clamp(0.5 + 0.06 * vRef, 0, 1.1) : g.armSwing;
      const own = A.side > 0 ? hipL : hipR, opp = A.side > 0 ? hipR : hipL;
      let flex = -swingAmp * (own - opp) * 0.9, abd = 0.12, elbow = running ? 1.4 : 0.35, rot = 0, wn = g.armWn;
      if (cmd.contactMode && (reach > 0 || cmd.shoot || cmd.wrap)) {
        flex = lerp(flex, 1.45, Math.max(reach, cmd.shoot || cmd.wrap ? 1 : 0));
        elbow = cmd.shoot ? 0.05 : cmd.wrap ? 1.5 : lerp(elbow, 0.25, reach);
        abd = cmd.wrap ? -0.5 : 0.15;
        rot = cmd.wrap ? 0.4 : 0;
        wn = cmd.shoot ? g.armWn * 2.5 : g.armWn * 1.6;
      }
      if (cmd.carry === (A.side > 0 ? 1 : 2)) {
        // ball tucked: forearm across the ribs, ball pinned between hand, forearm and chest
        flex = 0.35; abd = -0.05; rot = 0.7; elbow = 1.9; wn = g.armWn * 1.6;
      }
      this.freq(out, A.flex, flex, wn);
      this.freq(out, A.abd, abd, wn);
      this.freq(out, A.rot, rot, wn * 0.8);
      this.freq(out, A.elbow, elbow, wn);
      this.freq(out, A.pron, 0, wn * 0.5);
      for (const w of A.wrist) this.freq(out, w, 0, wn * 0.5);
      for (const sc of A.sc) this.stiff(out, sc, 0, g.posture * 2);
    }
  }
}

function solve3(M: number[][], b: Vec3): Vec3 {
  const [a, bb, c] = M[0], [d, e, f] = M[1], [g, h, i] = M[2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return [0, 0, 0];
  const inv = [
    (e * i - f * h) / det, (c * h - bb * i) / det, (bb * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (bb * g - a * h) / det, (a * e - bb * d) / det,
  ];
  return [inv[0] * b[0] + inv[1] * b[1] + inv[2] * b[2], inv[3] * b[0] + inv[4] * b[1] + inv[5] * b[2], inv[6] * b[0] + inv[7] * b[1] + inv[8] * b[2]];
}
