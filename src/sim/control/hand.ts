// Hand-built motor controller. Body state + Commands in, muscle targets out.
// Ideas: SIMBICON-style torso control through the stance hip, virtual-force (Jacobian-transpose)
// support and propulsion through the stance knee/ankle, Raibert/capture-point foot placement for
// balance, a phase-based gait. Every torque still goes through the muscle limits in muscles.ts.
import type { BodyPlan } from '../anatomy/body';
import { clamp, cross, dot, headingOf, lerp, qaxis, qconj, qlog, qmul, qrot, type Quat, type Vec3 } from '../math';
import type { MuscleSet, MuscleTargets } from '../muscles';
import type { BodyView, Commands, MotorController } from './types';

export interface Gains {
  /** Natural frequencies (rad/s) for joint PD; kp = I·ω², kd = 2ζ·I·ω. */
  swing: number; stanceLeg: number; arm: number; posture: number;
  /** World-frame orientation PD for pelvis/thorax/head, in units of m·g·h (pelvis, thorax) and N·m (head). */
  pelvisKp: number; pelvisKd: number; thoraxKp: number; thoraxKd: number; headKp: number; headKd: number;
  /** COM regulation: height (1/s²), horizontal velocity (1/s), standing position (1/s²). */
  heightKp: number; heightKd: number; velK: number; posKp: number; posKd: number;
  /** Foot placement feedback on velocity error (s). */
  footK: number;
}
export const DEFAULT_GAINS: Gains = {
  swing: 22, stanceLeg: 8, arm: 12, posture: 10,
  pelvisKp: 2.2, pelvisKd: 0.35, thoraxKp: 1.6, thoraxKd: 0.25, headKp: 60, headKd: 6,
  heightKp: 60, heightKd: 14, velK: 3.0, posKp: 30, posKd: 11,
  footK: 0.18,
};

/** Target speeds (m/s) for the reference athlete; the body's own limits decide what is reached. */
export const GAIT_SPEED = { walk: 1.6, jog: 4.2, sprint: 10.5 };

type Leg = {
  k: 0 | 1; side: 1 | -1;
  hip: number[]; knee: number[]; ankle: number[]; toe: number;
  chain: number[];               // hip, knee, ankle dofs (for Jacobians)
  foot: number; thigh: number;
  L1: number; L2: number;        // thigh and shank length (m)
  hipOff: Vec3;                  // hip joint centre relative to pelvis origin, pelvis frame
  ankleH: number;                // ankle height above sole (m)
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
  private spineDofs: number[]; private neckDofs: number[];
  private arms: { side: 1 | -1; flex: number; abd: number; rot: number; elbow: number; pron: number; wrist: number[] }[];
  private standing = true;
  private gaitT = 0;
  private dbg: Record<string, number | string> = {};
  private thrustT = 0; private diveT = 0;

  constructor(private plan: BodyPlan, private muscles: MuscleSet) {
    this.D = (n) => muscles.index(n);
    this.S = (n) => plan.segments.findIndex((s) => s.name === n);
    this.mass = plan.segments.reduce((a, s) => a + s.mass, 0);
    this.pelvisSeg = this.S('pelvis');
    this.thoraxSeg = this.S('thorax') >= 0 ? this.S('thorax') : this.S('trunk');
    this.headSeg = this.S('head');
    const com = plan.segments.reduce((a, s) => a + s.com[1] * s.mass, 0) / this.mass;
    this.standCom = com;
    const pelvis = plan.segments[this.pelvisSeg];
    this.legs = ([1, -1] as const).map((side, k) => {
      const sx = side > 0 ? 'L' : 'R';
      const hipJ = plan.joints.find((j) => j.name === 'hip' + sx)!, kneeJ = plan.joints.find((j) => j.name === 'knee' + sx)!, ankJ = plan.joints.find((j) => j.name === 'ankle' + sx)!;
      const hip = ['flex', 'abd', 'intRot'].map((d) => this.D(`hip${sx}.${d}`));
      const knee = ['flex', 'intRot'].map((d) => this.D(`knee${sx}.${d}`));
      const ankle = ['dorsi', 'inv'].map((d) => this.D(`ankle${sx}.${d}`));
      return {
        k: k as 0 | 1, side, hip, knee, ankle, toe: this.D(`toe${sx}.ext`), chain: [...hip, ...knee, ...ankle],
        foot: this.S('foot' + sx), thigh: this.S('thigh' + sx),
        L1: hipJ.pos[1] - kneeJ.pos[1], L2: kneeJ.pos[1] - ankJ.pos[1],
        hipOff: [hipJ.pos[0] - pelvis.origin[0], hipJ.pos[1] - pelvis.origin[1], hipJ.pos[2] - pelvis.origin[2]],
        ankleH: ankJ.pos[1],
        phase: 'stance', t: 0, liftPos: [0, 0, 0], target: [0, 0, 0],
      } as Leg;
    });
    const spine = ['lumbar', 'thoracic'].flatMap((j) => ['flex', 'latL', 'rotL'].map((d) => this.D(`${j}.${d}`)));
    this.spineDofs = spine.filter((i) => i >= 0);
    this.neckDofs = ['neckLow', 'neckUp'].flatMap((j) => ['flex', 'latL', 'rotL'].map((d) => this.D(`${j}.${d}`))).filter((i) => i >= 0);
    this.arms = ([1, -1] as const).map((side) => {
      const sx = side > 0 ? 'L' : 'R';
      return {
        side, flex: this.D(`shoulder${sx}.flex`), abd: this.D(`shoulder${sx}.abd`), rot: this.D(`shoulder${sx}.intRot`),
        elbow: this.D(`elbow${sx}.flex`), pron: this.D(`elbow${sx}.pron`), wrist: ['flex', 'radDev'].map((d) => this.D(`wrist${sx}.${d}`)),
      };
    });
  }

  debug() { return this.dbg; }

  // ---------------------------------------------------------------- helpers
  private pd(out: MuscleTargets, i: number, q: number, wn: number, zeta = 1) {
    if (i < 0) return;
    const I = this.muscles.ieff[i], w = Math.min(wn, 0.4 / this.dt);
    out.q[i] = clamp(q, this.muscles.lo[i], this.muscles.hi[i]);
    out.kp[i] = I * w * w;
    out.kd[i] = 2 * zeta * I * w;
  }
  private dt = 1 / 240;
  private segQuat(v: BodyView, s: number): Quat { const q = v.state.segQuat; return [q[4 * s], q[4 * s + 1], q[4 * s + 2], q[4 * s + 3]]; }
  private segVec(a: Float64Array, s: number): Vec3 { return [a[3 * s], a[3 * s + 1], a[3 * s + 2]]; }
  private axis(v: BodyView, i: number): Vec3 { const a = v.state.dofAxis; return [a[3 * i], a[3 * i + 1], a[3 * i + 2]]; }
  private anchor(v: BodyView, i: number): Vec3 { const a = v.state.dofAnchor; return [a[3 * i], a[3 * i + 1], a[3 * i + 2]]; }

  /** Joint torques on `dofs` that apply world torque T to the PARENT side's opposite (i.e. +T on the child chain). */
  private torqueOnDofs(v: BodyView, dofs: number[], T: Vec3, out: MuscleTargets, share = 1) {
    // Least-squares over the dof axes: solve (A Aᵀ) y = T, τ = Aᵀ y.
    const A = dofs.map((i) => this.axis(v, i));
    const M = [0, 1, 2].map((r) => [0, 1, 2].map((c) => A.reduce((s, a) => s + a[r] * a[c], 0) + (r === c ? 1e-6 : 0)));
    const y = solve3(M, T);
    dofs.forEach((i, k) => (out.tff[i] += share * dot(A[k], y)));
  }

  /** Desired world orientation from an up direction (pitch/roll) and heading. */
  private orient(heading: number, pitchFwd: number, rollLeft: number): Quat {
    const qy = qaxis([0, 1, 0], heading);
    const qp = qaxis([1, 0, 0], pitchFwd);    // +X tilts the trunk forward
    const qr = qaxis([0, 0, -1], rollLeft);   // −Z leans to the left
    return qmul(qy, qmul(qp, qr));
  }
  private orientErr(qd: Quat, q: Quat): Vec3 { return qlog(qmul(qd, qconj(q))); }

  // ---------------------------------------------------------------- main
  compute(v: BodyView, cmd: Commands, out: MuscleTargets) {
    this.dt = v.dt;
    const g = this.gains, s = v.state, m = this.mass, G = 9.81;
    out.tff.fill(0);
    for (let i = 0; i < this.muscles.n; i++) this.pd(out, i, 0, g.posture);

    const pq = this.segQuat(v, this.pelvisSeg), pw = this.segVec(s.segAngVel, this.pelvisSeg);
    const pfwd = qrot(pq, [0, 0, 1]);
    const heading = headingOf(pfwd);
    const c = s.com, cv = s.comVel;
    const speedCap = GAIT_SPEED[cmd.gait] * this.plan.params.speed;
    const mv = Math.min(1, Math.hypot(cmd.move.x, cmd.move.z));
    const vd: Vec3 = mv > 0.05 ? [cmd.move.x / Math.hypot(cmd.move.x, cmd.move.z) * mv * speedCap, 0, cmd.move.z / Math.hypot(cmd.move.x, cmd.move.z) * mv * speedCap] : [0, 0, 0];
    const vdMag = Math.hypot(vd[0], vd[2]);
    const faceDir = cmd.face ?? (vdMag > 0.3 ? { x: vd[0], z: vd[2] } : null);
    const headingD = faceDir ? Math.atan2(faceDir.x, faceDir.z) : heading;
    const speed = Math.hypot(cv[0], cv[2]);
    const fwdD: Vec3 = [Math.sin(headingD), 0, Math.cos(headingD)];

    // ---- gait timing from speed (cadence and contact time grow/shrink with speed) [S4]
    const vRef = Math.max(speed, vdMag);
    const stepT = 1 / clamp(1.75 + 0.32 * vRef, 1.75, 4.8);           // s per step
    const running = vRef > 2.6;
    const stanceT = running ? clamp(0.95 / Math.max(vRef, 0.1), 0.095, stepT * 0.95) : stepT * 1.25;

    // ---- desired COM height and trunk lean
    const sink = clamp(cmd.sink, 0, 1);
    let hd = this.standCom - 0.012 * vRef - sink * 0.32 * this.plan.params.height / 1.83;
    const accelFwd = dot([vd[0] - cv[0], 0, vd[2] - cv[2]], fwdD);
    let pitchD = clamp(0.02 * vRef + 0.05 * accelFwd, -0.1, 0.45) + 0.5 * sink + 0.45 * cmd.lean.fwd;
    let rollD = 0.3 * cmd.lean.side;
    if (cmd.thrustHips && this.thrustT <= 0) this.thrustT = 0.3;
    if (this.thrustT > 0) { this.thrustT -= v.dt; hd += 0.12; pitchD -= 0.25; }
    if (cmd.dive && this.diveT <= 0) this.diveT = 0.6;
    if (this.diveT > 0) this.diveT -= v.dt;

    // ---- stepping state machine
    const feet = v.feet;
    const loads = feet.map((f) => f.force);
    const anyDown = feet[0].touching || feet[1].touching;
    const w0 = Math.sqrt(G / Math.max(0.5, c[1]));
    const cp: Vec3 = [c[0] + cv[0] / w0, 0, c[2] + cv[2] / w0];          // capture point
    const footPos = this.legs.map((L) => this.segVec(s.segPos, L.foot));   // ankle positions
    const mid: Vec3 = [(footPos[0][0] + footPos[1][0]) / 2, 0, (footPos[0][2] + footPos[1][2]) / 2];
    const cpOut = this.outsideSupport(cp, footPos, headingD);
    const wantMove = vdMag > 0.15 || speed > 0.5 || cpOut > 0.04;
    if (this.standing && wantMove) {
      this.standing = false;
      // first swing leg: the less loaded one, or the one on the side the capture point left through
      const first = cpOut > 0.04 ? this.sideToward(cp, mid, headingD) : loads[0] < loads[1] ? 0 : 1;
      this.startSwing(this.legs[first], v);
      this.legs[1 - first].phase = 'stance'; this.legs[1 - first].t = 0;
    } else if (!this.standing && !wantMove && this.legs.every((L) => L.phase === 'stance') && speed < 0.3) {
      this.standing = true;
    }
    for (const L of this.legs) {
      L.t += v.dt;
      const f = feet[L.k];
      if (this.standing) { L.phase = 'stance'; continue; }
      const other = this.legs[1 - L.k];
      if (L.phase === 'swing') {
        if (f.touching && L.t > 0.45 * (stepT * 2 - stanceT)) { L.phase = 'stance'; L.t = 0; }
      } else {
        // leave stance: running after the contact time; walking once the other foot has taken load
        const otherLoaded = other.phase === 'stance' && other.t > 0.08 * stepT && feet[other.k].force > 0.35 * m * G;
        if ((running && L.t > stanceT) || (!running && otherLoaded) || (!f.touching && L.t > 0.15)) this.startSwing(L, v);
      }
    }
    this.gaitT += v.dt;

    // ---- stance legs: share of support and the virtual force they must produce
    const stance = this.legs.filter((L) => L.phase === 'stance' && feet[L.k].touching);
    const totalLoad = stance.reduce((a, L) => a + Math.max(1, loads[L.k]), 0);
    const Fy = m * (G + g.heightKp * (hd - c[1]) - g.heightKd * cv[1]);
    let Fx: number, Fz: number;
    if (this.standing) {
      const tgt: Vec3 = [mid[0] + 0.03 * Math.sin(heading), 0, mid[2] + 0.03 * Math.cos(heading)]; // COM slightly ahead of ankles
      Fx = m * (g.posKp * (tgt[0] - c[0]) - g.posKd * cv[0]);
      Fz = m * (g.posKp * (tgt[2] - c[2]) - g.posKd * cv[2]);
    } else {
      Fx = m * g.velK * (vd[0] - cv[0]);
      Fz = m * g.velK * (vd[2] - cv[2]);
    }
    const Fh = Math.hypot(Fx, Fz), FhMax = 0.9 * Math.max(0, Fy);
    if (Fh > FhMax) { Fx *= FhMax / Fh; Fz *= FhMax / Fh; }

    // ---- pelvis attitude through the stance hips; spine and neck in world frame
    const qPelD = this.orient(headingD, clamp(pitchD * 0.35, -0.1, 0.3), rollD * 0.3);
    const ePel = this.orientErr(qPelD, pq);
    const mgh = m * G * this.standCom;
    let Tpel: Vec3 = [mgh * g.pelvisKp * ePel[0] - mgh * g.pelvisKd * pw[0], mgh * g.pelvisKp * ePel[1] * 0.5 - mgh * g.pelvisKd * 0.5 * pw[1], mgh * g.pelvisKp * ePel[2] - mgh * g.pelvisKd * pw[2]];

    const tq = this.segQuat(v, this.thoraxSeg), tw = this.segVec(s.segAngVel, this.thoraxSeg);
    const qThD = this.orient(headingD, pitchD, rollD);
    const eTh = this.orientErr(qThD, tq);
    const mU = 0.5 * m;
    const Tth: Vec3 = [0, 1, 2].map((k) => mU * G * 0.4 * (g.thoraxKp * eTh[k] - g.thoraxKd * tw[k] * (k === 1 ? 0.5 : 1))) as Vec3;
    this.torqueOnDofs(v, this.spineDofs, Tth, out);
    // the spine pushes back on the pelvis; stance hips make up for it
    Tpel = [Tpel[0] + Tth[0], Tpel[1] + Tth[1], Tpel[2] + Tth[2]];

    const hq = this.segQuat(v, this.headSeg), hw = this.segVec(s.segAngVel, this.headSeg);
    const eHd = this.orientErr(this.orient(headingD, cmd.headTuck ? 0.6 : -0.1 + 0.15 * sink, 0), hq);
    this.torqueOnDofs(v, this.neckDofs, [0, 1, 2].map((k) => g.headKp * eHd[k] - g.headKd * hw[k]) as Vec3, out);

    // ---- legs
    for (const L of this.legs) {
      if (L.phase === 'stance') {
        // a stance leg that has momentarily lost contact holds posture and carries no share
        const share = feet[L.k].touching && stance.length > 0 ? Math.max(1, loads[L.k]) / totalLoad : 0;
        this.stanceLeg(v, L, out, [Fx * share, Fy * share, Fz * share], share, Tpel, headingD, stance.length === 2);
      } else {
        this.swingLeg(v, L, out, c, cv, vd, headingD, stepT, stanceT, running);
      }
    }
    if (stance.length === 0) {
      // airborne: hold pelvis attitude weakly with both hips (no ground to push against)
      for (const L of this.legs) this.torqueOnDofs(v, L.hip, [-Tpel[0] * 0.15, -Tpel[1] * 0.15, -Tpel[2] * 0.15], out, 1);
    }

    this.armsControl(v, cmd, out, running, vRef);
    this.dbg = { standing: this.standing ? 1 : 0, stepT, stanceT, legL: this.legs[0].phase, legR: this.legs[1].phase, hd, Fy, cpOut, speed, vd: vdMag };
    void anyDown; void lerp;
  }

  private startSwing(L: Leg, v: BodyView) {
    L.phase = 'swing'; L.t = 0;
    L.liftPos = this.segVec(v.state.segPos, L.foot);
  }

  /** Distance the point lies outside the support region (feet ± foot size), 0 if inside. */
  private outsideSupport(p: Vec3, feet: Vec3[], heading: number) {
    const f: Vec3 = [Math.sin(heading), 0, Math.cos(heading)], r: Vec3 = [f[2], 0, -f[0]];
    const coords = feet.map((q) => [dot([q[0], 0, q[2]], f), dot([q[0], 0, q[2]], r)]);
    const pf = dot([p[0], 0, p[2]], f), pr = dot([p[0], 0, p[2]], r);
    const fMin = Math.min(...coords.map((x) => x[0])) - 0.06, fMax = Math.max(...coords.map((x) => x[0])) + 0.17;
    const rMin = Math.min(...coords.map((x) => x[1])) - 0.05, rMax = Math.max(...coords.map((x) => x[1])) + 0.05;
    return Math.max(fMin - pf, pf - fMax, rMin - pr, pr - rMax, 0);
  }
  private sideToward(p: Vec3, mid: Vec3, heading: number): 0 | 1 {
    const r: Vec3 = [Math.cos(heading), 0, -Math.sin(heading)]; // athlete's right
    return dot([p[0] - mid[0], 0, p[2] - mid[2]], r) > 0 ? 1 : 0;
  }

  private stanceLeg(v: BodyView, L: Leg, out: MuscleTargets, F: Vec3, share: number, Tpel: Vec3, headingD: number, double: boolean) {
    const s = v.state, g = this.gains;
    const foot = this.segVec(s.segPos, L.foot); // ankle joint centre
    // Virtual force via Jacobian transpose on knee and ankle: τ = −Jᵀ F (foot pushes the ground with −F).
    for (const i of [...L.knee, ...L.ankle]) {
      const col = cross(this.axis(v, i), [foot[0] - this.anchor(v, i)[0], foot[1] - this.anchor(v, i)[1], foot[2] - this.anchor(v, i)[2]]);
      out.tff[i] += -dot(col, F);
    }
    // Keep the ankle torque within what the foot can transmit (centre of pressure stays under the foot).
    const Fn = Math.max(0, F[1]);
    const ai = L.ankle[0];
    out.tff[ai] = clamp(out.tff[ai], -Fn * 0.16, Fn * 0.05);
    // pelvis attitude: stance hips apply −Tpel·share to the pelvis
    this.torqueOnDofs(v, L.hip, [-Tpel[0] * share, -Tpel[1] * share, -Tpel[2] * share], out);
    // posture shaping: light knee bend, foot flat
    this.pd(out, L.knee[0], double ? 0.15 : 0.25, g.stanceLeg);
    this.pd(out, L.ankle[0], 0, g.stanceLeg * 0.6);
    this.pd(out, L.ankle[1], 0, g.stanceLeg * 0.6);
    this.pd(out, L.toe, 0, g.stanceLeg);
    for (const i of L.hip) { out.kp[i] *= 0.2; out.kd[i] *= 0.5; }
    void headingD;
  }

  private swingLeg(v: BodyView, L: Leg, out: MuscleTargets, c: Vec3, cv: Vec3, vd: Vec3, headingD: number, stepT: number, stanceT: number, running: boolean) {
    const s = v.state, g = this.gains;
    const pq = this.segQuat(v, this.pelvisSeg);
    const pelvisPos = this.segVec(s.segPos, this.pelvisSeg);
    const hipW = [0, 1, 2].map((k) => pelvisPos[k] + qrot(pq, L.hipOff)[k]) as Vec3;
    const swingT = Math.max(0.12, 2 * stepT - stanceT);
    const sPh = clamp(L.t / swingT, 0, 1);
    // Raibert / capture-point placement: neutral point + velocity-error feedback, plus step width.
    const right: Vec3 = [Math.cos(headingD), 0, -Math.sin(headingD)];
    const remaining = Math.max(0, swingT - L.t);
    const tgt: Vec3 = [
      c[0] + cv[0] * (remaining + stanceT * 0.5) + this.gains.footK * (cv[0] - vd[0]) - right[0] * L.side * 0.1,
      0,
      c[2] + cv[2] * (remaining + stanceT * 0.5) + this.gains.footK * (cv[2] - vd[2]) - right[2] * L.side * 0.1,
    ];
    L.target = tgt;
    // trajectory: lift then place
    const e = sPh * sPh * (3 - 2 * sPh);
    const clear = running ? 0.12 + 0.03 * Math.hypot(cv[0], cv[2]) : 0.09;
    const ankleTarget: Vec3 = [lerp(L.liftPos[0], tgt[0], e), L.ankleH + clear * Math.sin(Math.PI * sPh), lerp(L.liftPos[2], tgt[2], e)];
    // into pelvis frame relative to the hip
    const rel = qrot(qconj(pq), [ankleTarget[0] - hipW[0], ankleTarget[1] - hipW[1], ankleTarget[2] - hipW[2]]);
    const d = Math.min(Math.hypot(...rel), (L.L1 + L.L2) * 0.995);
    const n = Math.hypot(...rel) || 1;
    const dir: Vec3 = [rel[0] / n, rel[1] / n, rel[2] / n];
    const kneeFlex = Math.PI - Math.acos(clamp((L.L1 ** 2 + L.L2 ** 2 - d * d) / (2 * L.L1 * L.L2), -1, 1));
    const alpha = Math.acos(clamp((L.L1 ** 2 + d * d - L.L2 ** 2) / (2 * L.L1 * d), -1, 1));
    const hipFlex = Math.atan2(dir[2], -dir[1]) + alpha;
    const hipAbd = Math.asin(clamp(dir[0] * L.side, -1, 1));
    const pelvisPitch = Math.asin(clamp(qrot(pq, [0, 0, 1])[1], -1, 1)) * -1; // forward tilt +
    this.pd(out, L.hip[0], hipFlex, g.swing);
    this.pd(out, L.hip[1], hipAbd, g.swing);
    this.pd(out, L.hip[2], 0, g.swing * 0.6);
    this.pd(out, L.knee[0], kneeFlex + (running ? 0.9 * Math.sin(Math.PI * sPh) : 0), g.swing);
    this.pd(out, L.knee[1], 0, g.swing * 0.5);
    this.pd(out, L.ankle[0], pelvisPitch - hipFlex + kneeFlex + 0.05, g.swing * 0.7);
    this.pd(out, L.ankle[1], 0, g.swing * 0.5);
    this.pd(out, L.toe, 0.1, g.swing * 0.5);
    void s;
  }

  private armsControl(v: BodyView, cmd: Commands, out: MuscleTargets, running: boolean, vRef: number) {
    const g = this.gains;
    const hipL = v.state.q[this.legs[0].hip[0]], hipR = v.state.q[this.legs[1].hip[0]];
    for (const A of this.arms) {
      const reach = A.side > 0 ? cmd.armL : cmd.armR;
      const swingAmp = running ? clamp(0.5 + 0.06 * vRef, 0, 1.1) : 0.35;
      const own = A.side > 0 ? hipL : hipR, opp = A.side > 0 ? hipR : hipL;
      let flex = -swingAmp * (own - opp) * 0.9, abd = 0.12, elbow = running ? 1.4 : 0.35, rot = 0, wn = g.arm;
      if (cmd.contactMode && (reach > 0 || cmd.shoot || cmd.wrap)) {
        flex = lerp(flex, 1.45, Math.max(reach, cmd.shoot || cmd.wrap ? 1 : 0));
        elbow = cmd.shoot ? 0.05 : cmd.wrap ? 1.5 : lerp(elbow, 0.25, reach);
        abd = cmd.wrap ? -0.5 : 0.15;
        rot = cmd.wrap ? 0.4 : 0;
        wn = cmd.shoot ? g.arm * 2.5 : g.arm * 1.6;
      }
      this.pd(out, A.flex, flex, wn);
      this.pd(out, A.abd, abd, wn);
      this.pd(out, A.rot, rot, wn * 0.8);
      this.pd(out, A.elbow, elbow, wn);
      this.pd(out, A.pron, 0, wn * 0.5);
      for (const w of A.wrist) this.pd(out, w, 0, wn * 0.5);
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
