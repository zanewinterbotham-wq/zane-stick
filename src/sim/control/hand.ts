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
  /** Raibert foot-placement feedback on velocity error (s), running. */
  footK: number;
}
export const DEFAULT_GAINS: Gains = {
  posture: 0.6, stanceKnee: 2.0, stanceAnkle: 0.5, stanceHip: 2.5, spine: 3.0, neck: 2.5,
  swingWn: 28, armWn: 12, dampT: 0.05,
  pelvisAtt: 1.0, thoraxAtt: 1.0, headAtt: 1.0,
  dcmK: 3.0, heightKp: 40, heightKd: 12,
  footK: 0.12,
};

/** Target speeds (m/s) for the reference athlete; the body's own limits decide what is reached. */
export const GAIT_SPEED = { walk: 1.6, jog: 4.2, sprint: 10.5 };

const G = 9.81;

type Leg = {
  k: 0 | 1; side: 1 | -1;
  hip: number[]; knee: number[]; ankle: number[]; toe: number;
  chain: number[];               // hip, knee, ankle dofs (for Jacobians)
  foot: number;
  L1: number; L2: number;        // thigh and shank length (m)
  hipOff: Vec3;                  // hip joint centre relative to pelvis origin, pelvis frame
  ankleH: number;                // ankle height above the ground at rest (m)
  phase: 'stance' | 'swing'; t: number; liftPos: Vec3; target: Vec3;
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
  private dt = 1 / 240;
  private lastCpOut = 0;
  private headingHold: number | null = null;
  private prevQ: Float64Array;
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
        phase: 'stance', t: 0, liftPos: [0, 0, 0], target: [0, 0, 0],
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
    const ms = this.muscles, kpMax = 0.5 * ms.ilocal[i] / (this.dt * this.dt);
    const kp = Math.min(s * this.T0[i], kpMax);
    out.q[i] = clamp(q, ms.lo[i], ms.hi[i]);
    out.kp[i] = kp;
    out.kd[i] = Math.max(kp * this.gains.dampT, 1.6 * Math.sqrt(kp * ms.ieff[i]));
    this.tracking[i] = 0;
  }
  /** Natural-frequency PD with the distal inertia (free limbs). */
  private freq(out: MuscleTargets, i: number, q: number, wn: number) {
    if (i < 0) return;
    const ms = this.muscles, I = ms.ieff[i], kpMax = 0.5 * ms.ilocal[i] / (this.dt * this.dt);
    const kp = Math.min(I * wn * wn, kpMax);
    out.q[i] = clamp(q, ms.lo[i], ms.hi[i]);
    out.kp[i] = kp;
    out.kd[i] = 2 * Math.sqrt(kp * I);
    this.tracking[i] = 1;
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
    this.dt = v.dt;
    const g = this.gains, s = v.state, m = this.mass;
    out.tff.fill(0);
    for (let i = 0; i < this.muscles.n; i++) this.stiff(out, i, 0, g.posture);

    const pq = this.segQuat(v, this.pelvisSeg);
    const heading = headingOf(qrot(pq, [0, 0, 1]));
    const c = s.com, cv = s.comVel;
    const speedCap = GAIT_SPEED[cmd.gait] * this.plan.params.speed;
    const mvLen = Math.hypot(cmd.move.x, cmd.move.z), mv = Math.min(1, mvLen);
    const vd: Vec3 = mv > 0.05 ? [(cmd.move.x / mvLen) * mv * speedCap, 0, (cmd.move.z / mvLen) * mv * speedCap] : [0, 0, 0];
    const vdMag = Math.hypot(vd[0], vd[2]);
    const faceDir = cmd.face ?? (vdMag > 0.3 ? { x: vd[0], z: vd[2] } : null);
    // Hold the last commanded heading when there is no command (otherwise yaw would be uncontrolled).
    if (this.headingHold === null) this.headingHold = heading;
    if (faceDir) this.headingHold = Math.atan2(faceDir.x, faceDir.z);
    const headingD = this.headingHold;
    const speed = Math.hypot(cv[0], cv[2]);
    const fwdD: Vec3 = [Math.sin(headingD), 0, Math.cos(headingD)];
    const rightD: Vec3 = [Math.cos(headingD), 0, -Math.sin(headingD)];

    // ---- gait timing: cadence and contact time vary with speed [S4]
    const vRef = Math.max(speed, vdMag);
    let stepT = 1 / clamp(1.75 + 0.32 * vRef, 1.75, 4.8);
    const running = vRef > 2.6;
    // Recovery steps are quicker: shorten the step as the capture point leaves the base of support.
    stepT = lerp(stepT, Math.min(stepT, 0.3), clamp(this.lastCpOut / 0.25, 0, 1));
    const stanceT = running ? clamp(0.95 / Math.max(vRef, 0.1), 0.095, stepT * 0.95) : stepT * 1.25;

    // ---- posture intent: COM height, trunk lean
    const sink = clamp(cmd.sink, 0, 1);
    let hd = this.standCom - 0.01 * vRef - sink * 0.3 * (this.plan.params.height / 1.83);
    const accelFwd = dot([vd[0] - cv[0], 0, vd[2] - cv[2]], fwdD);
    let pitchD = clamp(0.015 * vRef + 0.04 * accelFwd, -0.1, 0.4) + 0.55 * sink + 0.45 * cmd.lean.fwd;
    const rollD = 0.3 * cmd.lean.side;
    if (cmd.thrustHips && this.thrustT <= 0) this.thrustT = 0.3;
    if (this.thrustT > 0) { this.thrustT -= v.dt; hd += 0.1; pitchD -= 0.25; }
    if (cmd.dive && this.diveT <= 0) this.diveT = 0.6;
    if (this.diveT > 0) this.diveT -= v.dt;

    // ---- balance state
    const feet = v.feet;
    const w0 = Math.sqrt(G / Math.max(0.4, c[1]));
    const xi: Vec3 = [c[0] + cv[0] / w0, 0, c[2] + cv[2] / w0];        // capture point (DCM)
    const ank = this.legs.map((L) => this.segVec(s.segPos, L.foot));
    const footFwd = this.legs.map((L) => { const f = qrot(this.segQuat(v, L.foot), [0, 0, 1]); const n = Math.hypot(f[0], f[2]) || 1; return [f[0] / n, 0, f[2] / n] as Vec3; });
    const mid: Vec3 = [(ank[0][0] + ank[1][0]) / 2, 0, (ank[0][2] + ank[1][2]) / 2];
    const cpOut = this.outsideSupport(xi, ank, headingD);
    this.lastCpOut = cpOut;

    // ---- stepping state machine
    const wantMove = vdMag > 0.15 || speed > 0.45 || cpOut > 0.03;
    if (this.standing && wantMove) {
      this.standing = false;
      const first = cpOut > 0.03 ? this.sideToward(xi, mid, rightD) : feet[0].force < feet[1].force ? 0 : 1;
      this.startSwing(this.legs[first], v);
      this.legs[1 - first].phase = 'stance'; this.legs[1 - first].t = 0;
    } else if (!this.standing && !wantMove && this.legs.every((L) => L.phase === 'stance') && speed < 0.3) {
      this.standing = true;
    }
    for (const L of this.legs) {
      L.t += v.dt;
      if (this.standing) { L.phase = 'stance'; continue; }
      const f = feet[L.k], other = this.legs[1 - L.k];
      const swingT = running ? Math.max(0.12, 2 * stepT - stanceT) : Math.max(0.3, 2 * stepT - stanceT);
      if (L.phase === 'swing') {
        // Land only near the planned foothold or late in the swing (a scuff mid-swing is not a step).
        const near = Math.hypot(ank[L.k][0] - L.target[0], ank[L.k][2] - L.target[2]) < 0.12;
        if (f.touching && ((near && L.t > 0.5 * swingT) || L.t > 0.85 * swingT)) { L.phase = 'stance'; L.t = 0; }
      } else {
        // One leg swings at a time: only the trailing leg (planted longer) may lift, once the other has
        // taken weight, and only while a step is still wanted.
        const otherLoaded = other.phase === 'stance' && other.t > 0.05 && feet[other.k].force > 0.3 * m * G;
        // the leg to lift is the one farther from where the body is heading (the capture point)
        const dMe = Math.hypot(ank[L.k][0] - xi[0], ank[L.k][2] - xi[2]), dOther = Math.hypot(ank[other.k][0] - xi[0], ank[other.k][2] - xi[2]);
        const trailing = other.phase === 'stance' && (running ? L.t > other.t : dMe > dOther);
        if (wantMove && trailing && ((running && L.t > stanceT) || (!running && otherLoaded))) this.startSwing(L, v);
      }
    }

    // ---- desired centre of pressure and ground force (capture-point law)
    const stance = this.legs.filter((L) => L.phase === 'stance' && feet[L.k].touching);
    let xiD: Vec3;
    if (this.standing) xiD = [mid[0] + 0.03 * fwdD[0], 0, mid[2] + 0.03 * fwdD[2]];
    else xiD = [xi[0] + (vd[0] - cv[0]) / w0, 0, xi[2] + (vd[2] - cv[2]) / w0];
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
    for (const L of this.legs) {
      if (L.phase === 'stance') this.stanceLeg(v, L, out, F, shares[L.k], p, ank[L.k], footFwd[L.k], ePel, stance.length);
      else this.swingLeg(v, L, out, c, cv, vd, xi, w0, rightD, stepT, stanceT, running, p, headingD);
    }

    this.armsControl(v, cmd, out, running, vRef);
    // Target velocity = how fast each final target moves (lets damping follow motion instead of resisting it).
    for (let i = 0; i < this.muscles.n; i++) {
      const prev = this.prevQ[i];
      const raw = this.tracking[i] && !Number.isNaN(prev) ? clamp((out.q[i] - prev) / v.dt, -10, 10) : 0;
      this.qdFilt[i] += (raw - this.qdFilt[i]) * Math.min(1, v.dt / 0.03); // ~30 ms smoothing
      out.qd[i] = this.tracking[i] ? this.qdFilt[i] : 0;
      this.prevQ[i] = out.q[i];
    }
    this.dbg = { standing: this.standing ? 1 : 0, legL: this.legs[0].phase, legR: this.legs[1].phase, stepT, stanceT, hd, Fy, cpOut, speed, vd: vdMag, px: p[0], pz: p[2], shareL: shares[0] };
  }

  private startSwing(L: Leg, v: BodyView) {
    L.phase = 'swing'; L.t = 0;
    L.liftPos = this.segVec(v.state.segPos, L.foot);
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

  private swingLeg(v: BodyView, L: Leg, out: MuscleTargets, c: Vec3, cv: Vec3, vd: Vec3, xi: Vec3, w0: number, right: Vec3, stepT: number, stanceT: number, running: boolean, p: Vec3, headingD: number) {
    const s = v.state, g = this.gains;
    const pq = this.segQuat(v, this.pelvisSeg);
    const pelvisPos = this.segVec(s.segPos, this.pelvisSeg);
    const hoff = qrot(pq, L.hipOff);
    const hipW: Vec3 = [pelvisPos[0] + hoff[0], pelvisPos[1] + hoff[1], pelvisPos[2] + hoff[2]];
    const swingT = running ? Math.max(0.12, 2 * stepT - stanceT) : Math.max(0.3, 2 * stepT - stanceT);
    const sPh = clamp(L.t / swingT, 0, 1);
    const remaining = Math.max(0, swingT - L.t);
    let tgt: Vec3;
    if (running) {
      // Raibert: neutral point (half the stance travel ahead) + velocity-error feedback.
      tgt = [c[0] + cv[0] * (remaining + 0.5 * stanceT) + g.footK * (cv[0] - vd[0]), 0, c[2] + cv[2] * (remaining + 0.5 * stanceT) + g.footK * (cv[2] - vd[2])];
    } else {
      // Capture point predicted at touchdown, minus the offset that keeps a steady walk at vd.
      const e = Math.exp(w0 * remaining);
      const xiT: Vec3 = [p[0] + (xi[0] - p[0]) * e, 0, p[2] + (xi[2] - p[2]) * e];
      const b = 1 / (Math.exp(w0 * stepT) - 1);
      tgt = [xiT[0] - vd[0] * stepT * b, 0, xiT[2] - vd[2] * stepT * b];
    }
    // step width: each foot lands a little outside the line of travel
    tgt = [tgt[0] - right[0] * L.side * 0.09, 0, tgt[2] - right[2] * L.side * 0.09];
    L.target = tgt;
    // The foot gets over the foothold by 80 % of the swing, then sets down.
    const u = Math.min(1, sPh / 0.8), e = u * u * (3 - 2 * u);
    const clear = running ? 0.1 + 0.025 * Math.hypot(cv[0], cv[2]) : 0.08;
    const ankleTarget: Vec3 = [lerp(L.liftPos[0], tgt[0], e), L.ankleH + clear * Math.sin(Math.PI * Math.min(1, sPh / 0.9)), lerp(L.liftPos[2], tgt[2], e)];
    const rel = qrot(qconj(pq), [ankleTarget[0] - hipW[0], ankleTarget[1] - hipW[1], ankleTarget[2] - hipW[2]]);
    const n = Math.hypot(...rel) || 1;
    const d = Math.min(n, (L.L1 + L.L2) * 0.995);
    const dir: Vec3 = [rel[0] / n, rel[1] / n, rel[2] / n];
    const kneeFlex = Math.PI - Math.acos(clamp((L.L1 ** 2 + L.L2 ** 2 - d * d) / (2 * L.L1 * L.L2), -1, 1));
    const alpha = Math.acos(clamp((L.L1 ** 2 + d * d - L.L2 ** 2) / (2 * L.L1 * d), -1, 1));
    const hipFlex = Math.atan2(dir[2], -dir[1]) + alpha;
    const hipAbd = Math.asin(clamp(dir[0] * L.side, -1, 1));
    const pelvisPitch = -Math.asin(clamp(qrot(pq, [0, 0, 1])[1], -1, 1));
    const heelUp = running ? 1.0 * Math.sin(Math.PI * sPh) : 0;
    this.freq(out, L.hip[0], hipFlex, g.swingWn);
    this.freq(out, L.hip[1], hipAbd, g.swingWn);
    // Point the landing foot along the desired heading: hip rotation makes up the pelvis yaw error.
    const pelvisYaw = headingOf(qrot(pq, [0, 0, 1]));
    const yawDiff = Math.atan2(Math.sin(headingD - pelvisYaw), Math.cos(headingD - pelvisYaw));
    this.freq(out, L.hip[2], -L.side * clamp(yawDiff, -0.6, 0.6), g.swingWn * 0.6);
    this.freq(out, L.knee[0], kneeFlex + heelUp, g.swingWn);
    this.freq(out, L.knee[1], 0, g.swingWn * 0.5);
    this.freq(out, L.ankle[0], pelvisPitch - hipFlex + kneeFlex + 0.05, g.swingWn * 0.7);
    this.freq(out, L.ankle[1], 0, g.swingWn * 0.5);
    this.freq(out, L.toe, 0.1, g.swingWn * 0.5);
  }

  private armsControl(v: BodyView, cmd: Commands, out: MuscleTargets, running: boolean, vRef: number) {
    const g = this.gains;
    const hipL = v.state.q[this.legs[0].hip[0]], hipR = v.state.q[this.legs[1].hip[0]];
    for (const A of this.arms) {
      const reach = A.side > 0 ? cmd.armL : cmd.armR;
      // Arms swing against the legs: cancels the yaw the swinging leg puts on the trunk.
      const swingAmp = running ? clamp(0.5 + 0.06 * vRef, 0, 1.1) : 0.6;
      const own = A.side > 0 ? hipL : hipR, opp = A.side > 0 ? hipR : hipL;
      let flex = -swingAmp * (own - opp) * 0.9, abd = 0.12, elbow = running ? 1.4 : 0.35, rot = 0, wn = g.armWn;
      if (cmd.contactMode && (reach > 0 || cmd.shoot || cmd.wrap)) {
        flex = lerp(flex, 1.45, Math.max(reach, cmd.shoot || cmd.wrap ? 1 : 0));
        elbow = cmd.shoot ? 0.05 : cmd.wrap ? 1.5 : lerp(elbow, 0.25, reach);
        abd = cmd.wrap ? -0.5 : 0.15;
        rot = cmd.wrap ? 0.4 : 0;
        wn = cmd.shoot ? g.armWn * 2.5 : g.armWn * 1.6;
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
