// Tracking motor controller (active ragdoll, design §6.5). The muscles track the animator's pose; the world's
// support carries the body along the animation's root target. When the support levels drop (player contact,
// knocked off balance) the targets blend toward the hand-built balance controller, so a hit athlete steps and
// fights for balance physically; they blend back once the support returns. Everything stays within the muscles.
import { totalMass, type BodyPlan } from '../anatomy/body';
import { DEFAULT_SUPPORT, newFrame, weightSupport, type AnimFrame, type Animator, type RootTarget, type SupportSettings, type SupportState } from '../anim/types';
import { clamp, cross, dot, G, vecAt, type Vec3 } from '../math';
import { newTargets, type MuscleSet, type MuscleTargets } from '../muscles';
import { ProceduralAnimator } from '../anim/procedural';
import { DT_REF, gravityComp, HandController } from './hand';
import { neutralCommands, type BodyView, type Commands, type MotorController } from './types';

/** Tracking natural frequency (rad/s) with the distal inertia, per body region. */
const WN = { leg: 35, arm: 20, trunk: 25 };
/** Without support (world without SupportSettings) the hand controller balances alone. */
const NO_SUPPORT: SupportState = { posture: 0, carry: 0, down: false };
/** Share of muscle output a full stun takes away. */
const STUN_LOOSE = 0.6;
/** Stun gained in one step that marks the jolt of a big hit (an impact's impulse lands in a few steps). */
const JOLT = 0.05;
/** Forward drive of a full hip thrust, × body weight: a near-maximal leg extension, about the ~1 body weight of
 *  horizontal force a sprint start puts into the turf [S4], for the explosive first `time` s; through the rest of the
 *  thrust the legs keep driving at `held` (a maximal effort is brief). */
const THRUST_DRIVE = { burst: 1, held: 0.5, time: 0.5 };
/** Upward push of each hand in a full thrust, N (assumption: about what one arm curls up at chest height). */
const THRUST_LIFT = 250;
/** Stance push of a jump's take-off, × body weight over both legs: a counter-movement jump's propulsive ground force
 *  averages ~2 body weights [S4]; the world's launch carry (the same as a dive's) adds what the legs fall short of. */
const JUMP_PUSH = 2;
/** Leg drive in contact at full driveLegs, × body weight (assumption: a hard sled drive, both legs). */
const DRIVE = 1;
/** Pull of each hand that holds an opponent with the arm raised, × its grip strength: about as hard as the fist
 *  holds without being pulled open (the grip breaks at 1.5×, World's GRIP_ECC); the arm muscles cap it too. */
const PULL = 0.5;
/** Damping of a limp (broken) arm's dofs, × the tracking's critical damping at full gain (I·wn): its swing relative
 *  to the body dies away in ~0.2 s (assumption), floppy but not whipping. */
const LIMP_DAMP = 0.25;
/** Pelvis drop below standing (m) at which a driving athlete is fully low: his drive lifts with the arms. */
const LOW_DROP = 0.25;

export class TrackingController implements MotorController {
  /** The world's support tuning (World.create hands its own object in, so panel edits reach it). */
  supportSettings: SupportSettings = DEFAULT_SUPPORT;
  /** 0..1 stun from the world (a big hit received): scales all muscle output down by up to STUN_LOOSE. */
  stun = 0;
  lod = false;
  private prevStun = 0;
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
  private arms: { dofs: number[]; hand: number }[];
  private pelvisSeg: number;
  private thoraxSeg: number;
  private standH: number;
  private grip: number;
  /** Arm (0 left, 1 right) each dof belongs to, or −1. */
  private armOf: Int8Array;
  /** Fraction of time some foot carries the legs' share of the weight (low-passed): sizes the stance push. */
  private grounded = 0.6;
  /** How long the current hip thrust has run (s). */
  private thrustT = 0;
  private handCmd: Commands = neutralCommands();
  private prevDive = false;
  private dbg: Record<string, number | string> = {};

  constructor(plan: BodyPlan, private muscles: MuscleSet, animator?: Animator) {
    this.animator = animator ?? new ProceduralAnimator(plan, muscles);
    this.hand = new HandController(plan, muscles);
    this.frame = newFrame(muscles.n);
    this.handOut = newTargets(muscles.n);
    this.trackOut = newTargets(muscles.n);
    this.mass = totalMass(plan);
    const S = (n: string) => plan.segments.findIndex((s) => s.name === n);
    this.pelvisSeg = S('pelvis');
    this.thoraxSeg = S('thorax') >= 0 ? S('thorax') : S('trunk');
    const region = (n: string) => (/^(hip|knee|ankle|toe)/.test(n) ? 'leg' : /^(sc|shoulder|elbow|wrist)/.test(n) ? 'arm' : 'trunk');
    this.wn = Float64Array.from(muscles.names.map((n) => WN[region(n)]));
    this.kMin = Float64Array.from(muscles.names, (n, i) => (region(n) === 'leg' ? 2 : 0.6) * 0.5 * (muscles.tPos[i] + muscles.tNeg[i]));
    this.isLeg = Uint8Array.from(muscles.names.map((n) => (region(n) === 'leg' ? 1 : 0)));
    const chain = (sx: string, joints: string[]) => joints.flatMap((j) => muscles.names.flatMap((n, i) => (n.startsWith(j + sx + '.') ? [i] : [])));
    this.chains = ['L', 'R'].map((sx) => chain(sx, ['hip', 'knee', 'ankle']));
    this.arms = ['L', 'R'].map((sx) => ({ dofs: chain(sx, ['sc', 'shoulder', 'elbow', 'wrist']), hand: S('hand' + sx) >= 0 ? S('hand' + sx) : S('forearm' + sx) }));
    this.armOf = new Int8Array(muscles.n).fill(-1);
    this.arms.forEach((a, k) => { for (const i of a.dofs) this.armOf[i] = k; });
    this.standH = plan.standHeight;
    this.grip = plan.gripStrength;
  }

  root(): RootTarget { return this.frame.root; }
  debug() { return this.dbg; }

  compute(v: BodyView, cmd: Commands, out: MuscleTargets) {
    const sup = v.support ?? NO_SUPPORT, set = this.supportSettings, n = this.muscles.n;
    this.animator.update(v, cmd, sup, this.frame);
    // The hand controller runs every step so its gait and balance state are current when it is blended in.
    // It sees a dive only on the press (one press is one dive, however long it is held), and a hip thrust for as long
    // as the animator's one-press thrust runs.
    const r = this.frame.root;
    Object.assign(this.handCmd, cmd).dive = cmd.dive && !this.prevDive;
    this.handCmd.thrustHips = r.thrust > 0.05;
    this.prevDive = cmd.dive;
    // The carry fades through a running stride's flight; off contact that is no reason to hand the legs to the balance
    // controller (it did, every long stride, and the landing came on legs placed for a different gait).
    const flying = !v.playerContact && !v.feet[0].touching && !v.feet[1].touching && Math.hypot(r.vel[0], r.vel[2]) > 3;
    let want = 1 - Math.min(sup.posture, flying ? 1 : sup.carry);
    // A hip thrust has priority: the muscles drive the thrust pose, in contact too, while the athlete still
    // has his posture. Dive flight has nothing to balance: the muscles hold the dive pose until the landing.
    want = r.dive === 'flight' || r.jump === 'flight' ? 0 : Math.min(want, 1 - sup.posture * r.thrust);
    // injured or knocked out: no balance reaction, only the animation's loose hold on where the body lies
    if (sup.out) want = 0;
    // (far from play, on a low preset, the balance controller rests while it is blended out and nothing calls it in)
    if (!this.lod || want > 0 || this.blend !== 0) this.hand.compute(v, this.handCmd, this.handOut);
    // in quickly (a hit; at once on the jolt of a big one, so the body reacts the step it lands, not to a shove's
    // slowly growing stun), out slowly (the animation takes over again once the support is back), except a thrust
    const jolt = this.stun - this.prevStun > JOLT;
    this.prevStun = this.stun;
    const tOut = r.thrust > 0.05 ? 0.08 : 0.3, tIn = jolt ? v.dt : 0.08;
    this.blend = this.blend < 0 ? want : this.blend + clamp(want - this.blend, -v.dt / tOut, v.dt / tIn);
    const b = this.blend;
    // share of body weight the legs carry: what the posture support does not
    const legShare = clamp(1 - set.weightShare * sup.posture * set.strength * weightSupport(r), 0, 1);
    this.track(v, this.trackOut, legShare, set.tracking);
    const h = this.handOut, t = this.trackOut, loose = 1 - STUN_LOOSE * clamp(this.stun, 0, 1);
    // An arm the player reaches with keeps the animation's aim and pull pose in contact too: balance does not
    // need it, and the hand controller knows no aim. A wrap is the hand controller's squeeze.
    const armB = [cmd.armL, cmd.armR].map((x) => b * (cmd.wrap ? 1 : 1 - clamp(x, 0, 1)));
    for (let i = 0; i < n; i++) {
      const bi = this.armOf[i] >= 0 ? armB[this.armOf[i]] : b;
      // blend torques, not set points: kp·q and kd·qd are mixed so the spring and damper terms add up exactly
      const kp = t.kp[i] + (h.kp[i] - t.kp[i]) * bi, kd = t.kd[i] + (h.kd[i] - t.kd[i]) * bi;
      const kq = t.kp[i] * t.q[i] + (h.kp[i] * h.q[i] - t.kp[i] * t.q[i]) * bi;
      const kv = t.kd[i] * t.qd[i] + (h.kd[i] * h.qd[i] - t.kd[i] * t.qd[i]) * bi;
      out.kp[i] = kp; out.kd[i] = kd;
      out.q[i] = kp > 1e-9 ? kq / kp : t.q[i] + (h.q[i] - t.q[i]) * bi;
      out.qd[i] = kd > 1e-9 ? kv / kd : 0;
      // the hand controller's leg forces assume the legs carry all the weight; with support they carry legShare
      out.tff[i] = t.tff[i] + (h.tff[i] * (this.isLeg[i] ? legShare : 1) - t.tff[i]) * bi;
      // stunned: less tone everywhere (after the blend, so the balance controller loosens too)
      out.kp[i] *= loose; out.kd[i] *= loose; out.tff[i] *= loose;
    }
    // Leg drive in contact (whichever controller holds the legs): the stance legs extend along the line from the
    // foot through the trunk. A low athlete (feet behind, trunk forward) drives forward and up into what he hits;
    // an upright one mostly pushes himself up. Only the forward part of that line counts as drive.
    const dl = v.playerContact ? Math.max(clamp(cmd.driveLegs, 0, 1), r.thrust) : 0;
    if (dl > 0) this.legDrive(v, out, dl * DRIVE * this.mass * G * loose, r.heading);
    // The arms: a thrust, or a low drive, lifts what they push against (up and under); a hand holding an opponent
    // with the arm raised rows him in toward the chest. τ = Jᵀ F at the hand, within the muscles' limits.
    const low = clamp((this.standH - r.height) / LOW_DROP, 0, 1), lift = v.playerContact ? Math.max(r.thrust, dl * low) * THRUST_LIFT : 0;
    const th = vecAt(v.state.segCom, this.thoraxSeg);
    this.arms.forEach((arm, k) => {
      const p = vecAt(v.state.segCom, arm.hand), F: Vec3 = [0, lift, 0];
      if (v.grips?.[k] && (k === 0 ? cmd.armL : cmd.armR) > 0.3 && !cmd.wrap && r.thrust <= 0.05) {
        const d: Vec3 = [th[0] - p[0], th[1] - p[1], th[2] - p[2]], m = Math.hypot(...d) || 1;
        for (let j = 0; j < 3; j++) F[j] += PULL * this.grip * d[j] / m;
      }
      if (F[0] === 0 && F[1] === 0 && F[2] === 0) return;
      for (const i of arm.dofs) {
        const a = vecAt(v.state.dofAnchor, i);
        out.tff[i] += loose * dot(cross(vecAt(v.state.dofAxis, i), [p[0] - a[0], p[1] - a[1], p[2] - a[2]]), F);
      }
    });
    // A broken arm hangs and swings with the body: no muscle force at all, only a little damping (the torn tissue's;
    // light segments need some at 240 Hz), toward rest, never toward a pose.
    if (v.hurt) for (let i = 0; i < n; i++) if (v.hurt.tone[i] === 0) { out.kp[i] = 0; out.tff[i] = 0; out.qd[i] = 0; out.kd[i] = LIMP_DAMP * this.muscles.ieff[i] * this.wn[i]; }
    this.dbg = { clip: this.frame.clip, phase: this.frame.phase, blend: b, legShare, stun: this.stun, mode: String(this.hand.debug().mode ?? '') };
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
      // A limp body's frame follows its own measured pose: tracking that pose's velocity too would cancel the
      // implicit damping a step late, which light segments (the clavicle) do not survive at 240 Hz.
      out.qd[i] = v.support?.out ? 0 : f.qd[i];
      out.kp[i] = kp;
      out.kd[i] = Math.max(2 * Math.sqrt(kp * I), 0.03 * kp);
      out.tff[i] = 0;
    }
    const stance = [0, 1].filter((k) => f.planted[k] && v.feet[k].touching);
    this.grounded += ((stance.length > 0 ? 1 : 0) - this.grounded) * Math.min(1, v.dt / 0.4);
    const stanceDofs = new Set(stance.flatMap((k) => this.chains[k]));
    // in free fall no joint carries the weight of what hangs from it
    // (nor does a limp, injured body hold its limbs up)
    if (f.root.dive !== 'flight' && f.root.jump !== 'flight' && !v.support?.out) for (let i = 0; i < ms.n; i++) if (!stanceDofs.has(i)) gravityComp(s, this.hand.carried, this.hand.segMass, i, out);
    const th = f.root.thrust;
    this.thrustT = th > 0.05 ? this.thrustT + v.dt : 0;
    if (stance.length === 0) return;
    // Over a gait cycle the legs deliver legShare of the weight while they are on the ground, so each stance
    // pushes harder the less of the time the feet are down (sprinting).
    // Height feedback keeps a hard stance push from launching the body above the animation's pelvis height;
    // a hip thrust may push up to its full strength (the muscles' limits cap it) and drives forward as well.
    const pi = this.pelvisSeg, dh = f.root.height - s.segPos[3 * pi + 1], vy = s.segVel[3 * pi + 1];
    // A jump's take-off is the exception: the legs extend as hard as they can, however fast the body already rises.
    const Fy = f.root.jump === 'launch' ? JUMP_PUSH * f.root.power * this.mass * G / stance.length
      : legShare * this.mass * G / Math.max(0.3, this.grounded) / stance.length * clamp(1 + 10 * Math.min(dh, 0.15) - (1.5 + 2.5 * th) * vy, 0, 2 + th);
    const Fh = th * (this.thrustT < THRUST_DRIVE.time ? THRUST_DRIVE.burst : THRUST_DRIVE.held) * this.mass * G / stance.length;
    const F: Vec3 = [Fh * Math.sin(f.root.heading), Fy, Fh * Math.cos(f.root.heading)];
    for (const k of stance) {
      // Applied at the ankle: hip and knee carry the weight, the ankle only tracks. Pushing at the centre of
      // pressure loaded the ankle with full plantarflexion as a foot landed on its toes, and folded it past its limit.
      // A thrust is the exception: the calves drive too, pushing through the ball of the foot.
      const an = this.ankle(v, this.chains[k]), cop = v.feet[k].cop;
      const p: Vec3 = th > 0 ? [an[0] + (cop[0] - an[0]) * th, an[1] + (cop[1] - an[1]) * th, an[2] + (cop[2] - an[2]) * th] : an;
      for (const i of this.chains[k]) {
        const a = vecAt(s.dofAnchor, i);
        // τ = −Jᵀ F: the leg pushes the turf with −F
        out.tff[i] += -dot(cross(vecAt(s.dofAxis, i), [p[0] - a[0], p[1] - a[1], p[2] - a[2]]), F);
      }
    }
  }

  /** τ = −Jᵀ F on each touching foot's leg, F (N, total) along the foot → thorax line, forward of the heading only. */
  private legDrive(v: BodyView, out: MuscleTargets, F: number, heading: number) {
    const s = v.state, feet = [0, 1].filter((k) => v.feet[k].touching);
    if (!feet.length) return;
    const th = vecAt(s.segCom, this.thoraxSeg), hx = Math.sin(heading), hz = Math.cos(heading);
    for (const k of feet) {
      const an = this.ankle(v, this.chains[k]), d: Vec3 = [th[0] - an[0], th[1] - an[1], th[2] - an[2]];
      const fwd = Math.max(0, d[0] * hx + d[2] * hz), up = Math.max(0, d[1]), n = Math.hypot(fwd, up);
      if (n < 1e-6) continue;
      const f = F / feet.length / n, Fv: Vec3 = [f * fwd * hx, f * up, f * fwd * hz];
      for (const i of this.chains[k]) {
        const a = vecAt(s.dofAnchor, i);
        out.tff[i] += -dot(cross(vecAt(s.dofAxis, i), [an[0] - a[0], an[1] - a[1], an[2] - a[2]]), Fv);
      }
    }
  }

  private ankle(v: BodyView, chain: number[]): Vec3 { const i = chain[chain.length - 1]; return vecAt(v.state.dofAnchor, i); }
}
