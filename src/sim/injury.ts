// Injuries (owner decision 2026-10-18, design §6.6): a joint breaks when its range-of-motion limit carries more
// torque than the tolerance below, and an athlete is knocked out when his head's velocity changes faster than a
// concussive blow. Detection only reads the physics; World applies what follows. The same for every athlete.
import type { MuscleSet } from './muscles';
import type { AthleteState } from './physics/engine';
import type { Vec3 } from './math';

/** Breakable dofs (joint name without its side, dof): which end of the range breaks (−1 lower, +1 upper, 0 either),
 *  the tolerance of the limit torque averaged over LOAD_TAU (N·m), how far the broken end of the range gives way
 *  (rad), and what breaks. Tolerances sit above the most the model's limits carried in ordinary tackles and sprints
 *  (docs/realism-sources.md [S6]: the soft limits also carry load real muscles share, so they are calibrated, not
 *  cadaver values). Hip, spine, neck and wrist are not breakable: the hip and spine take loads in ordinary play beyond any break, the
 *  hands driven into a chest load the wrist limits ~340 N·m in a 5 m/s punch, and the head is covered by the knockout. */
export const BREAK: Record<string, { side: -1 | 0 | 1; torque: number; relax: number; what: string }> = {
  'knee.flex': { side: -1, torque: 160, relax: 0.9, what: 'knee' },        // hyper-extension
  'elbow.flex': { side: -1, torque: 110, relax: 1.0, what: 'elbow' },      // hyper-extension (a dive landing on straight arms: ~70)
  'ankle.inv': { side: 0, torque: 320, relax: 0.8, what: 'ankle' },        // rolled ankle / fracture
  'shoulder.flex': { side: 0, torque: 170, relax: 1.0, what: 'shoulder' }, // dislocation
  'shoulder.abd': { side: 0, torque: 170, relax: 1.0, what: 'shoulder' },
  'shoulder.intRot': { side: 0, torque: 170, relax: 1.0, what: 'shoulder' },
  'sc.elev': { side: 0, torque: 360, relax: 0.6, what: 'collarbone' },
  'sc.protr': { side: 0, torque: 360, relax: 0.6, what: 'collarbone' },
};
/** Averaging time of the limit torque (s): a broken joint is a load held for a moment, not one solver step. */
const LOAD_TAU = 0.01;
/** Breaks are traumatic only: within this long of touching another athlete (s), the hit and the fall that follows.
 *  Away from contact the model's limits carry cuts and landings that real muscles would mostly take, so a hard cut
 *  rolled ankles (347 N·m measured) that a real athlete's peroneals and ligaments hold (assumption, design §6.6). */
const CONTACT_WINDOW = 1;
/** Knockout: the head's velocity change over KO.window (s, about the duration of a helmet impact [S6]), gravity
 *  removed, beyond KO.dv (m/s). Concussed NFL players' heads changed velocity by 7.2 ± 1.8 m/s [S6]; a knockout
 *  (loss of consciousness) is the severe end of that. */
export const KO = { window: 0.015, dv: 10 };
/** Playing on hurt (owner item 2026-10-18): a broken leg's muscles keep `legTone` of their output (assumption: pain
 *  and the injury let him load it only lightly), he hobbles at `speed` × his top speed, the bad leg's stance lasts
 *  `badStance` × and the good leg's `goodStance` × the gait's (a limp: off the bad leg quickly, onto the good one).
 *  A broken arm hangs limp. */
export const HOBBLE = { legTone: 0.35, speed: 0.4, badStance: 0.6, goodStance: 1.35 };
const ARM = /^(sc|shoulder|elbow|wrist)[LR]$/, LEG = /^(hip|knee|ankle|toe)[LR]$/;

/** What a body's controller and animator read of its injuries: broken legs and arms [left, right], and each dof's
 *  remaining muscle tone (1 sound, 0 limp). */
export interface Hurt { readonly leg: readonly boolean[]; readonly arm: readonly boolean[]; readonly tone: Float64Array }

export interface InjuryEvent {
  athlete: number;
  kind: 'break' | 'ko';
  /** Broken joint with its side (e.g. 'kneeL'), or 'head' for a knockout. */
  joint: string;
  /** What broke ('knee', 'collarbone', …) or 'ko'. */
  what: string;
  /** The segment below the joint (where a bone pokes out), and the joint's parent segment. */
  seg: string; parentSeg: string;
  /** World point: the joint centre, or the head. */
  pos: Vec3;
  /** The load that did it: limit torque (N·m) or head velocity change (m/s). */
  load: number;
  time: number;
}

const G = 9.81;

/** One athlete's injury state: what is broken, whether he is knocked out, and the filtered loads behind them. */
export class InjuryState implements Hurt {
  ko = false;
  /** Broken joints (with side), the limbs they belong to [left, right], and each dof's remaining muscle tone. */
  readonly broken = new Set<string>();
  readonly leg = [false, false]; readonly arm = [false, false];
  readonly tone: Float64Array;
  private readonly rules: ({ joint: string; side: -1 | 0 | 1; torque: number; relax: number; what: string } | null)[];
  private readonly load: Float64Array;
  private readonly head: Vec3[];
  private headAt = 0; private headN = 0;
  /** Time since this athlete last touched another athlete (s). */
  private sinceContact = Infinity;
  /** Largest filtered limit torque per dof and head velocity change seen (for tests and tuning). */
  readonly peak: Float64Array; peakDv = 0;

  /** `bones` scales every break tolerance (the bone-strength setting: lower breaks more easily). */
  constructor(private muscles: MuscleSet, dt: number, bones = 1) {
    this.rules = muscles.names.map((n) => {
      const [j, d] = n.split('.'), base = j.replace(/[LR]$/, ''), r = BREAK[`${base}.${d}`];
      return r && base !== j ? { joint: j, ...r, torque: r.torque * bones } : null;
    });
    this.load = new Float64Array(muscles.n); this.peak = new Float64Array(muscles.n);
    this.tone = new Float64Array(muscles.n).fill(1);
    this.head = Array.from({ length: Math.max(1, Math.round(KO.window / dt)) }, () => [0, 0, 0] as Vec3);
  }

  /** Out of play: down for the rest of the rep (no get-up, no support, no brain). Knocked out, or both legs broken
   *  (nothing to stand on); a single break he plays on with. */
  get out() { return this.ko || (this.leg[0] && this.leg[1]); }
  /** How long he has been out of play (s). */
  outFor = 0;

  /** Joints that break this step: the dofs, with the end of their range that gave way. */
  checkBreaks(limit: Float64Array, s: AthleteState, playerContact: boolean, dt: number) {
    const out: { dof: number; joint: string; end: -1 | 1; relax: number; what: string; load: number }[] = [], al = 1 - Math.exp(-dt / LOAD_TAU), ms = this.muscles;
    this.sinceContact = playerContact ? 0 : this.sinceContact + dt;
    for (let i = 0; i < ms.n; i++) {
      this.load[i] += (limit[i] - this.load[i]) * al;
      if (this.load[i] > this.peak[i]) this.peak[i] = this.load[i];
      const r = this.rules[i];
      if (!r || this.broken.has(r.joint) || this.load[i] <= r.torque || this.sinceContact > CONTACT_WINDOW) continue;
      const end = s.q[i] < 0.5 * (ms.lo[i] + ms.hi[i]) ? -1 : 1;
      if ((r.side !== 0 && r.side !== end) || out.some((o) => o.joint === r.joint)) continue;
      out.push({ dof: i, joint: r.joint, end, relax: r.relax, what: r.what, load: this.load[i] });
    }
    return out;
  }

  /** The head's velocity change over KO.window, gravity removed (m/s); true the step it first passes KO.dv. */
  checkKo(v: Vec3, dt: number): boolean {
    const old = this.head[this.headAt], k = this.head.length;
    let dv = 0;
    if (this.headN >= k) dv = Math.hypot(v[0] - old[0], v[1] - old[1] + G * k * dt, v[2] - old[2]);
    this.head[this.headAt] = [v[0], v[1], v[2]]; this.headAt = (this.headAt + 1) % k; this.headN++;
    if (dv > this.peakDv) this.peakDv = dv;
    if (this.ko || dv <= KO.dv) return false;
    return (this.ko = true);
  }

  /** A broken arm goes limp from the collarbone to the wrist; a broken leg's muscles keep HOBBLE.legTone. */
  breakJoint(joint: string) {
    this.broken.add(joint);
    const arm = ARM.test(joint), limb = arm ? ARM : LEG, sx = joint.slice(-1);
    if (!limb.test(joint)) return;
    (arm ? this.arm : this.leg)[sx === 'L' ? 0 : 1] = true;
    this.muscles.names.forEach((n, i) => { const j = n.split('.')[0]; if (limb.test(j) && j.endsWith(sx)) this.tone[i] = Math.min(this.tone[i], arm ? 0 : HOBBLE.legTone); });
  }
}
