// Procedural animator (design §6.5): every step it generates the pose the muscles should track, from the
// commands and the body's measured motion. Nothing is played back: gait, stances, overlays and the get-up are
// functions of time, speed and command levels, all filtered so the pose never jumps.
//
// Locomotion is one continuum from standing to a 10 m/s sprint, driven by the measured COM speed:
//  - a stride phase advances at the cadence for that speed; each leg is in stance from its touchdown (phase 0)
//    to its lift-off (the duty factor, or earlier when the planted foot leaves the leg's reach);
//  - a planted foot is a fixed point on the turf: in the heading frame it moves back at the measured ground
//    speed (and turns with the heading), with a heel / ball rocker so the foot can roll without sliding;
//  - a swing leg moves in joint space from its lift-off angles to the touchdown solution, with knee fold
//    (heel recovery) and hip drive that grow with speed;
//  - legs are solved with the hip/knee IK in the pelvis frame, assuming the pelvis sits at the root target
//    (height, heading, pitch, roll), which is what the world's support carries it toward.
import type { BodyPlan } from '../anatomy/body';
import { FUSE_RANGE_TRANSFER } from '../anatomy/data';
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type BodyView, type Commands } from '../control/types';
import { clamp, lerp, qconj, qrot, wrapAngle, type Quat, type Vec3 } from '../math';
import type { MuscleSet } from '../muscles';
import { legIK } from './ik';
import { rootQuat } from './kinematics';
import type { AnimFrame, Animator, SupportState } from './types';

const TAU = 2 * Math.PI, G = 9.81;
const s01 = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const minJerk = (x: number) => { const s = clamp(x, 0, 1); return s * s * s * (10 + s * (6 * s - 15)); };
/** Smooth bump on 0..1 peaking (at 1) at a/(a+c), with zero slope at both ends. */
const bump = (s: number, a: number, c: number) => {
  if (s <= 0 || s >= 1) return 0;
  const p = a / (a + c);
  return (s ** a * (1 - s) ** c) / (p ** a * (1 - p) ** c);
};
const follow = (x: number, target: number, dt: number, tau: number) => x + (target - x) * (1 - Math.exp(-dt / tau));
const interp = (t: readonly (readonly [number, number])[], x: number) => {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (x <= t[i][0]) return lerp(t[i - 1][1], t[i][1], (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]));
  return t[t.length - 1][1];
};

/** Step rate (steps/s) against speed (m/s): ~1.8 at a brisk walk, ~2.7 jogging, ~4.6 at 10 m/s [S4]. */
const CADENCE = [[0, 1.6], [1, 1.75], [1.6, 1.95], [2.5, 2.55], [3.5, 2.75], [5, 2.95], [7, 3.4], [9, 4.15], [10.5, 4.7]] as const;
/** Running ground contact time (s) against speed: ~0.11 s at top speed (Weyand 2010) [S4]. */
const CONTACT = [[2.5, 0.27], [3.5, 0.235], [5, 0.18], [7, 0.14], [9, 0.115], [10.5, 0.1]] as const;
const WALK_DUTY = 0.6;
/** Human acceleration limits for the root velocity (m/s²): sprint starts ~5–7, braking is stronger. */
const ACCEL = { walk: 3, jog: 5, sprint: 7 }, DECEL = 9, CUT_ACCEL = 14;
/** Sideways acceleration that turns the run (m/s²) at a pivot, up to 4 m/s (~1.4 g, a planted field-sport change of
 *  direction), and at a sprint, from 8 m/s (~0.9 g, a full-speed bend: any more and a straight chase answers every
 *  juke); braking at a pivot (m/s², DECEL at a sprint); and the heading rate limit (rad/s, 180° in ~0.25 s). */
const LAT_ACCEL = [14, 8.5] as const, PIVOT_DECEL = 12, TURN_RATE = 12;
const BACK_MAX = 6.5, SIDE_MAX = 7; // fastest backpedal / sideways movement, m/s (reference athlete)
const LEAD = 2.5;                    // farthest the root velocity may lead the measured velocity, m/s
const GETUP_T = 2.0;
/** Trunk pitch of a full forward lean (rad, ~83°: shoulders level with the hips), and the share of a posture
 *  lean the spine takes (the world's support turns the pelvis through the other 0.3). */
const LEAN_MAX = 1.45, PELVIS_REST = 0.7, LEAN_RATE = 1.5;
/** Dive: load and push times (s) from a standing start / from a sprint, take-off velocity from a standing start
 *  and its upward part from a stand / a sprint (m/s), longest flight before giving up on a landing (s). A standing
 *  dive leaves at ~3 m/s, about a standing long jump's take-off; from a sprint the stride is the load. */
const DIVE = { load: [0.3, 0.08], push: [0.25, 0.12], vStand: 3.4, vy: [1.6, 0.4], maxFlight: 1.5 } as const;
/** Hip-thrust lunge: how long a press drives the root forward (s), the speed it drives toward (m/s) and how fast
 *  (m/s²). An explosive first step reaches ~4–5 m/s in 0.5 s at ~8–10 m/s² (sprint-start horizontal force ~1 body
 *  weight [S4]); holding the button longer changes nothing. */
const LUNGE = { time: 0.5, v: 5, accel: 12 } as const;
/** One press's whole hip thrust (s): the lunge and drive, then the rise up onto the balls of the feet. */
const THRUST_T = 0.8;
type DiveStage = 'load' | 'launch' | 'flight';

type Mode = 'loco' | 'dive' | 'down' | 'getup';
/** One leg's angles: hip flexion, abduction, knee flexion, ankle dorsiflexion, toe extension, foot yaw
 *  relative to the heading (positive toward the athlete's left), and the foot's toe-up roll on the turf. */
type LegQ = [number, number, number, number, number, number, number];
interface Leg {
  side: 1 | -1; L1: number; L2: number; hipOff: Vec3;
  hf: number; ab: number; rot: number; kn: number; knRot: number; dor: number; inv: number; toe: number;
  stance: boolean; F: [number, number]; yaw: number;       // planted flat-foot ankle point (heading frame x left, z fwd)
  liftPhase: number; qLift: LegQ; q: LegQ; tdF: [number, number]; tdYaw: number; tdG: number; prevPhi: number; reachOK: boolean;
  scuff: number;                                         // 0..1: how far the swing leg is drawn up out of a scuff
  reach: number;                                         // 0..1: how far a planted foot reaches for turf it lost
}
/** Fastest roll of a planted foot onto its ball or heel (rad/s). */
const ROLL_RATE = 8;
/** Tracking gain a sprinter's swing leg keeps while its foot touches the turf late in the swing. */
const SWING_SOFT = 0.1;
interface Arm { side: 1 | -1; flex: number; abd: number; rot: number; elbow: number; wrist: number; seg: number }

export class ProceduralAnimator implements Animator {
  private n: number;
  private legs: Leg[];
  private arms: Arm[];
  private I: (name: string) => number;
  private lo: Float64Array; private hi: Float64Array; private wMax: Float64Array;
  private q: Float64Array; private prevQ: Float64Array; private first = true;
  private armDofs: number[][]; private neckDofs: number[];
  private ankleH: number; private heel: number; private ball: number;
  private standH: number;
  private pelvisSeg: number; private thoraxSeg: number;
  private neutral = neutralCommands();

  // locomotion state
  private phase = 0; private frozen = true;
  private heading = NaN; private omega = 0;
  private vel: Vec3 = [0, 0, 0]; private vPlan: [number, number] = [0, 0]; private aFwd = 0; private aLat = 0;
  private height: number; private pitch = 0; private roll = 0; private bend = 0; private dropF = 0.008; private dropV = 0; private pitchV = 0;
  private lv = { gait: 0, stance: 0, sink: 0, chop: 0, drive: 0, thrust: 0, tuck: 0, leanF: 0, leanS: 0, reachL: 0, reachR: 0,
    wrap: 0, shoot: 0, carryL: 0, carryR: 0, contact: 0, cut: 0, aimL: 0, aimR: 0, bp: 0, shuffle: 0, pullL: 0, pullR: 0 };
  private aimAng = [[0, 0], [0, 0]];
  private cutT = 0; private cutSide = 0; private cutDir: [number, number] = [0, 1]; private cutSpeed = 0; private prevCut = 0;
  private turn = 0;
  private lungeT = 0; private thrustT = 0; private prevThrust = false;

  // whole-body modes and cross-fades
  private mode: Mode = 'loco'; private modeT = 0; private settleT = 0; private prevDive = false;
  private dv = { run: 0, vh: 0, dir: [0, 1] as [number, number], tL: 0.2, tP: 0.2, stage: 'load' as DiveStage, vy: 0 };
  private blendFrom: Float64Array; private blendRoot = { height: 0, pitch: 0, roll: 0 }; private blendW = 1; private blendDur = 0.2;
  private getup = { faceDown: true, heading: 0, h0: 0.2, p0: 0, r0: 0, keys: [] as Float64Array[], downT: 0 };
  private start: Float64Array;
  private clip = 'idle';

  constructor(private plan: BodyPlan, muscles: MuscleSet) {
    this.n = muscles.n;
    this.I = (name) => muscles.index(name);
    this.lo = muscles.lo; this.hi = muscles.hi; this.wMax = muscles.wMax;
    this.q = new Float64Array(this.n); this.prevQ = new Float64Array(this.n);
    this.blendFrom = new Float64Array(this.n); this.start = new Float64Array(this.n);
    const seg = (n: string) => plan.segments.findIndex((s) => s.name === n);
    this.pelvisSeg = seg('pelvis');
    this.thoraxSeg = seg('thorax') >= 0 ? seg('thorax') : seg('trunk');
    const pelvis = plan.segments[this.pelvisSeg];
    this.standH = pelvis.origin[1];
    this.height = this.standH;
    const geom = (n: string) => plan.segments.flatMap((s) => s.geoms).find((g) => g.name === n)!;
    const ankleJ = plan.joints.find((j) => j.name === 'ankleL')!;
    const fg = geom('footL'), tg = geom('toesL');
    this.ankleH = ankleJ.pos[1];
    this.heel = ankleJ.pos[2] - (fg.pos![2] - fg.size[2]);
    this.ball = (tg.pos![2] - tg.size[2]) - ankleJ.pos[2];
    this.legs = ([1, -1] as const).map((side) => {
      const sx = side > 0 ? 'L' : 'R';
      const hipJ = plan.joints.find((j) => j.name === 'hip' + sx)!, kneeJ = plan.joints.find((j) => j.name === 'knee' + sx)!, ankJ = plan.joints.find((j) => j.name === 'ankle' + sx)!;
      const z: LegQ = [0, 0, 0, 0, 0, 0, 0];
      return {
        side, L1: hipJ.pos[1] - kneeJ.pos[1], L2: kneeJ.pos[1] - ankJ.pos[1],
        hipOff: [hipJ.pos[0] - pelvis.origin[0], hipJ.pos[1] - pelvis.origin[1], hipJ.pos[2] - pelvis.origin[2]] as Vec3,
        hf: this.I(`hip${sx}.flex`), ab: this.I(`hip${sx}.abd`), rot: this.I(`hip${sx}.intRot`), kn: this.I(`knee${sx}.flex`),
        knRot: this.I(`knee${sx}.intRot`), dor: this.I(`ankle${sx}.dorsi`), inv: this.I(`ankle${sx}.inv`), toe: this.I(`toe${sx}.ext`),
        stance: true, F: [0, 0] as [number, number], yaw: 0, liftPhase: 0, qLift: [...z] as LegQ, q: [...z] as LegQ,
        tdF: [0, 0] as [number, number], tdYaw: 0, tdG: NaN, prevPhi: 0, reachOK: true, scuff: 0, reach: 0,
      };
    });
    this.arms = ([1, -1] as const).map((side) => {
      const sx = side > 0 ? 'L' : 'R';
      return { side, flex: this.I(`shoulder${sx}.flex`), abd: this.I(`shoulder${sx}.abd`), rot: this.I(`shoulder${sx}.intRot`),
        elbow: this.I(`elbow${sx}.flex`), wrist: this.I(`wrist${sx}.flex`), seg: seg('upperArm' + sx) };
    });
    const dofs = (re: RegExp) => muscles.names.flatMap((n, i) => (re.test(n) ? [i] : []));
    this.armDofs = [dofs(/^(sc|shoulder|elbow|wrist)L\./), dofs(/^(sc|shoulder|elbow|wrist)R\./)];
    this.neckDofs = dofs(/^neck/);
    this.resetFeet();
  }

  /** Add `v` to a dof by name; a dof fused away at this detail level passes its share to the joint that
   *  inherited its range (thoracic → lumbar, neckUp → neckLow, sc → shoulder), so both levels look alike. */
  private add(name: string, v: number) {
    let i = this.I(name);
    if (i < 0) {
      const [j, d] = name.split('.'), base = j.replace(/[LR]$/, ''), sx = j.slice(base.length);
      const t = FUSE_RANGE_TRANSFER[base]?.[d];
      if (!t) return;
      const [tj, td] = t.split('.');
      i = this.I(`${tj}${sx}.${td}`);
      if (i < 0) return;
    }
    this.q[i] += v;
  }

  private resetFeet() {
    for (const L of this.legs) {
      L.stance = true; L.F = [L.side * 0.12, 0]; L.yaw = L.side * 0.08; L.tdF = [...L.F]; L.tdYaw = L.yaw; L.reachOK = true;
    }
    this.phase = 0.05; this.frozen = true;
    for (const L of this.legs) L.prevPhi = this.legPhase(L);
  }
  private legPhase(L: Leg) { const p = this.phase + (L.side > 0 ? 0 : 0.5); return p - Math.floor(p); }

  // ------------------------------------------------------------------ leg geometry
  /** Ankle point (heading frame, x left, y up from the turf, z forward) for a planted foot whose flat-foot
   *  ankle projection is F, yawed by `yaw`, rolled toe-up by `g` about the heel (g > 0) or the ball (g < 0). */
  private rocker(F: [number, number], yaw: number, g: number): Vec3 {
    const fx = Math.sin(yaw), fz = Math.cos(yaw), a = this.ankleH;
    const piv = g >= 0 ? -this.heel : this.ball;            // pivot ahead (+) or behind (−) the ankle
    const c = Math.cos(g), s = Math.sin(g);
    const along = piv - (piv * c + a * s), up = -piv * s + a * c;
    return [F[0] + fx * along, up, F[1] + fz * along];
  }

  /** Leg angles that put the foot at F/yaw/toe-up g with the pelvis at the current root pose. When the leg
   *  cannot reach the flat or heel-down foot (ankle out of dorsiflexion, hip out of extension, leg too short)
   *  the heel rises and the foot rolls onto its ball instead, as in a real stance and push-off. `ok` is false
   *  when even that fails (with margin `m` for planning). With `prevG`, the heel comes back down by at most
   *  `maxStep` from it (it rises as fast as the leg needs; easing it down avoids flips between solutions). */
  private solve(L: Leg, F: [number, number], yaw: number, g: number, m = 0, prevG = NaN, maxStep = Infinity, h = this.height, pp = this.pitch - this.bend): { q: LegQ; ok: boolean } {
    const inv = qconj(rootQuat(0, pp, this.roll));
    const rot = clamp(-L.side * yaw, this.lo[L.rot], this.hi[L.rot]);
    const reach = (L.L1 + L.L2) * (0.99 - 0.015 * m), hfMin = this.lo[L.hf] + 0.01 + 0.05 * m, dmax = this.hi[L.dor] - 0.02;
    const r: LegQ = [0, 0, 0, 0, 0, yaw, g];
    const at = (gg: number) => {
      const a = this.rocker(F, yaw, gg);
      const p = qrot(inv, [a[0], a[1] - h, a[2]]);
      const rel: Vec3 = [p[0] - L.hipOff[0], p[1] - L.hipOff[1], p[2] - L.hipOff[2]];
      const [hf, ab, kn] = legIK(L, rel, rot);
      r[0] = hf; r[1] = ab; r[2] = kn; r[3] = gg + this.pitch - hf + kn; r[4] = Math.max(0, -gg); r[6] = gg;
      return Math.hypot(rel[0], rel[1], rel[2]) <= reach && hf >= hfMin && r[3] <= dmax;
    };
    let ok = true;
    if (!at(g)) {
      // scan down to the first heel rise that works, then refine between it and the last one that did not
      let bad = g, good = NaN;
      for (let gg = g - 0.15; gg >= -1.2; gg -= 0.15) { if (at(gg)) { good = gg; break; } bad = gg; }
      if (Number.isNaN(good)) { ok = false; good = g; }
      else for (let i = 0; i < 5; i++) { const mid = (bad + good) / 2; if (at(mid)) good = mid; else bad = mid; }
      at(good);
    }
    if (r[6] > prevG + maxStep) at(prevG + maxStep);
    else if (r[6] < prevG - 8 * maxStep) at(prevG - 8 * maxStep);
    ok &&= r[0] <= this.hi[L.hf] && r[1] >= this.lo[L.ab] + 0.05 * m && r[1] <= this.hi[L.ab] - 0.05 * m;
    return { q: [...r] as LegQ, ok };
  }

  /** Pull a planned foothold back toward `home` until it is comfortably reachable. */
  private reachable(L: Leg, home: [number, number], to: [number, number], yaw: number, g: number): [number, number] {
    if (this.solve(L, to, yaw, g, 1).ok) return to;
    let a = 0, b = 1;
    for (let i = 0; i < 5; i++) {
      const m = (a + b) / 2;
      if (this.solve(L, [lerp(home[0], to[0], m), lerp(home[1], to[1], m)], yaw, g, 1).ok) a = m; else b = m;
    }
    return [lerp(home[0], to[0], a), lerp(home[1], to[1], a)];
  }

  private lift(L: Leg, phi: number) { L.stance = false; L.liftPhase = Math.min(phi, 0.95); L.qLift = [...L.q]; L.tdG = NaN; }

  private writeLeg(L: Leg, q: LegQ) {
    const Q = this.q;
    if (L.hf >= 0) Q[L.hf] = q[0];
    if (L.ab >= 0) Q[L.ab] = q[1];
    if (L.rot >= 0) Q[L.rot] = -L.side * q[5];
    if (L.kn >= 0) Q[L.kn] = q[2];
    if (L.knRot >= 0) Q[L.knRot] = 0;
    if (L.dor >= 0) Q[L.dor] = q[3];
    if (L.inv >= 0) Q[L.inv] = q[1] - L.side * this.roll;     // keeps the sole level side to side
    if (L.toe >= 0) Q[L.toe] = q[4];
    L.q = q;
  }

  // ------------------------------------------------------------------ main
  update(view: BodyView, cmd: Commands, support: SupportState, out: AnimFrame): void {
    const dt = view.dt, s = view.state;
    if (Number.isNaN(this.heading)) {
      this.heading = this.measuredHeading(view);
      this.vel = [s.comVel[0], 0, s.comVel[2]];
      this.vPlan = [0, 0];
    }
    this.modeT += dt;
    const comSpeed = Math.hypot(s.comVel[0], s.comVel[1], s.comVel[2]);
    // ---- whole-body mode
    if (support.down && (this.mode === 'loco' || this.mode === 'dive')) this.enter('down', 0.15);
    if (this.mode === 'down') {
      this.settleT = comSpeed < 1 ? this.settleT + dt : 0;
      if (this.settleT > 0.25) this.startGetup(view);
    } else if (this.mode === 'getup') {
      if (comSpeed > 3) this.enter('down', 0.15);
      else if (this.modeT >= GETUP_T) {
        this.getup.downT = support.down ? this.getup.downT + dt : 0;
        if (!support.down) { this.mode = 'loco'; this.modeT = 0; }
        else if (this.getup.downT > 0.6) this.startGetup(view);
      }
    } else if (this.mode === 'loco' && cmd.dive && !this.prevDive) this.startDive(view, cmd);
    // one press, one whole dive: holding the button changes nothing; it ends on the turf (down), or on the
    // feet again if it never landed
    else if (this.mode === 'dive' && this.modeT > this.dv.tL + this.dv.tP + DIVE.maxFlight) this.enter('loco', 0.3);
    this.prevDive = cmd.dive;

    this.q.fill(0);
    out.gain.fill(1);
    switch (this.mode) {
      case 'loco': this.loco(view, cmd, false, out); break;
      case 'dive': this.dive(view, cmd, out); break;
      case 'down': this.down(view, out); break;
      case 'getup': this.doGetup(view, out); break;
    }
    // cross-fade from the last frame of the previous mode
    if (this.blendW < 1) {
      this.blendW = Math.min(1, this.blendW + dt / this.blendDur);
      const w = minJerk(this.blendW);
      for (let i = 0; i < this.n; i++) this.q[i] = lerp(this.blendFrom[i], this.q[i], w);
      out.root.height = lerp(this.blendRoot.height, out.root.height, w);
      out.root.pitch = lerp(this.blendRoot.pitch, out.root.pitch, w);
      out.root.roll = lerp(this.blendRoot.roll, out.root.roll, w);
    }
    for (let i = 0; i < this.n; i++) {
      const q = clamp(this.q[i], this.lo[i], this.hi[i]);
      out.q[i] = q;
      out.qd[i] = this.first ? 0 : clamp((q - this.prevQ[i]) / dt, -this.wMax[i], this.wMax[i]);
      this.prevQ[i] = q;
    }
    this.first = false;
    out.root.heading = this.heading;
    out.root.vel[0] = this.vel[0]; out.root.vel[2] = this.vel[2];
    const dive = this.mode === 'dive' ? this.dv.stage : 'none';
    // the root's vertical speed: a dive's take-off, else how fast the posture lowers or raises the hips (the support
    // damps the pelvis toward it, so a quick sink is not braked as if it were a fall)
    out.root.vel[1] = dive === 'launch' ? this.dv.vy : this.mode === 'loco' ? -this.dropV : 0;
    out.root.dive = dive;
    out.root.thrust = this.mode === 'loco' ? this.lv.thrust : 0;
    out.clip = this.mode === 'loco' ? this.clip : this.mode;
  }

  private enter(mode: Mode, blend: number) {
    this.blendFrom.set(this.prevQ);
    this.blendRoot = { height: this.height, pitch: this.pitch, roll: this.roll };
    this.blendW = 0; this.blendDur = blend;
    this.mode = mode; this.modeT = 0; this.settleT = 0; this.bend = 0; this.thrustT = 0;
    if (mode === 'loco') this.resetFeet();
  }

  private measuredHeading(v: BodyView) {
    const k = this.pelvisSeg, q = v.state.segQuat;
    const f = qrot([q[4 * k], q[4 * k + 1], q[4 * k + 2], q[4 * k + 3]], [0, 0, 1]);
    return Math.atan2(f[0], f[2]);
  }
  private segAxis(v: BodyView, k: number, a: Vec3): Vec3 {
    const q = v.state.segQuat;
    return qrot([q[4 * k], q[4 * k + 1], q[4 * k + 2], q[4 * k + 3]] as Quat, a);
  }

  // ------------------------------------------------------------------ locomotion
  private loco(v: BodyView, cmd: Commands, hold: boolean, out: AnimFrame) {
    const dt = v.dt, s = v.state, P = this.plan.params, lv = this.lv;
    const vx = s.comVel[0], vz = s.comVel[2];

    // ---- commanded velocity and heading
    const mm = Math.hypot(cmd.move.x, cmd.move.z), mag = Math.min(1, mm);
    const dir: [number, number] = mm > 1e-6 ? [cmd.move.x / mm, cmd.move.z / mm] : [0, 0];
    const gaitV = GAIT_SPEED[cmd.gait] * P.speed;
    if (cmd.plantCut !== 0 && this.prevCut === 0 && Math.hypot(this.vel[0], this.vel[2]) > 1) {
      const vh = Math.atan2(this.vel[0], this.vel[2]), mh = Math.atan2(dir[0], dir[1]);
      const nh = mag > 0.2 && Math.abs(wrapAngle(mh - vh)) > 0.5 ? mh : vh + cmd.plantCut * 1.2;
      this.cutDir = [Math.sin(nh), Math.cos(nh)]; this.cutSide = cmd.plantCut; this.cutT = 0.45;
      this.cutSpeed = Math.min(Math.hypot(this.vel[0], this.vel[2]), gaitV) * 0.75;
    }
    this.prevCut = cmd.plantCut;
    this.cutT = Math.max(0, this.cutT - dt);
    const cutting = this.cutT > 0;
    let hT = this.heading;
    if (cmd.face && Math.hypot(cmd.face.x, cmd.face.z) > 1e-6) hT = Math.atan2(cmd.face.x, cmd.face.z);
    else if (cutting) hT = Math.atan2(this.cutDir[0], this.cutDir[1]);
    else if (mag > 0.1) hT = Math.atan2(dir[0], dir[1]);
    const dpsi = hold ? 0 : clamp(wrapAngle(hT - this.heading), -TURN_RATE * dt, TURN_RATE * dt);
    const h0 = this.heading;
    this.heading = wrapAngle(this.heading + dpsi);
    this.omega = follow(this.omega, dpsi / dt, dt, 0.1);
    const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    const toH = (x: number, z: number): [number, number] => [x * ch - z * sh, x * sh + z * ch]; // world → (left, fwd)
    const toW = (l: number, f: number): [number, number] => [l * ch + f * sh, -l * sh + f * ch];

    // planted feet are fixed on the turf: re-express them in the turned heading frame, then move them back
    // at the measured ground speed
    const vH = toH(vx, vz);
    if (!hold) {
      const s0 = Math.sin(h0), c0 = Math.cos(h0);
      for (const L of this.legs) {
        if (!L.stance) continue;
        const wx = L.F[0] * c0 + L.F[1] * s0, wz = -L.F[0] * s0 + L.F[1] * c0;
        L.F = toH(wx, wz); L.yaw -= dpsi;
        L.F[0] -= vH[0] * dt; L.F[1] -= vH[1] * dt;
      }
    }
    this.vPlan[0] = follow(this.vPlan[0], vx, dt, 0.08); this.vPlan[1] = follow(this.vPlan[1], vz, dt, 0.08);
    const [vl, vf] = toH(this.vPlan[0], this.vPlan[1]);
    const sp = Math.hypot(vl, vf);

    // ---- root velocity: commanded, capped per direction, slewed at human acceleration
    let [tl, tf] = toH(dir[0] * mag * gaitV, dir[1] * mag * gaitV);
    tf = Math.max(tf, -BACK_MAX * P.speed); tl = clamp(tl, -SIDE_MAX * P.speed, SIDE_MAX * P.speed);
    let [tx, tz] = toW(tl, tf);
    // a plant-and-cut trades some speed for the new direction, once (taken at the plant: re-taken every step it
    // bled the run to a near stop over the cut)
    if (cutting) { tx = this.cutDir[0] * this.cutSpeed; tz = this.cutDir[1] * this.cutSpeed; }
    // One press, one whole hip thrust: it lunges forward along the heading, drives and rises, and holding the button
    // changes nothing. Against an opponent the legs stay planted and drive instead of lunging (stepping would leave
    // no leg to push with).
    if (cmd.thrustHips && !this.prevThrust && this.thrustT <= 0 && !hold) { this.thrustT = THRUST_T; this.lungeT = LUNGE.time; }
    this.prevThrust = cmd.thrustHips;
    this.thrustT = hold ? 0 : Math.max(0, this.thrustT - dt);
    const thrusting = this.thrustT > 0;
    this.lungeT = thrusting && !v.playerContact ? Math.max(0, this.lungeT - dt) : 0;
    const lunge = this.lungeT > 0;
    if (lunge) { const vs = Math.max(LUNGE.v, this.vel[0] * sh + this.vel[2] * ch); tx = sh * vs; tz = ch * vs; }
    if (hold) { tx = 0; tz = 0; }
    const dvx = tx - this.vel[0], dvz = tz - this.vel[2], dv = Math.hypot(dvx, dvz);
    const px = this.vel[0], pz = this.vel[2], ps = Math.hypot(px, pz);
    if (!cutting && !lunge && ps > 0.5) {
      // Along the run: speeding up or braking at the gait's rates; across it, turning the run at up to LAT_ACCEL. One
      // grip on the turf does both (an ellipse, as for a tyre): braking hard leaves less to turn with.
      const ux = px / ps, uz = pz / ps, dpar = dvx * ux + dvz * uz, qx = dvx - dpar * ux, qz = dvz - dpar * uz;
      const slow = 1 - clamp((ps - 4) / 4, 0, 1), dec = lerp(DECEL, PIVOT_DECEL, slow), lat = lerp(LAT_ACCEL[1], LAT_ACCEL[0], slow);
      const e = Math.hypot(dpar / ((dpar >= 0 ? ACCEL[cmd.gait] : dec) * dt), Math.hypot(qx, qz) / (lat * dt)), k = e > 1 ? 1 / e : 1;
      this.vel[0] += dvx * k; this.vel[2] += dvz * k;
    } else {
      const lim = (cutting ? CUT_ACCEL : lunge ? LUNGE.accel : dvx * px + dvz * pz >= 0 ? ACCEL[cmd.gait] : DECEL) * dt;
      if (dv > lim) { this.vel[0] += dvx * lim / dv; this.vel[2] += dvz * lim / dv; } else { this.vel[0] = tx; this.vel[2] = tz; }
    }
    const ex = this.vel[0] - vx, ez = this.vel[2] - vz, e = Math.hypot(ex, ez);
    if (e > LEAD) { this.vel[0] = vx + ex * LEAD / e; this.vel[2] = vz + ez * LEAD / e; }
    this.aFwd = follow(this.aFwd, clamp(((this.vel[0] - px) * sh + (this.vel[2] - pz) * ch) / dt, -DECEL, ACCEL.sprint), dt, 0.15);
    this.aLat = follow(this.aLat, clamp(((this.vel[0] - px) * ch - (this.vel[2] - pz) * sh) / dt, -CUT_ACCEL, CUT_ACCEL), dt, 0.1);

    // ---- levels (all filtered, so the pose blends over ~0.1–0.3 s)
    const contact = cmd.contactMode ? 1 : 0;
    // a hip thrust overrides sink, stance and lean: it is the explosive rise out of them; its lunge steps like a
    // sprint start, while a thrust in place (being driven along by it) does not start a walk
    const moving = mag > 0.05 || (sp > 0.4 && !thrusting) || lunge || cmd.chopFeet || cmd.driveLegs > 0.05;
    lv.gait = follow(lv.gait, moving && !hold ? 1 : 0, dt, 0.15);
    // Dropping into a sink is quick (the muscles let go and gravity pulls the hips down, full depth in ~0.25 s);
    // rising out of it takes work and is slower.
    const stanceT = contact && cmd.sink > 0 && sp < 1.5 && !hold && !thrusting ? 1 : 0;
    // Nobody sprints folded in half: the crouch (sink and forward lean together) is capped by speed, about a third of
    // full depth at a full sprint, full depth below ~3 m/s. Deeper at speed put the feet behind the hips and fell.
    let sinkT = hold || thrusting ? 0 : clamp(cmd.sink, 0, 1), leanT = thrusting ? 0 : clamp(cmd.lean.fwd, -1, 1);
    const crouchT = 0.6 * sinkT + 0.7 * Math.max(0, leanT), crouchMax = clamp(1.3 - 0.095 * sp, 0.35, 1);
    if (crouchT > crouchMax) { const k = crouchMax / crouchT; sinkT *= k; if (leanT > 0) leanT *= k; }
    lv.stance = follow(lv.stance, stanceT, dt, stanceT > lv.stance ? 0.07 : 0.2);
    lv.sink = follow(lv.sink, sinkT, dt, sinkT > lv.sink ? 0.07 : 0.12);
    lv.chop = follow(lv.chop, cmd.chopFeet && !hold ? 1 : 0, dt, 0.1);
    lv.drive = follow(lv.drive, hold ? 0 : clamp(cmd.driveLegs, 0, 1), dt, 0.12);
    lv.thrust = follow(lv.thrust, thrusting ? 1 : 0, dt, 0.15);
    lv.tuck = follow(lv.tuck, cmd.headTuck ? 1 : 0, dt, 0.1);
    lv.leanF = follow(lv.leanF, leanT, dt, 0.12);
    lv.leanS = follow(lv.leanS, clamp(cmd.lean.side, -1, 1), dt, 0.12);
    lv.reachL = follow(lv.reachL, clamp(cmd.armL, 0, 1), dt, 0.08);
    lv.reachR = follow(lv.reachR, clamp(cmd.armR, 0, 1), dt, 0.08);
    // a raised arm whose hand holds an opponent rows him in (a wrap squeezes, a thrust drives him away instead)
    const pulling = !cmd.wrap && !thrusting;
    lv.pullL = follow(lv.pullL, pulling && v.grips?.[0] && cmd.armL > 0.3 ? 1 : 0, dt, 0.03);
    lv.pullR = follow(lv.pullR, pulling && v.grips?.[1] && cmd.armR > 0.3 ? 1 : 0, dt, 0.03);
    lv.wrap = follow(lv.wrap, cmd.wrap ? 1 : 0, dt, 0.08);
    lv.shoot = follow(lv.shoot, cmd.shoot ? 1 : 0, dt, 0.04);
    lv.carryL = follow(lv.carryL, cmd.carry === 1 ? 1 : 0, dt, 0.15);
    lv.carryR = follow(lv.carryR, cmd.carry === 2 ? 1 : 0, dt, 0.15);
    lv.contact = follow(lv.contact, contact, dt, 0.15);
    lv.cut = follow(lv.cut, cutting ? 1 : 0, dt, 0.08);
    this.turn = clamp(Math.abs(this.omega) * Math.max(0, vf) / 12, 0, 1);
    const run = s01((sp - 2.0) / 0.8);
    lv.bp = follow(lv.bp, s01((-vf - 0.3) / 0.7) * (1 - run * 0.5), dt, 0.12);
    lv.shuffle = follow(lv.shuffle, cmd.face ? s01((Math.abs(vl) - 0.4) / 0.6) * s01((Math.abs(vl) - Math.abs(vf)) / 0.5) : 0, dt, 0.12);
    const bp = lv.bp, shuffle = lv.shuffle;
    const gl = lv.gait;

    // ---- gait timing
    const fForced = Math.max(5.2 * lv.chop, 4.2 * lv.drive);
    // standing still, a foot that must be re-placed is moved with a quick step, not a slow walking one
    // shuffling takes short quick steps
    const f = Math.max(interp(CADENCE, sp), fForced, 2.8 * (1 - gl), 3.8 * shuffle);
    const T = 2 / f;
    let beta = lerp(WALK_DUTY, interp(CONTACT, sp) * f / 2, run);
    beta = lerp(beta, 0.45, Math.max(lv.chop, lv.drive) * (1 - run));
    const Tc = beta * T;
    // running feet stay about under the hips: any narrower and the thighs (thick, padded) knock as they pass
    const w = 0.12 - 0.02 * gl - 0.01 * run * gl + 0.12 * lv.stance + 0.06 * lv.drive + 0.03 * shuffle;
    const zh = 0.17 * Math.sin(this.pitch);
    const both = this.legs[0].stance && this.legs[1].stance;
    const near = this.legs.every((L) => L.reachOK && Math.hypot(L.F[0] - L.side * w, L.F[1] - zh) < 0.1 && Math.abs(L.yaw - L.side * 0.08) < 0.35);
    this.frozen = hold || (both && near && !moving);
    if (!this.frozen) this.phase += dt * f / 2;

    // ---- pelvis pose (height, lean) for this step
    // Running: the stance knee flexes from ~20° at touchdown to ~40–45° at mid-stance (less as speed rises) and
    // the COM bobs ~5 cm at a jog, ~4 cm at a sprint, lowest at mid-stance (typical human running values; an
    // assumption until docs/realism-sources.md has a source). Walking vaults over a nearly straight leg.
    const fast = clamp((sp - 4) / 6, 0, 1);
    const leanDn = Math.max(0, lv.leanF) ** 3;
    // a deep forward lean sits the hips back and down on bent knees, keeping the weight over the feet
    let drop = lerp(0.008, lerp(0.03, 0.025, run), gl) + lv.stance * (0.12 + 0.16 * lv.sink) + 0.18 * lv.sink * (1 - lv.stance)
      + 0.05 * bp + 0.07 * shuffle + 0.08 * lv.cut + 0.12 * lv.drive + 0.06 * lv.chop + 0.2 * leanDn;
    // thrust: hips, knees and ankles extend until the athlete is up on the balls of his feet
    drop = clamp(lerp(drop, -0.02, lv.thrust), -0.04, 0.4);
    // The hips drop no faster than gravity can take them (the muscles let go, nothing pulls the body down) and stop
    // on the legs at up to ~2.5 g, so the pose never folds the legs ahead of the falling body and lifts the feet.
    const eD = drop - this.dropF, vStop = Math.sign(eD) * Math.sqrt(2 * 2.5 * G * Math.abs(eD)), aD = (vStop > this.dropV ? 0.9 : 2.5) * G * dt;
    this.dropV += clamp(vStop - this.dropV, -aD, aD);
    this.dropF += this.dropV * dt;
    drop = lerp(this.dropF, drop, lv.thrust); // a thrust rises on the legs' own push
    const amp = gl * (0.025 * (1 - run) - lerp(0.025, 0.02, fast) * run) * (1 - Math.max(lv.chop, lv.drive));
    const p0 = this.legPhase(this.legs[0]);
    // extreme when the stance foot passes under the hip: about a third of the way through stance, since the foot
    // lands closer ahead of the hip than it leaves behind it
    this.height = this.standH - drop + amp * Math.cos(TAU * (2 * p0 - 0.7 * beta));
    const runP = 0.012 * vf + 0.05 * this.aFwd;
    let pitchT = runP + 0.25 * bp + 0.15 * shuffle + lv.stance * (0.35 + 0.3 * lv.sink) + 0.3 * lv.sink * (1 - lv.stance)
      + 0.35 * lv.drive + 0.15 * lv.chop;
    // Forward lean: 0.35 rad per unit near upright, steepening so a full lean brings the trunk level
    // with the turf (cubic, so the light leans tackles are built on keep their feel). Leaning back stays small.
    pitchT += 0.35 * lv.leanF + (lv.leanF > 0 ? Math.max(0, LEAN_MAX - pitchT - 0.35) * lv.leanF ** 3 : 0);
    // the trunk rises out of the sink, still leaning slightly into whatever it drives; a pull sits back into it
    pitchT = clamp(lerp(pitchT, 0.15, lv.thrust) - 0.25 * Math.max(lv.pullL, lv.pullR), -0.4, LEAN_MAX);
    // leaning in no faster than the trunk can follow (~1 s to a full lean), so the support never reads the lag
    // behind a commanded lean as being knocked over
    const prevPitch = this.pitch;
    this.pitch = Math.min(follow(this.pitch, pitchT, dt, 0.08), this.pitch + LEAN_RATE * dt);
    this.pitchV = (this.pitch - prevPitch) / dt;
    // The world's support turns the pelvis through only part of a posture lean (as the balance controller does):
    // the spine flexes through the rest, and the legs are solved for that pelvis.
    // ... only near standstill: running, the pelvis pitches with the trunk (a spine-flexed lean at speed put the feet
    // in the wrong place on a cut and tripped the runner), so the share fades out from 3 to 6 m/s
    this.bend = follow(this.bend, PELVIS_REST * Math.max(0, pitchT - runP) * clamp((6 - vf) / 3, 0, 1), dt, 0.08);
    // lean into a turn or cut as a runner does: tan(roll) = sideways acceleration / g
    const rollT = Math.atan(this.aLat / G) + 0.3 * lv.leanS;
    this.roll = follow(this.roll, clamp(rollT, -0.4, 0.4), dt, 0.08);

    // ---- legs
    const sgnO = Math.sign(this.omega);
    const gTD = gl * lerp(0.22, -0.08, run) * (1 - lv.stance);
    // Standing, while the hips drop or the trunk leans in, planted legs are solved for the pelvis where it really is
    // (a little behind its target): the feet stay on the turf and the legs yield under the body instead of lifting.
    const pv = this.segAxis(v, this.pelvisSeg, [0, 0, 1]), pPel = Math.atan2(-pv[1], Math.hypot(pv[0], pv[2]));
    const hUp = Math.max(0, s.segPos[3 * this.pelvisSeg + 1] - this.height), hIK = this.height + hUp * clamp(this.dropV / 0.3, 0, 1) * (1 - gl);
    const pIK = this.pitch - this.bend - Math.max(0, this.pitch - this.bend - pPel) * clamp(this.pitchV / 0.5, 0, 1) * (1 - gl);
    for (const L of this.legs) {
      const phi = this.legPhase(L);
      if (!hold) {
        if (!L.stance && phi < L.prevPhi - 0.5) { L.stance = true; L.F = [...L.tdF]; L.yaw = L.tdYaw; L.reachOK = true; }
        // lift at the end of stance, or early when moving sideways carries the planted foot under the body
        else if (L.stance && !this.frozen && (phi >= beta || (L.side * L.F[0] < 0.03 && L.side * vl > 0.3))) this.lift(L, phi);
      }
      L.prevPhi = phi;
      const home: [number, number] = [L.side * w, zh];
      if (!L.stance || hold) {
        let tx = home[0] + vl * Tc * 0.5, tz = home[1] + vf * Tc * 0.5 - this.ball * run;
        if (L.side === -sgnO) tx += sgnO * 0.1 * this.turn;              // crossover: outside leg steps across
        if (L.side === -this.cutSide) tx += L.side * 0.2 * lv.cut;       // plant the outside foot wide
        const minW = L.side === -sgnO ? 0.04 - 0.1 * this.turn : 0.04;   // feet never cross, except a crossover
        tx = L.side > 0 ? Math.max(tx, minW) : Math.min(tx, -minW);
        L.tdYaw = clamp(L.side * 0.08 * (1 - run) + 0.5 * this.omega * T, -0.5, 0.5);
        const td = this.reachable(L, home, [tx, tz], L.tdYaw, gTD);
        // filtered, so a foothold that jumps (reach clamping) cannot jerk the swing leg
        L.tdF[0] = follow(L.tdF[0], td[0], dt, 0.03); L.tdF[1] = follow(L.tdF[1], td[1], dt, 0.03);
      }
      if (hold) { L.stance = true; L.F = [...home]; L.yaw = L.side * 0.08; }
      let q: LegQ = L.q;
      if (L.stance) {
        const u = clamp(phi / beta, 0, 1);
        const gw = 0.22 * (1 - s01(u / 0.15)) - 0.5 * s01((u - 0.55) / 0.45);
        const gr = -0.08 * (1 - s01(u / 0.3)) - 0.6 * s01((u - 0.35) / 0.65);
        // running, in contact or changing posture, a planted foot that has not found the turf (the body came down
        // higher than planned, or the trunk swung the hips up) reaches for it (idle standing it would keep hopping);
        // filtered, since a lightly loaded foot's contact flickers step to step and the knee target jumped ~30° with it
        L.reach = follow(L.reach, v.feet[L.side > 0 ? 0 : 1].touching ? 0 : 1, dt, 0.03);
        const h = lerp(hIK, this.height + hUp * Math.max(gl, lv.contact, clamp(this.dropV / 0.3, 0, 1), clamp(this.pitchV / 0.5, 0, 1)), L.reach);
        const r = this.solve(L, L.F, L.yaw, gl * lerp(gw, gr, run) * (1 - lv.stance), 0, L.q[6], ROLL_RATE * dt, h, pIK);
        L.reachOK = r.ok; q = r.q;
        // the planted foot has left the leg's reach: it comes off the turf now rather than slide
        if (!r.ok && !this.frozen && !hold) this.lift(L, phi);
      }
      if (!L.stance) {
        const sw = clamp((phi - L.liftPhase) / (1 - L.liftPhase), 0, 1), hm = minJerk(sw);
        // touchdown solution with its foot roll filtered (the heel-rise search can switch branches between
        // steps), solved exactly for that roll so the foot still lands on the foothold
        const gRaw = this.solve(L, L.tdF, L.tdYaw, gTD).q[6];
        L.tdG = Number.isNaN(L.tdG) ? gRaw : follow(L.tdG, gRaw, dt, 0.03);
        const td = this.solve(L, L.tdF, L.tdYaw, L.tdG, 0, L.tdG, 0).q;
        const fwd = clamp(vf / 10, 0, 1), low = 1 - 0.6 * Math.max(lv.chop, lv.drive * (1 - run));
        const drive = (0.1 + 0.6 * fwd ** 1.5) * low, fold = (0.6 + 1.4 * clamp(sp / 10, 0, 1)) * low;
        // The thigh swings through early (hip flexion is fastest just after toe-off), so the folded shank passes
        // under the hip with the toe clear of the turf; it peaks past the touchdown angle and retracts onto it.
        const hh = minJerk(sw / lerp(1, 0.75, gl));
        q = [
          lerp(L.qLift[0], td[0], hh) + drive * bump(sw, 2.6, 1.8),
          lerp(L.qLift[1], td[1], hm),
          lerp(L.qLift[2], td[2], hm) + fold * bump(sw, 2, 3.2),
          // the ankle cocks up soon after toe-off (toe clearance) and only settles onto its touchdown angle late
          lerp(lerp(L.qLift[3], 0.1, s01(sw / 0.35)), td[3], s01((sw - 0.6) / 0.4)),
          lerp(L.qLift[4], td[4], hm),
          lerp(L.qLift[5], td[5], hm),
          lerp(L.qLift[6], td[6], hm),
        ];
        // A foot that scuffs the turf early in its swing is drawn up out of it (hip, knee and ankle flex: the
        // stumble reflex); dragged along, it loaded a folded leg and slid.
        const touch = v.feet[L.side > 0 ? 0 : 1].touching;
        L.scuff = follow(L.scuff, touch && sw < 0.6 ? 1 : 0, dt, touch ? 0.03 : 0.1);
        q[0] += 0.3 * L.scuff; q[2] += 0.6 * L.scuff; q[3] += 0.2 * L.scuff;
        // Running, a foot that meets the turf late in its swing (the body came down sooner than planned) gives:
        // driven on through the turf, the leg bounced a sprinter into a long hop.
        if (sw > 0.5 && touch && !v.playerContact) {
          const g = lerp(1, SWING_SOFT, clamp((sp - 4) / 2, 0, 1));
          for (const i of [L.hf, L.ab, L.rot, L.kn, L.knRot, L.dor, L.inv, L.toe]) if (i >= 0) out.gain[i] = g;
        }
      }
      this.writeLeg(L, q);
    }

    // ---- trunk, head, arms
    const ready = Math.max(lv.stance, shuffle, 0.7 * bp, 0.6 * lv.contact * (1 - run));
    this.add('thoracic.flex', (0.15 * lv.wrap + 0.1 * lv.stance) * (1 - lv.thrust) + 0.4 * this.bend);
    this.add('lumbar.flex', 0.1 * lv.sink - 0.2 * lv.thrust + 0.6 * this.bend);
    this.head(-0.9 * this.pitch + 0.35 * lv.tuck);
    const A = lerp(lerp(0.25, 0.85, clamp(sp / 9, 0, 1)) * gl, 0.15 * gl, ready);
    const c = Math.cos(TAU * p0);
    for (const arm of this.arms) {
      const sw = arm.side > 0 ? -c : c;   // each arm swings with the opposite leg
      let fl = lerp(0.05 * run, 0.6, ready) + A * sw, ab = lerp(0.12, 0.25, ready), rt = lerp(0.15, 0.3, ready);
      let el = lerp(lerp(0.35, 1.5, clamp(sp / 5, 0, 1)), 1.6, ready), wr = 0;
      const carry = arm.side > 0 ? lv.carryL : lv.carryR, reach = arm.side > 0 ? lv.reachL : lv.reachR;
      fl = lerp(fl, 0.35, carry); ab = lerp(ab, 0.1, carry); rt = lerp(rt, 0.7, carry); el = lerp(el, 2.0, carry); wr = lerp(wr, 0.2, carry);
      fl = lerp(fl, 1.3, lv.wrap); ab = lerp(ab, 0.45, lv.wrap); rt = lerp(rt, 0.9, lv.wrap); el = lerp(el, 1.4, lv.wrap);
      // shoot and reach point the arms forward of the body whatever the trunk's lean (shoulder flexion is relative
      // to the thorax), so a low athlete punches up and under instead of at the turf
      fl = lerp(fl, 1.35 + Math.max(0, this.pitch), lv.shoot); ab = lerp(ab, -0.05, lv.shoot); rt = lerp(rt, 0.1, lv.shoot); el = lerp(el, 0.1, lv.shoot); wr = lerp(wr, -0.6, lv.shoot);
      fl = lerp(fl, 1.45 + Math.max(0, this.pitch), reach); ab = lerp(ab, 0.15, reach); rt = lerp(rt, 0, reach); el = lerp(el, 0.25, reach);
      // thrust: the arms punch forward, or lift what they are wrapped around (elbows stay bent)
      fl = lerp(fl, 1.4, lv.thrust); ab = lerp(ab, 0.2, lv.thrust); el = lerp(el, lerp(0.3, 1.2, lv.wrap), lv.thrust);
      const k = arm.side > 0 ? 0 : 1, aimW = this.aimArm(v, cmd, arm, k, dt);
      fl = lerp(fl, this.aimAng[k][0], aimW); ab = lerp(ab, this.aimAng[k][1], aimW); el = lerp(el, 0.2, aimW);
      // pull: shoulder extension and a hard elbow bend, the hand drawn back to the ribs
      const pull = k === 0 ? lv.pullL : lv.pullR;
      fl = lerp(fl, 0.3, pull); ab = lerp(ab, 0.2, pull); rt = lerp(rt, 0.3, pull); el = lerp(el, 2.0, pull);
      this.setArm(arm, fl, ab, rt, el, wr);
      this.add(`sc${arm.side > 0 ? 'L' : 'R'}.protr`, 0.15 * Math.max(lv.wrap, lv.shoot, reach));
      // a pulling arm is held loosely: the row itself is the tracking controller's pull, sized to what the fist holds,
      // and a stiff arm still swinging to its reach pose would tear the fresh grip open
      const g = lerp(lerp(0.5, 1, clamp(Math.max(lv.contact, carry, reach, lv.wrap, lv.shoot, lv.thrust, aimW), 0, 1)), 0.3, pull);
      for (const i of this.armDofs[k]) out.gain[i] = g;
    }
    for (const i of this.neckDofs) out.gain[i] = 0.8;

    // ---- frame
    out.root.height = this.height; out.root.pitch = this.pitch; out.root.roll = this.roll;
    out.planted[0] = this.legs[0].stance; out.planted[1] = this.legs[1].stance;
    out.phase = this.phase - Math.floor(this.phase);
    this.clip = lv.cut > 0.5 ? 'cut' : lv.stance > 0.5 ? 'stance' : lv.chop > 0.5 ? 'chop' : lv.drive > 0.5 ? 'drive'
      : gl < 0.5 ? 'idle' : bp > 0.5 ? 'backpedal' : shuffle > 0.5 ? 'shuffle' : sp < 2.2 ? 'walk' : 'run';
  }

  private head(pitch: number) { this.add('neckLow.flex', 0.6 * pitch); this.add('neckUp.flex', 0.4 * pitch); }

  private setArm(a: Arm, fl: number, ab: number, rt: number, el: number, wr: number) {
    const Q = this.q;
    if (a.flex >= 0) Q[a.flex] = fl;
    if (a.abd >= 0) Q[a.abd] = ab;
    if (a.rot >= 0) Q[a.rot] = rt;
    if (a.elbow >= 0) Q[a.elbow] = el;
    if (a.wrist >= 0) Q[a.wrist] = wr;
  }

  /** Arm angles that point the arm from the shoulder toward cmd.aim; returns the arm's blend weight. */
  private aimArm(v: BodyView, cmd: Commands, arm: Arm, k: number, dt: number): number {
    const lv = this.lv, key = k === 0 ? 'aimL' : 'aimR';
    const reaching = lv.reachL > 0.05 || lv.reachR > 0.05;
    // the eyes guide a reaching hand to the nearest part of an opponent within reach (the world's reachTo)
    const aim = (reaching && v.reachTo?.[k]) || cmd.aim;
    lv[key] = follow(lv[key], aim ? (reaching ? (k === 0 ? cmd.armL : cmd.armR) : 1) : 0, dt, 0.1);
    if (aim && arm.seg >= 0) {
      const sp = v.state.segPos, d: Vec3 = [aim[0] - sp[3 * arm.seg], aim[1] - sp[3 * arm.seg + 1], aim[2] - sp[3 * arm.seg + 2]];
      const p = qrot(qconj(rootQuat(this.heading, this.pitch, this.roll)), d), n = Math.hypot(p[0], p[1], p[2]) || 1;
      const ab = Math.asin(clamp(arm.side * p[0] / n, -1, 1)), fl = Math.atan2(p[2], -p[1]);
      this.aimAng[k][0] = follow(this.aimAng[k][0], fl, dt, 0.06);
      this.aimAng[k][1] = follow(this.aimAng[k][1], ab, dt, 0.06);
    }
    return lv[key];
  }

  // ------------------------------------------------------------------ dive, down, get-up
  private startDive(v: BodyView, cmd: Commands) {
    const c = v.state.comVel, vh = Math.hypot(c[0], c[2]), run = s01((vh - 2) / 5), mm = Math.hypot(cmd.move.x, cmd.move.z);
    // along the way the player steers (the turn he is making), else the run, else the way he faces
    const dir: [number, number] = mm > 0.2 ? [cmd.move.x / mm, cmd.move.z / mm] : vh > 1 ? [c[0] / vh, c[2] / vh] : [Math.sin(this.heading), Math.cos(this.heading)];
    this.dv = { run, vh, dir, tL: lerp(DIVE.load[0], DIVE.load[1], run), tP: lerp(DIVE.push[0], DIVE.push[1], run), stage: 'load', vy: 0 };
    this.enter('dive', 0.8 * this.dv.tL);
  }

  /** Dive: load (hips, knees and ankles flex, arms swing back), launch (all three extend hard, arms punch
   *  forward), flight (arms reaching out, legs trailing) until the body lands on the turf (down). */
  private dive(v: BodyView, cmd: Commands, out: AnimFrame) {
    const D = this.dv, t = this.modeT, dt = v.dt, s = v.state;
    const uL = minJerk(t / D.tL), wP = minJerk((t - D.tL) / D.tP), wF = minJerk((t - D.tL - D.tP) / 0.15);
    D.stage = t < D.tL ? 'load' : t < D.tL + D.tP ? 'launch' : 'flight';
    // the body turns to face the way it dives while it loads and pushes
    if (D.stage !== 'flight') this.heading = wrapAngle(this.heading + clamp(wrapAngle(Math.atan2(D.dir[0], D.dir[1]) - this.heading), -TURN_RATE * dt, TURN_RATE * dt));
    const sd = lerp(1, 0.55, D.run), hLoad = this.standH - 0.16 * sd, pLoad = lerp(0.3, 0.45, D.run);
    // the push is forward first, then up: rising early would lift the feet off the turf before the speed is there
    D.vy = lerp(DIVE.vy[0], DIVE.vy[1], D.run) * wP;
    if (D.stage === 'load') {
      this.pitch = lerp(this.blendRoot.pitch, pLoad, uL);
      this.height = lerp(this.blendRoot.height, hLoad, uL);
      // the run's speed is kept through the load (the feet gather under the hips, they do not brake)
      this.vel[0] = D.dir[0] * D.vh; this.vel[2] = D.dir[1] * D.vh;
    } else if (D.stage === 'launch') {
      this.pitch = lerp(pLoad, 1.0, wP);
      this.height = lerp(hLoad, this.standH + 0.03, wP);
      const vh = Math.max(D.vh, DIVE.vStand);
      this.vel[0] = D.dir[0] * vh; this.vel[2] = D.dir[1] * vh;
    } else {
      this.pitch = follow(this.pitch, 1.3, dt, 0.1);
      this.height = follow(this.height, s.segPos[3 * this.pelvisSeg + 1], dt, 0.05);
      this.vel[0] = s.comVel[0]; this.vel[2] = s.comVel[2];
    }
    this.roll = follow(this.roll, 0, dt, 0.1);
    // The legs fold only a little ahead of the pelvis's real drop (IK from the measured pelvis, feet under the
    // hips), so the feet stay on the turf through the load; then hips, knees and ankles extend hard and trail.
    const h = this.height, p = this.pitch, fw = this.segAxis(v, this.pelvisSeg, [0, 0, 1]);
    this.height = Math.min(Math.max(h, s.segPos[3 * this.pelvisSeg + 1] - 0.03), this.standH);
    this.pitch = Math.atan2(-fw[1], Math.hypot(fw[0], fw[2]));
    const E: LegQ = [-0.25, 0.05, 0.05, -0.8, 0.4, 0, 0], F: LegQ = [-0.1, 0.05, 0.35, -0.5, 0, 0, 0];
    for (const L of this.legs) {
      const C = this.solve(L, [L.side * 0.12, 0], L.side * 0.08, 0).q;
      this.writeLeg(L, C.map((c, i) => lerp(lerp(c, E[i], wP), F[i], wF)) as LegQ);
      L.stance = false;
    }
    this.height = h; this.pitch = p;
    const fl = lerp(lerp(-0.6 * sd, 2.0, wP), 2.0, wF), el = lerp(0.4, 0.15, wP);
    for (const a of this.arms) this.setArm(a, fl, lerp(0.15, 0.25, wF), 0, el, 0);
    this.add('lumbar.flex', lerp(0.15 * (1 - wP), -0.15, wF));
    this.head(-0.3 - 0.4 * wP + 0.3 * (cmd.headTuck ? 1 : 0));
    out.root.height = this.height; out.root.pitch = this.pitch; out.root.roll = this.roll;
    // the feet push against the turf until take-off
    out.planted[0] = D.stage !== 'flight' && v.feet[0].touching; out.planted[1] = D.stage !== 'flight' && v.feet[1].touching;
    out.phase = clamp(t / (D.tL + D.tP), 0, 1);
  }

  /** Down: no pose to fight for, the muscles only hold the body loosely where it lies. */
  private down(v: BodyView, out: AnimFrame) {
    const s = v.state;
    this.q.set(s.q);
    out.gain.fill(0.15);
    const l = this.lying(v);
    this.heading = l.heading; this.pitch = l.pitch; this.roll = l.roll;
    this.vel = [s.comVel[0], 0, s.comVel[2]];
    this.height = s.segPos[3 * this.pelvisSeg + 1];
    out.root.height = this.height; out.root.pitch = this.pitch; out.root.roll = this.roll;
    out.planted[0] = out.planted[1] = false;
    out.phase = 0;
  }

  /** Get-up chosen by how the body lies: face down → push up to a knee → stand; face up → sit up → knee → stand. */
  /** How the trunk lies: face down or up, the heading he will stand up facing (head end when face down,
   *  feet end when face up), and the trunk's pitch and roll about that heading. */
  private lying(v: BodyView) {
    const up = this.segAxis(v, this.thoraxSeg, [0, 1, 0]), fw = this.segAxis(v, this.thoraxSeg, [0, 0, 1]);
    const faceDown = fw[1] < 0;
    const hx = faceDown ? up[0] : -up[0], hz = faceDown ? up[2] : -up[2];
    const heading = Math.hypot(hx, hz) > 0.2 ? Math.atan2(hx, hz) : this.measuredHeading(v);
    const sh = Math.sin(heading), ch = Math.cos(heading);
    return { faceDown, heading, pitch: Math.atan2(up[0] * sh + up[2] * ch, up[1]), roll: Math.atan2(up[0] * ch - up[2] * sh, Math.hypot(up[1], up[0] * sh + up[2] * ch)) };
  }

  private startGetup(v: BodyView) {
    const { faceDown, heading, pitch, roll } = this.lying(v);
    this.getup = { faceDown, heading, h0: v.state.segPos[3 * this.pelvisSeg + 1], p0: pitch, r0: roll, keys: [], downT: 0 };
    this.start.set(this.prevQ);
    this.mode = 'getup'; this.modeT = 0; this.settleT = 0; this.blendW = 1;
    this.heading = heading;
    this.vel = [0, 0, 0];
    this.resetFeet();
    // the two intermediate poses (pelvis frame), built once
    const pose = (hfL: number, knL: number, dorL: number, hfR: number, knR: number, dorR: number, arm: [number, number, number, number], lumbar: number, neck: number) => {
      this.q.fill(0);
      this.writeLeg(this.legs[0], [hfL, 0.1, knL, dorL, 0, 0, 0]);
      this.writeLeg(this.legs[1], [hfR, 0.1, knR, dorR, 0, 0, 0]);
      for (const a of this.arms) this.setArm(a, arm[0], arm[1], arm[2], arm[3], 0);
      this.add('lumbar.flex', lumbar); this.head(neck);
      return Float64Array.from(this.q);
    };
    const first = faceDown
      ? pose(1.6, 2.2, -0.3, 1.6, 2.2, -0.3, [1.3, 0.15, 0, 0.3], 0.3, -0.3)   // push up, knees drawn under
      : pose(1.7, 2.0, 0, 1.7, 2.0, 0, [0.9, 0.15, 0, 0.4], 0.5, 0.2);         // sit up, feet drawn in
    const kneel = pose(1.5, 1.5, 0.1, 0.1, 1.6, -0.4, [0.5, 0.2, 0, 0.8], 0.2, -0.2); // one knee
    this.getup.keys = [first, kneel];
  }

  private doGetup(v: BodyView, out: AnimFrame) {
    const t = clamp(this.modeT / GETUP_T, 0, 1), G0 = this.getup;
    // standing pose = locomotion standing still (feet at home), also the hand-over pose at t = 1
    this.loco(v, this.neutral, true, out);
    const stand = Float64Array.from(this.q), standH = this.height;
    const keys = [this.start, G0.keys[0], G0.keys[1], stand];
    const at = [0, 0.3, 0.62, 1];
    const hs = [G0.h0, G0.faceDown ? 0.45 : 0.22, 0.55, standH];
    const ps = [G0.p0, G0.faceDown ? 1.1 : 0.4, 0.35, 0];
    let k = 0;
    while (k < 2 && t > at[k + 1]) k++;
    const w = minJerk((t - at[k]) / (at[k + 1] - at[k]));
    for (let i = 0; i < this.n; i++) this.q[i] = lerp(keys[k][i], keys[k + 1][i], w);
    this.height = lerp(hs[k], hs[k + 1], w);
    this.pitch = lerp(ps[k], ps[k + 1], w);
    this.roll = lerp(G0.r0, 0, minJerk(t / 0.3));
    out.root.height = this.height; out.root.pitch = this.pitch; out.root.roll = this.roll;
    out.planted[0] = t > 0.45; out.planted[1] = t > 0.8;
    out.phase = t;
    for (const i of [...this.armDofs[0], ...this.armDofs[1]]) out.gain[i] = 1;
  }
}
