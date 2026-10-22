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
import { HOBBLE } from '../injury';
import { THROW } from '../throw';
import { clamp, lerp, qconj, qrot, wrapAngle, type Quat, type Vec3 } from '../math';
import type { MuscleSet } from '../muscles';
import { legIKInto } from './ik';
import { rootQuat } from './kinematics';
import type { AnimFrame, Animator, SupportState } from './types';
import { JUMP_DEFAULTS, RUN_TAKEOFF, type JumpTuning } from './jump';

const TAU = 2 * Math.PI, G = 9.81;
const s01 = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const minJerk = (x: number) => { const s = clamp(x, 0, 1); return s * s * s * (10 + s * (6 * s - 15)); };
/** Smooth bump on 0..1 peaking (at 1) at a/(a+c), with zero slope at both ends. */
const bump = (s: number, a: number, c: number) => {
  if (s <= 0 || s >= 1) return 0;
  const p = a / (a + c);
  return (s ** a * (1 - s) ** c) / (p ** a * (1 - p) ** c);
};
/** An arm's aim direction p (shoulder to target, root frame: y up, z forward, side·x outward) kept in front of the
 *  trunk: a target behind the shoulder's frontal plane (as after a quick turn) is aimed out to the arm's own side at
 *  its height, so the hand comes round the outside instead of through the torso. Targets in front are unchanged, and so
 *  are high ones behind (over the shoulder, as a deep catch: the arm goes up and back, never through the trunk). */
export const frontAim = (p: Vec3, side: number): Vec3 =>
  p[2] < 0 && p[1] < 0.5 * Math.hypot(p[0], p[2]) ? [side * (Math.abs(p[0]) - p[2]), p[1], 0] : p;
/** Bear hug (cmd.hug): each arm reaches out nearly straight (elbow `el[0]`, rotation `rt[0]`) for a point `side` m out to its
 *  own side of cmd.aim and `past` m beyond it (round his side to his back), and once that hand has come past the aim (beyond
 *  his middle) squeezes: elbows out `wide` rad more and `drop` rad lower (so the curl stays level instead of riding up over
 *  his shoulders) and bent hard, the forearms curled in round his back. The squeeze comes in as the aim comes from `open` to
 *  `close` m ahead of the shoulder. With pads on, chest to chest, the wrists reach his sides at about his middle. */
const HUG = { side: 0.45, past: 0.15, open: 0.9, close: 0.45, rt: [0.2, 1.2], el: [0.15, 1.9], wide: 0.4, drop: 0.5 };
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
/** Get-up with a move command held: clip speed-up, and the share of the clip after which he may run off (both feet
 *  are planted from 0.8). */
const GETUP_HURRY = 1.35, GETUP_GO = 0.82;
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
/** A thrust fires out along the pads (owner request 2026-10-18; docs/realism-sources.md S4, hip thrust). From lowered
 *  pads the trunk keeps the pitch it had at the press, up to `pitchMax` (rad, ~46°, a sprint start's first-step trunk:
 *  steeper drove the head at the turf), coming up by `rise` (rad) over the thrust, and on contact all the way to an
 *  upright thrust's lean (`uncoil` of the way, rad: the hips roll through the hit); fully low from a pitch of `low`, not
 *  at all below `upright` (rad: there it is the upright thrust, forward and up onto the toes). The pelvis keeps `keep`
 *  of its drop at the press, at most `dropMax` (m): the hips extend behind the pads instead of standing up. The neck
 *  extends by `neck` more (rad: eyes up). Near-shoulder strike: the trunk turns `turn` (rad, within the thoracic
 *  spine's ±30°) about its own axis so the leading shoulder's pad is ahead, the neck turns the eyes back to the front,
 *  and from lowered pads the trunk (`bank`, rad, thoracic and lumbar side bend) and neck (`neckLat`, rad) bend the head
 *  away from that shoulder, out of the hit. */
const THRUST = { pitchMax: 0.8, rise: 0.3, uncoil: 1, upright: 0.2, low: 0.7, keep: 0.5, dropMax: 0.15, neck: 0.4, turn: 0.5, bank: 0.6, neckLat: 0.6 } as const;
/** Jump [S4]; the tunable parts (counter-movement, push, landing, cooldown, press buffer) are JumpTuning's (jump.ts).
 *  Standing, a counter-movement (hips, knees and ankles flex) then a push; quicker and shallower than a maximal
 *  counter-movement jump's ~0.35 m dip in ~0.4 s (owner request 2026-10-19: snappy). From a run (faster than `runFrom`,
 *  m/s) there is no counter-movement: it is a one-foot take-off off the next foot down, a hurdler's, whose stance lasts
 *  while the planted leg can reach the turf, at most `runPush` (s). The take-off's vertical target (m/s, × √strength)
 *  is above what the push reaches, so the world's launch pushes at its cap for as long as a foot is on the turf. Then how
 *  long both feet must be off the turf to count as airborne (s), the longest flight before giving up on a landing and
 *  how long past the push he may stay on the turf before giving the jump up (s), and how far (m) a planted foot may be
 *  behind the hips and still be a fresh plant to take off from. */
const JUMP = { vy: 4, ext: 0.04, off: 0.02, maxFlight: 1.5, stuck: 0.3, fresh: 0.05 } as const;
/** A running take-off's legs: the pushing leg extended behind the hips onto its toes, the other knee driven up; and the
 *  hurdle's tuck in the air (heels drawn up under the hips). */
const JUMP_PUSH_LEG: LegQ = [-0.5, 0.05, 0.1, -0.6, 0.3, 0, 0], JUMP_LEAD_LEG: LegQ = [1.3, 0.08, 1.6, 0.2, 0, 0, 0];
const JUMP_TUCK: LegQ = [0.9, 0.08, 1.4, 0.1, 0, 0, 0], JUMP_HURDLE: LegQ = [1.5, 0.08, 2.35, 0.2, 0, 0, 0];
type DiveStage = 'load' | 'launch' | 'flight';

type Mode = 'loco' | 'dive' | 'jump' | 'down' | 'getup';
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
interface Arm { side: 1 | -1; flex: number; abd: number; rot: number; elbow: number; wrist: number; seg: number; hand: number }
/** Arm angles [flexion, abduction, internal rotation, elbow flexion, wrist flexion] (rad, the same for either side). */
type ArmQ = [number, number, number, number, number];
/** Looking (Commands.look): the thorax's and the neck's largest turn (rad, their rotation ranges [S3]: thoracic 30°,
 *  neck 35° + 45°) and how fast the turn follows (s). */
const LOOK = { thorax: 0.52, neck: 1.4, tau: 0.08 };
/** The throwing motion (docs/passing.md), over THROW's times: the throwing arm cocks (upper arm out level with the
 *  shoulder, externally rotated, elbow at a right angle: the ball by the ear), whips through to the release (arm up and
 *  forward over the shoulder, elbow nearly straight, the wrist flicking) and follows through down across the body; the
 *  off arm points at the target, then pulls in. The hips and shoulders turn side-on to the target as the arm cocks
 *  (the heading `turn` rad off it, the thorax `twist` further) and square up through the release, the shoulders a
 *  little past. Shapes of an overhand pass (Rash & Shapiro 1995, J Appl Biomech 11:443; assumption: angles chosen to
 *  look like it within the joints' ranges [S3]). */
const PASS = {
  cock: [0, 1.6, -1.5, 1.6, -0.5] as ArmQ, release: [1.6, 0.6, 0, 0.3, 0.3] as ArmQ, follow: [0.9, 0.3, 0.9, 0.6, 0.3] as ArmQ,
  offCock: [1.3, 0.15, 0, 0.4, 0] as ArmQ, offRelease: [0.5, 0.2, 0.3, 1.6, 0] as ArmQ,
  turn: [-0.7, 0.1, 0.25], twist: [-0.45, 0.35, 0.45],
  /** The pose runs this far (s) ahead of THROW's times: the arm's tracking lag, so the hand is through at the release. */
  lead: 0.09,
};

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
  private pelvisSeg: number; private thoraxSeg: number; private footSeg: number[];
  private neutral = neutralCommands();

  // locomotion state
  private phase = 0; private frozen = true;
  private heading = NaN; private omega = 0;
  private vel: Vec3 = [0, 0, 0]; private vPlan: [number, number] = [0, 0]; private aFwd = 0; private aLat = 0;
  private height: number; private pitch = 0; private roll = 0; private bend = 0; private dropF = 0.008; private dropV = 0; private pitchV = 0;
  private lv = { gait: 0, stance: 0, sink: 0, chop: 0, drive: 0, thrust: 0, tuck: 0, leanF: 0, leanS: 0, reachL: 0, reachR: 0,
    wrap: 0, hug: 0, shoot: 0, carryL: 0, carryR: 0, contact: 0, cut: 0, aimL: 0, aimR: 0, bp: 0, shuffle: 0, pullL: 0, pullR: 0, hit: 0 };
  private aimAng = [[0, 0], [0, 0]];
  /** How far ahead of each shoulder (root frame, m) cmd.aim is (last aimArm). */
  private aimFwd = [0, 0];
  /** Bear hug, per arm: the hand has come past the aim (latched for the hug), and the squeeze level. */
  private hugIn = [false, false]; private hugSq = [0, 0];
  /** Eyes on cmd.look: the thorax's and the neck's turn toward it (rad, + left), filtered. */
  private look = { thorax: 0, neck: 0 };
  /** The throwing motion's last pose (throwing arm, off arm, heading offset, thorax twist, hand) and its blend level. */
  private pass = { arm: [0, 0, 0, 0, 0] as ArmQ, off: [0, 0, 0, 0, 0] as ArmQ, turn: 0, twist: 0, hand: 1, w: 0 };
  private cutT = 0; private cutSide = 0; private cutDir: [number, number] = [0, 1]; private cutSpeed = 0; private prevCut = 0;
  private turn = 0;
  private lungeT = 0; private thrustT = 0; private prevThrust = false;
  /** The thrust's pads pitch (rad) and hip drop (m) at the press, how low it is (0..1), the shoulder it leads with. */
  private thrustP = 0; private thrustD = 0; private thrustLow = 0; private thrustSide = -1;

  // whole-body modes and cross-fades
  private mode: Mode = 'loco'; private modeT = 0; private settleT = 0; private standT = 0; private prevDive = false;
  private dv = { run: 0, vh: 0, dir: [0, 1] as [number, number], yaw: 0, f: 1, l: 0, tL: 0.2, tP: 0.2, stage: 'load' as DiveStage, vy: 0 };
  private jv = { running: false, vel: [0, 0] as [number, number], tL: 0.3, tP: 0.2, tT: 0, tF: Infinity, pushed: false, offT: 0, leg: -1, q0: [] as LegQ[], was: [true, true], stage: 'load' as DiveStage, vy: 0, power: 1 };
  private prevJump = false; private jumpCool = 0; private jumpReq = 0; private landT = Infinity;
  /** The world's jump tuning this step; a charge being held (s, −1 = none) and the strength of the jump it fired. */
  private jt: JumpTuning = JUMP_DEFAULTS; private chg = -1; private jumpPow = 1;
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
    this.pelvisSeg = seg('pelvis'); this.footSeg = [seg('footL'), seg('footR')];
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
        elbow: this.I(`elbow${sx}.flex`), wrist: this.I(`wrist${sx}.flex`), seg: seg('upperArm' + sx), hand: seg('hand' + sx) };
    });
    const dofs = (re: RegExp) => muscles.names.flatMap((n, i) => (re.test(n) ? [i] : []));
    this.armDofs = [dofs(/^(sc|shoulder|elbow|wrist)L\./), dofs(/^(sc|shoulder|elbow|wrist)R\./)];
    this.neckDofs = dofs(/^neck/);
    this.resetFeet();
  }

  /** Add `v` to a dof by name; a dof fused away at this detail level passes its share to the joint that
   *  inherited its range (thoracic → lumbar, neckUp → neckLow, sc → shoulder), so both levels look alike. */
  private add(name: string, v: number) {
    let i = this.addTo.get(name);
    if (i === undefined) this.addTo.set(name, (i = this.addIndex(name))); // looked up once per name, not every step
    if (i >= 0) this.q[i] += v;
  }
  private addTo = new Map<string, number>();
  private addIndex(name: string) {
    const i = this.I(name);
    if (i >= 0) return i;
    const [j, d] = name.split('.'), base = j.replace(/[LR]$/, ''), sx = j.slice(base.length);
    const t = FUSE_RANGE_TRANSFER[base]?.[d];
    if (!t) return -1;
    const [tj, td] = t.split('.');
    return this.I(`${tj}${sx}.${td}`);
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
  /** The root's inverse orientation for the last (pitch, roll) solve() was given, and the IK output buffer. */
  private invCache = { pp: NaN, roll: NaN, q: [0, 0, 0, 1] as Quat };
  private ik = [0, 0, 0];

  /** Leg angles that put the foot at F/yaw/toe-up g with the pelvis at the current root pose. When the leg
   *  cannot reach the flat or heel-down foot (ankle out of dorsiflexion, hip out of extension, leg too short)
   *  the heel rises and the foot rolls onto its ball instead, as in a real stance and push-off. `ok` is false
   *  when even that fails (with margin `m` for planning). With `prevG`, the heel comes back down by at most
   *  `maxStep` from it (it rises as fast as the leg needs; easing it down avoids flips between solutions). */
  private solve(L: Leg, F: [number, number], yaw: number, g: number, m = 0, prevG = NaN, maxStep = Infinity, h = this.height, pp = this.pitch - this.bend): { q: LegQ; ok: boolean } {
    // (the animator's hot loop: up to ~15 trials per call and many calls per step, so no allocation per trial; the
    // numbers are those of qrot() and legIK(), bit for bit)
    const c = this.invCache;
    if (c.pp !== pp || c.roll !== this.roll) { c.pp = pp; c.roll = this.roll; c.q = qconj(rootQuat(0, pp, this.roll)); }
    const [x, y, z, w] = c.q, ik = this.ik, ho = L.hipOff;
    const rot = clamp(-L.side * yaw, this.lo[L.rot], this.hi[L.rot]), sr = Math.sin(rot), cr = Math.cos(rot);
    const reach = (L.L1 + L.L2) * (0.99 - 0.015 * m), hfMin = this.lo[L.hf] + 0.01 + 0.05 * m, dmax = this.hi[L.dor] - 0.02;
    const r: LegQ = [0, 0, 0, 0, 0, yaw, g], fx = Math.sin(yaw), fz = Math.cos(yaw), a = this.ankleH;
    const at = (gg: number) => {
      // The rocker: the ankle point (heading frame, x left, y up from the turf, z forward) of a foot whose flat-foot
      // ankle projection is F, yawed by `yaw`, rolled toe-up by gg about the heel (gg > 0) or the ball (gg < 0);
      // then relative to the pelvis at height h, in the pelvis frame, and to the hip.
      const piv = gg >= 0 ? -this.heel : this.ball, cg = Math.cos(gg), sg = Math.sin(gg); // pivot ahead (+) or behind (−) the ankle
      const along = piv - (piv * cg + a * sg), up = -piv * sg + a * cg;
      const v0 = F[0] + fx * along, v1 = up - h, v2 = F[1] + fz * along;
      const tx = 2 * (y * v2 - z * v1), ty = 2 * (z * v0 - x * v2), tz = 2 * (x * v1 - y * v0);
      const r0 = v0 + w * tx + (y * tz - z * ty) - ho[0], r1 = v1 + w * ty + (z * tx - x * tz) - ho[1], r2 = v2 + w * tz + (x * ty - y * tx) - ho[2];
      const n = Math.hypot(r0, r1, r2);
      legIKInto(L, r0, r1, r2, n, sr, cr, ik);
      const hf = ik[0], kn = ik[2];
      r[0] = hf; r[1] = ik[1]; r[2] = kn; r[3] = gg + this.pitch - hf + kn; r[4] = Math.max(0, -gg); r[6] = gg;
      return n <= reach && hf >= hfMin && r[3] <= dmax;
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

  private legDofs(L: Leg) { return [L.hf, L.ab, L.rot, L.kn, L.knRot, L.dor, L.inv, L.toe].filter((i) => i >= 0); }

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
    // One press is one jump: it goes at the press, or with a charge (JumpTuning.charge) at the release or once full,
    // stronger the longer it was held (he stands ready meanwhile: a squat held at the bottom of the dip bounced him). It waits up to `buffer` for a foot on the turf (a press in a stride's flight
    // goes on the next foot down).
    const JT = this.jt = view.jump ?? JUMP_DEFAULTS, press = cmd.jump && !this.prevJump;
    let fire = false;
    if (press) this.chg = JT.charge > 0 ? 0 : -1;
    if (press && JT.charge <= 0) { fire = true; this.jumpPow = 1; }
    else if (this.chg >= 0) {
      this.chg += dt;
      if (!cmd.jump || this.chg >= JT.charge) { fire = true; this.jumpPow = lerp(JT.chargeMin, 1, clamp(this.chg / JT.charge, 0, 1)); this.chg = -1; }
    }
    this.jumpReq = fire && this.mode !== 'jump' ? Math.max(JT.buffer, dt) : Math.max(0, this.jumpReq - dt);
    if (support.down && (this.mode === 'loco' || this.mode === 'dive' || this.mode === 'jump')) this.enter('down', 0.15);
    // out of play (knocked out, or both legs broken; design §6.6): he goes down where he stands and stays down this
    // rep. One break he plays on with: down from the hit as physics decides, then up again like anyone.
    if (support.out && this.mode !== 'down') this.enter('down', 0.15);
    if (this.mode === 'down') {
      if (support.out) this.settleT = 0;
      else this.settleT = comSpeed < 1 ? this.settleT + dt : 0;
      // carried back up onto his feet (held up and shoved along in a pile): nothing to get up from, he plays on
      this.standT = !support.out && !support.down && s.segPos[3 * this.pelvisSeg + 1] > 0.8 * this.standH ? this.standT + dt : 0;
      if (this.standT > 0.3) this.enter('loco', 0.3);
      else if (this.settleT > 0.25) this.startGetup(view);
    } else if (this.mode === 'getup') {
      // wanting to go, he scrambles up faster and runs off once both feet are under him, still unsteady
      const going = Math.hypot(cmd.move.x, cmd.move.z) > 0.3;
      if (going) this.modeT += dt * (GETUP_HURRY - 1);
      if (comSpeed > 3) this.enter('down', 0.15);
      else if (going && this.modeT >= GETUP_GO * GETUP_T && !support.down) this.enter('loco', 0.3);
      else if (this.modeT >= GETUP_T) {
        this.getup.downT = support.down ? this.getup.downT + dt : 0;
        if (!support.down) { this.mode = 'loco'; this.modeT = 0; }
        else if (this.getup.downT > 0.6) this.startGetup(view);
      }
    } else if (this.mode === 'loco' && cmd.dive && !this.prevDive) this.startDive(view, cmd);
    // one press, one whole dive: holding the button changes nothing; it ends on the turf (down), or on the
    // feet again if it never landed
    else if (this.mode === 'dive' && this.modeT > this.dv.tL + this.dv.tP + DIVE.maxFlight) this.enter('loco', 0.3);
    // one press, one jump, from the turf (a press in a stride's flight waits for the next foot down), not again until a
    // moment after the last landing
    else if (this.mode === 'loco' && this.jumpReq > 0 && this.jumpCool <= 0 && (view.feet[0].touching || view.feet[1].touching)) this.startJump(view);
    // a jump ends when a foot finds the turf on the way down (or it never lands): he runs on from the landing
    // (or he never got off the turf: held down, or the push never came)
    else if (this.mode === 'jump' && (this.jv.stage === 'flight' ? (this.modeT > this.jv.tF + 0.1 && s.comVel[1] < 0.5 && (view.feet[0].touching || view.feet[1].touching))
      || this.modeT > this.jv.tF + JUMP.maxFlight : this.modeT > (this.jv.stage === 'load' ? this.jv.tL : this.jv.tT + this.jv.tP) + JUMP.stuck)) this.land(view);
    this.prevDive = cmd.dive; this.prevJump = cmd.jump;
    if (this.mode !== 'jump') this.jumpCool = Math.max(0, this.jumpCool - dt);

    this.q.fill(0);
    out.gain.fill(1);
    switch (this.mode) {
      case 'loco': this.loco(view, cmd, false, out); break;
      case 'dive': this.dive(view, cmd, out); break;
      case 'jump': this.jump(view, cmd, out); break;
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
    const jump = this.mode !== 'jump' || (this.jv.stage === 'load' && this.jv.running) ? 'none' : this.jv.stage;
    out.root.vel[1] = dive === 'launch' ? this.dv.vy : jump === 'launch' ? this.jv.vy : this.mode === 'loco' ? -this.dropV : 0;
    out.root.dive = dive; out.root.jump = jump; out.root.power = this.mode === 'jump' ? this.jv.power : 1;
    out.root.thrust = this.mode === 'loco' ? this.lv.thrust : 0;
    out.root.twist = this.mode === 'loco' ? -THRUST.turn * this.thrustSide * this.lv.thrust + this.pass.twist * this.pass.w + this.look.thorax : 0;
    out.root.bank = this.mode === 'loco' ? -THRUST.bank * this.thrustSide * this.thrustLow * this.lv.thrust : 0;
    out.clip = this.mode === 'loco' ? this.clip : this.mode;
  }

  private enter(mode: Mode, blend: number) {
    this.blendFrom.set(this.prevQ);
    this.blendRoot = { height: this.height, pitch: this.pitch, roll: this.roll };
    this.blendW = 0; this.blendDur = blend;
    this.mode = mode; this.modeT = 0; this.settleT = 0; this.standT = 0; this.bend = 0; this.thrustT = 0;
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
    const dt = v.dt, s = v.state, lv = this.lv;
    const vx = s.comVel[0], vz = s.comVel[2];
    // on a broken leg (design §6.6) he hobbles: slower, off the bad leg quickly and onto the good one
    const bad = v.hurt ? v.hurt.leg.indexOf(true) : -1, speed = this.plan.params.speed * (bad >= 0 ? HOBBLE.speed : 1);

    // ---- commanded velocity and heading
    const mm = Math.hypot(cmd.move.x, cmd.move.z), mag = Math.min(1, mm);
    const dir: [number, number] = mm > 1e-6 ? [cmd.move.x / mm, cmd.move.z / mm] : [0, 0];
    const gaitV = GAIT_SPEED[cmd.gait] * speed;
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
    // throwing, the body turns to the target (side-on, then square) whatever the legs do
    const th = v.throwing;
    if (th) {
      const pv = v.state.segPos, k = 3 * this.pelvisSeg;
      hT = Math.atan2(th.at[0] - pv[k], th.at[2] - pv[k + 2]) + this.passPose(th.t, th.hand);
    }
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
    tf = Math.max(tf, -BACK_MAX * speed); tl = clamp(tl, -SIDE_MAX * speed, SIDE_MAX * speed);
    let [tx, tz] = toW(tl, tf);
    // a plant-and-cut trades some speed for the new direction, once (taken at the plant: re-taken every step it
    // bled the run to a near stop over the cut)
    if (cutting) { tx = this.cutDir[0] * this.cutSpeed; tz = this.cutDir[1] * this.cutSpeed; }
    // One press, one whole hip thrust: it lunges forward along the heading, drives and rises, and holding the button
    // changes nothing. Against an opponent the legs stay planted and drive instead of lunging (stepping would leave
    // no leg to push with).
    // The press takes the pads' angle and the hips' depth it fires out from, and the shoulder it leads with (the
    // brain's near shoulder, else the forward foot's).
    if (cmd.thrustHips && !this.prevThrust && this.thrustT <= 0 && !hold) {
      this.thrustT = THRUST_T; this.lungeT = LUNGE.time; this.thrustP = Math.min(this.pitch, THRUST.pitchMax); this.thrustD = this.dropF;
      this.thrustLow = s01((this.thrustP - THRUST.upright) / (THRUST.low - THRUST.upright)); this.thrustSide = cmd.shoulder || this.leadSide();
    }
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
    lv.hit = follow(lv.hit, thrusting && v.playerContact ? 1 : 0, dt, 0.03);
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
    lv.hug = follow(lv.hug, cmd.wrap && cmd.hug ? 1 : 0, dt, 0.08);
    lv.shoot = follow(lv.shoot, cmd.shoot ? 1 : 0, dt, 0.04);
    lv.carryL = follow(lv.carryL, cmd.carry === 1 ? 1 : 0, dt, 0.15);
    lv.carryR = follow(lv.carryR, cmd.carry === 2 ? 1 : 0, dt, 0.15);
    lv.contact = follow(lv.contact, contact, dt, 0.15);
    lv.cut = follow(lv.cut, cutting ? 1 : 0, dt, 0.08);
    const P = this.pass;
    P.w = follow(P.w, th ? 1 : 0, dt, th ? 0.03 : 0.15);
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
    // thrust: hips, knees and ankles extend until the athlete is up on the balls of his feet; from lowered pads the
    // extended legs stay inclined behind the hips, so the pelvis stays lower
    drop = clamp(lerp(drop, lerp(-0.02, Math.min(THRUST.keep * this.thrustD, THRUST.dropMax), this.thrustLow), lv.thrust), -0.04, 0.4);
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
    // the trunk rises out of the sink, still leaning slightly into whatever it drives, or from lowered pads keeps
    // their angle, coming up a little through the thrust; a pull sits back into it
    const thrustPitch = lerp(Math.max(0.15, this.thrustP - THRUST.rise * (1 - this.thrustT / THRUST_T)), 0.15, THRUST.uncoil * lv.hit);
    pitchT = clamp(lerp(pitchT, thrustPitch, lv.thrust) - 0.25 * Math.max(lv.pullL, lv.pullR), -0.4, LEAN_MAX);
    // leaning in no faster than the trunk can follow (~1 s to a full lean), so the support never reads the lag
    // behind a commanded lean as being knocked over
    const prevPitch = this.pitch;
    this.pitch = Math.min(follow(this.pitch, pitchT, dt, lerp(0.08, 0.03, lv.hit)), this.pitch + LEAN_RATE * dt);
    this.pitchV = (this.pitch - prevPitch) / dt;
    // The world's support turns the pelvis through only part of a posture lean (as the balance controller does):
    // the spine flexes through the rest, and the legs are solved for that pelvis.
    // ... only near standstill: running, the pelvis pitches with the trunk (a spine-flexed lean at speed put the feet
    // in the wrong place on a cut and tripped the runner), so the share fades out from 3 to 6 m/s
    // (a low thrust's lean is the pads' angle, not a sprint start's: the spine keeps its share through the lunge)
    this.bend = follow(this.bend, PELVIS_REST * Math.max(0, pitchT - runP * (1 - lv.thrust * this.thrustLow)) * clamp((6 - vf) / 3, 0, 1), dt, 0.08);
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
      const phi = this.legPhase(L), bL = bad < 0 ? beta : L === this.legs[bad] ? beta * HOBBLE.badStance : Math.min(0.9, beta * HOBBLE.goodStance);
      if (!hold) {
        if (!L.stance && phi < L.prevPhi - 0.5) { L.stance = true; L.F = [...L.tdF]; L.yaw = L.tdYaw; L.reachOK = true; }
        // lift at the end of stance, or early when moving sideways carries the planted foot under the body
        else if (L.stance && !this.frozen && (phi >= bL || (L.side * L.F[0] < 0.03 && L.side * vl > 0.3))) this.lift(L, phi);
      }
      L.prevPhi = phi;
      const home: [number, number] = [L.side * w, zh];
      if (!L.stance || hold) {
        let tx = home[0] + vl * bL * T * 0.5, tz = home[1] + vf * bL * T * 0.5 - this.ball * run;
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
        const u = clamp(phi / bL, 0, 1);
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
          for (const i of this.legDofs(L)) out.gain[i] = g;
        }
      }
      this.writeLeg(L, q);
      // just down from a jump the legs are soft and give (a landing's knee bend), firming up as they take the weight
      if (this.landT < this.jt.recover) for (const i of this.legDofs(L)) out.gain[i] *= lerp(1 - this.jt.soft, 1, this.landT / this.jt.recover);
    }
    this.landT += dt;

    // ---- trunk, head, arms
    const ready = Math.max(lv.stance, shuffle, 0.7 * bp, 0.6 * lv.contact * (1 - run));
    // an upright thrust straightens the back; from lowered pads the back keeps their angle
    const tUp = lv.thrust * (1 - this.thrustLow);
    this.add('thoracic.flex', (0.15 * lv.wrap + 0.1 * lv.stance) * (1 - tUp) + 0.4 * this.bend);
    this.add('lumbar.flex', 0.1 * lv.sink - 0.2 * tUp + 0.6 * this.bend);
    this.head(-0.9 * this.pitch + 0.35 * lv.tuck - THRUST.neck * lv.thrust);
    // near-shoulder strike: +rotL turns the trunk left (right shoulder forward), +latL bends the head left
    const ts = this.thrustSide * lv.thrust;
    this.add('thoracic.rotL', -THRUST.turn * ts); this.add('neckLow.rotL', 0.6 * THRUST.turn * ts); this.add('neckUp.rotL', 0.4 * THRUST.turn * ts);
    this.add('neckLow.latL', -THRUST.neckLat * ts); this.add('thoracic.latL', -0.6 * THRUST.bank * this.thrustLow * ts); this.add('lumbar.latL', -0.4 * THRUST.bank * this.thrustLow * ts);
    // the throw's shoulder turn, the head held toward the target against it and the hips' turn (as far as the neck goes)
    const look = -(P.twist + P.turn) * P.w;
    this.add('thoracic.rotL', P.twist * P.w); this.add('neckLow.rotL', 0.6 * look); this.add('neckUp.rotL', 0.4 * look);
    // eyes on a point (a ball in the air): the trunk turns up to its rotation range, the neck the rest of the way
    const L = this.look, hp = v.state.segPos, hk = 3 * this.pelvisSeg;
    const bear = cmd.look ? wrapAngle(Math.atan2(cmd.look[0] - hp[hk], cmd.look[2] - hp[hk + 2]) - this.heading) : 0;
    const tor = clamp(bear, -LOOK.thorax, LOOK.thorax);
    L.thorax = follow(L.thorax, tor, dt, LOOK.tau); L.neck = follow(L.neck, clamp(bear - tor, -LOOK.neck, LOOK.neck), dt, LOOK.tau);
    this.add('thoracic.rotL', L.thorax); this.add('neckLow.rotL', 0.45 * L.neck); this.add('neckUp.rotL', 0.55 * L.neck);
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
      // thrust: the arms cock back, elbows in and hands by the hips (ready to rip up through), so the pads lead; arms
      // wrapped around an opponent lift him instead (elbows stay bent). Hands at the chest still met him before the pads.
      fl = lerp(fl, lerp(-0.8, 1.4, lv.wrap), lv.thrust); ab = lerp(ab, lerp(0.15, 0.2, lv.wrap), lv.thrust); rt = lerp(rt, lerp(0.3, rt, lv.wrap), lv.thrust); el = lerp(el, lerp(1.3, 1.2, lv.wrap), lv.thrust);
      const k = arm.side > 0 ? 0 : 1, aimW = this.aimArm(v, cmd, arm, k, dt);
      fl = lerp(fl, this.aimAng[k][0], aimW); ab = lerp(ab, this.aimAng[k][1], aimW); el = lerp(el, 0.2, aimW);
      if (lv.hug > 1e-3) {
        // reach out wide past him first (the squeeze waits on the hand), so the hands go round him, never into his chest
        this.hugSq[k] = follow(this.hugSq[k], this.hugIn[k] ? 1 : 0, dt, 0.1);
        const H = HUG, sq = clamp((H.open - this.aimFwd[k]) / (H.open - H.close), 0, 1) * this.hugSq[k];
        fl = lerp(fl, this.aimAng[k][0] - H.drop * sq, lv.hug); ab = lerp(ab, this.aimAng[k][1] + H.wide * sq, lv.hug);
        rt = lerp(rt, lerp(H.rt[0], H.rt[1], sq), lv.hug); el = lerp(el, lerp(H.el[0], H.el[1], sq), lv.hug);
      }
      // pull: shoulder extension and a hard elbow bend, the hand drawn back to the ribs
      const pull = k === 0 ? lv.pullL : lv.pullR;
      fl = lerp(fl, 0.3, pull); ab = lerp(ab, 0.2, pull); rt = lerp(rt, 0.3, pull); el = lerp(el, 2.0, pull);
      if (P.w > 1e-3) {
        const t = k === P.hand ? P.arm : P.off;
        fl = lerp(fl, t[0], P.w); ab = lerp(ab, t[1], P.w); rt = lerp(rt, t[2], P.w); el = lerp(el, t[3], P.w); wr = lerp(wr, t[4], P.w);
      }
      this.setArm(arm, fl, ab, rt, el, wr);
      // a thrust rolls the shoulders forward (scapular protraction to its end), so the pads are what meets the opponent
      this.add(`sc${arm.side > 0 ? 'L' : 'R'}.protr`, Math.max(0.15 * Math.max(lv.wrap, lv.shoot, reach), 0.3 * Math.max(lv.thrust, lv.hug)));
      // a pulling arm is held loosely: the row itself is the tracking controller's pull, sized to what the fist holds,
      // and a stiff arm still swinging to its reach pose would tear the fresh grip open
      const g = Math.max(P.w, lerp(lerp(0.5, 1, clamp(Math.max(lv.contact, carry, reach, lv.wrap, lv.shoot, lv.thrust, aimW), 0, 1)), 0.3, pull));
      for (const i of this.armDofs[k]) out.gain[i] = g;
    }
    for (const i of this.neckDofs) out.gain[i] = 0.8;

    // ---- frame
    out.root.height = this.height; out.root.pitch = this.pitch; out.root.roll = this.roll;
    out.planted[0] = this.legs[0].stance; out.planted[1] = this.legs[1].stance;
    out.phase = this.phase - Math.floor(this.phase);
    this.clip = lv.cut > 0.5 ? 'cut' : lv.stance > 0.5 ? 'stance' : lv.chop > 0.5 ? 'chop' : lv.drive > 0.5 ? 'drive'
      : gl < 0.5 ? 'idle' : bp > 0.5 ? 'backpedal' : shuffle > 0.5 ? 'shuffle' : bad >= 0 ? 'hobble' : sp < 2.2 ? 'walk' : 'run';
  }

  /** The throwing motion at t s into it (PASS), thrown with `hand` (0 left, 1 right): sets the arms' and thorax's
   *  pose and returns the heading's offset from the target (rad). */
  private passPose(t: number, hand: 0 | 1): number {
    const P = this.pass, T = THROW, sg = hand === 1 ? 1 : -1;
    t += PASS.lead;
    // 0: cocked, 1: released, 2: followed through
    const x = t < T.cock ? 0 : t < T.release ? minJerk((t - T.cock) / (T.release - T.cock)) : 1 + s01((t - T.release) / (T.end - T.release));
    const seg = <V extends readonly number[]>(a: V, b: V, c: V) => a.map((v, i) => (x < 1 ? lerp(v, b[i], x) : lerp(b[i], c[i], x - 1)));
    P.arm = seg(PASS.cock, PASS.release, PASS.follow) as ArmQ;
    P.off = seg(PASS.offCock, PASS.offRelease, PASS.offRelease) as ArmQ;
    const ramp = (a: number[]) => (x < 1 ? lerp(a[0], a[1], x) : lerp(a[1], a[2], x - 1));
    P.twist = sg * ramp(PASS.twist); P.turn = sg * ramp(PASS.turn); P.hand = hand;
    return P.turn;
  }

  /** Side (1 left, −1 right) of the foot farther forward, planted or about to land; the right on a tie. */
  private leadSide() {
    const [l, r] = this.legs.map((L) => (L.stance ? L.F[1] : L.tdF[1]));
    return l > r + 0.02 ? 1 : -1;
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
    const aim = (reaching && !cmd.hug && v.reachTo?.[k]) || cmd.aim;
    lv[key] = follow(lv[key], aim ? (reaching ? (k === 0 ? cmd.armL : cmd.armR) : 1) : 0, dt, 0.1);
    if (aim && arm.seg >= 0) {
      const sp = v.state.segPos, d: Vec3 = [aim[0] - sp[3 * arm.seg], aim[1] - sp[3 * arm.seg + 1], aim[2] - sp[3 * arm.seg + 2]];
      const iq = qconj(rootQuat(this.heading, this.pitch, this.roll)), r = qrot(iq, d), H = HUG;
      // a hug reaches round his side to his back (frontAim never sees a target behind me then: he is in front)
      const p = cmd.hug ? [r[0] + arm.side * H.side, r[1], r[2] + H.past] : frontAim(r, arm.side), n = Math.hypot(p[0], p[1], p[2]) || 1;
      const ab = Math.asin(clamp(arm.side * p[0] / n, -1, 1)), fl = Math.atan2(p[2], -p[1]);
      this.aimFwd[k] = r[2];
      const h = 3 * arm.hand;
      if (!cmd.hug) this.hugIn[k] = false;
      else if (arm.hand >= 0 && qrot(iq, [sp[h] - aim[0], sp[h + 1] - aim[1], sp[h + 2] - aim[2]])[2] > 0) this.hugIn[k] = true;
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
    // shuffling (diveFacing) he keeps facing `face`; f, l: the dive's way ahead / to the left of that facing
    const face = cmd.diveFacing && cmd.face ? Math.atan2(cmd.face.x, cmd.face.z) : null;
    const yaw = face ?? Math.atan2(dir[0], dir[1]);
    const f = face === null ? 1 : dir[0] * Math.sin(yaw) + dir[1] * Math.cos(yaw), l = face === null ? 0 : dir[0] * Math.cos(yaw) - dir[1] * Math.sin(yaw);
    this.dv = { run, vh, dir, yaw, f, l, tL: lerp(DIVE.load[0], DIVE.load[1], run), tP: lerp(DIVE.push[0], DIVE.push[1], run), stage: 'load', vy: 0 };
    this.enter('dive', 0.8 * this.dv.tL);
  }

  /** Dive: load (hips, knees and ankles flex, arms swing back), launch (all three extend hard, arms punch
   *  forward), flight (arms reaching out, legs trailing) until the body lands on the turf (down). */
  private dive(v: BodyView, cmd: Commands, out: AnimFrame) {
    const D = this.dv, t = this.modeT, dt = v.dt, s = v.state;
    const uL = minJerk(t / D.tL), wP = minJerk((t - D.tL) / D.tP), wF = minJerk((t - D.tL - D.tP) / 0.15);
    D.stage = t < D.tL ? 'load' : t < D.tL + D.tP ? 'launch' : 'flight';
    // the body turns to face the way it dives while it loads and pushes
    if (D.stage !== 'flight') this.heading = wrapAngle(this.heading + clamp(wrapAngle(D.yaw - this.heading), -TURN_RATE * dt, TURN_RATE * dt));
    const sd = lerp(1, 0.55, D.run), hLoad = this.standH - 0.16 * sd, pLoad = lerp(0.3, 0.45, D.run);
    // the push is forward first, then up: rising early would lift the feet off the turf before the speed is there
    D.vy = lerp(DIVE.vy[0], DIVE.vy[1], D.run) * wP;
    if (D.stage === 'load') {
      this.pitch = lerp(this.blendRoot.pitch, D.f * pLoad, uL);
      this.height = lerp(this.blendRoot.height, hLoad, uL);
      // the run's speed is kept through the load (the feet gather under the hips, they do not brake)
      this.vel[0] = D.dir[0] * D.vh; this.vel[2] = D.dir[1] * D.vh;
    } else if (D.stage === 'launch') {
      this.pitch = lerp(D.f * pLoad, D.f * 1.0, wP);
      this.height = lerp(hLoad, this.standH + 0.03, wP);
      const vh = Math.max(D.vh, DIVE.vStand);
      this.vel[0] = D.dir[0] * vh; this.vel[2] = D.dir[1] * vh;
    } else {
      this.pitch = follow(this.pitch, D.f * 1.3, dt, 0.1);
      this.height = follow(this.height, s.segPos[3 * this.pelvisSeg + 1], dt, 0.05);
      this.vel[0] = s.comVel[0]; this.vel[2] = s.comVel[2];
    }
    // the trunk tips the way he dives: forward (pitch), back (negative pitch) or to a side (roll)
    this.roll = follow(this.roll, D.l * (D.stage === 'flight' ? 1.3 : D.stage === 'launch' ? wP : 0), dt, 0.1);
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
    const up = 2.0 + 0.9 * Math.max(0, -D.f), fl = lerp(lerp(-0.6 * sd, up, wP), up, wF), el = lerp(0.4, 0.15, wP);
    // reaching out of the launch, the arms go where the hands aim (a ball he lays out for)
    for (const a of this.arms) {
      const k = a.side > 0 ? 0 : 1, w = this.aimArm(v, cmd, a, k, dt) * wP;
      this.setArm(a, lerp(fl, this.aimAng[k][0], w), lerp(lerp(0.15, 0.25, wF), this.aimAng[k][1], w), 0, lerp(el, 0.2, w), 0);
    }
    this.add('lumbar.flex', lerp(0.15 * (1 - wP), -0.15, wF));
    // (diving backward: arms up behind the head, chin tucked)
    this.head(D.f < 0 ? 0.5 * wP : -0.3 - 0.4 * wP + 0.3 * (cmd.headTuck ? 1 : 0));
    out.root.height = this.height; out.root.pitch = this.pitch; out.root.roll = this.roll;
    // the feet push against the turf until take-off
    out.planted[0] = D.stage !== 'flight' && v.feet[0].touching; out.planted[1] = D.stage !== 'flight' && v.feet[1].touching;
    out.phase = clamp(t / (D.tL + D.tP), 0, 1);
  }

  /** Foot k's ankle relative to the pelvis in the heading frame (x left, z forward), as the leg IK takes a foothold. */
  private footAt(v: BodyView, k: number): [number, number] {
    const p = v.state.segPos, a = 3 * this.footSeg[k], b = 3 * this.pelvisSeg, sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    const x = p[a] - p[b], z = p[a + 2] - p[b + 2];
    return [x * ch - z * sh, x * sh + z * ch];
  }

  private startJump(v: BodyView) {
    const c = v.state.comVel, running = Math.hypot(c[0], c[2]) > RUN_TAKEOFF.from, JT = this.jt, kv = running ? JT.carry : 1;
    // From a run he jumps on along it (a hurdle), keeping `carry` of its speed; standing he goes up. A running take-off
    // is off a fresh plant: a foot on the turf still under or ahead of the hips now, else the next foot down.
    const fresh = (k: number) => running && v.feet[k].touching && this.footAt(v, k)[1] > -JUMP.fresh;
    this.jv = { running, vel: [c[0] * kv, c[2] * kv], tL: running ? 0 : JT.load, tP: running ? RUN_TAKEOFF.stance : JT.push, tT: running ? Infinity : JT.load, tF: Infinity, pushed: false, offT: 0, leg: -1, q0: [],
      was: [v.feet[0].touching && !fresh(0), v.feet[1].touching && !fresh(1)], stage: 'load', vy: 0, power: this.jumpPow };
    this.enter('jump', running ? 0.05 : 0.6 * JT.load); this.jumpReq = 0;
  }

  /** Landed on his feet: locomotion again, carrying on at the speed he lands with. The hips keep falling at the landing
   *  speed and the legs give, stopping them at the locomotion's ~2.5 g (its sink limit), then rise again. */
  private land(v: BodyView) {
    const c = v.state.comVel, pel = v.state.segPos[3 * this.pelvisSeg + 1];
    this.height = pel; // the cross-fade starts from where the hips really are
    this.enter('loco', 0.15);
    this.vel = [c[0], 0, c[2]]; this.vPlan = [c[0], c[2]];
    this.dropF = this.standH - pel; this.dropV = Math.max(0, -c[1]);
    this.jumpCool = this.jt.cooldown; this.landT = 0;
  }

  /** Jump: counter-movement (hips, knees and ankles flex, arms swing back), take-off (all three extend onto the toes,
   *  arms swing up, or to where the hands aim), flight (legs tuck, then reach down for the landing). From a run the
   *  take-off is one stance's: the stride runs on until a fresh foot is down, and that leg pushes. */
  private jump(v: BodyView, cmd: Commands, out: AnimFrame) {
    const J = this.jv, JT = this.jt, t = this.modeT, dt = v.dt, s = v.state, touch = v.feet[0].touching || v.feet[1].touching;
    if (J.stage === 'load') {
      const down = [0, 1].find((k) => v.feet[k].touching && !J.was[k]) ?? -1;
      J.was = [v.feet[0].touching, v.feet[1].touching];
      if (t >= J.tL && (!J.running || down >= 0)) {
        J.stage = 'launch'; J.leg = down; J.tT = t; J.q0 = this.legs.map((L) => [...L.q] as LegQ); J.power = this.jumpPow * (J.running ? JT.runHeight : JT.height);
      }
    }
    // the flight starts when both feet have left the turf after the push (for a moment: a rigid foot's contact flickers
    // under load): at the end of its schedule, or sooner once a foot has pushed him up off it (from a run, once the
    // planted foot has come off)
    if (J.stage === 'launch') {
      J.pushed ||= touch;
      J.offT = touch ? 0 : J.offT + dt;
      if (J.offT >= JUMP.off && (t >= J.tT + J.tP || (J.pushed && !J.running && s.comVel[1] > 1))) {
        J.stage = 'flight'; J.tF = t;
        // off a running stride the flight pose fades in from the stride's
        if (J.running) { this.blendFrom.set(this.prevQ); this.blendRoot = { height: this.height, pitch: this.pitch, roll: this.roll }; this.blendW = 0; this.blendDur = 0.05; }
      }
    }
    const uL = J.tL > 0 ? 1 - (1 - clamp(t / J.tL, 0, 1)) ** 2 : 1, wP = minJerk((t - J.tT) / J.tP), wF = minJerk((t - J.tF) / (J.running ? 0.08 : 0.15));
    J.vy = J.stage === 'launch' ? JUMP.vy * Math.sqrt(Math.max(0.25, J.power)) : 0;
    if (J.running && J.stage !== 'flight') {
      if (J.stage === 'load') { this.loco(v, cmd, false, out); return; }
      // the take-off: that leg extends (hip, knee and ankle) as it sweeps back under the body, the other knee drives up
      this.legs.forEach((L, k) => { this.writeLeg(L, J.q0[k].map((c, i) => lerp(c, (k === J.leg ? JUMP_PUSH_LEG : JUMP_LEAD_LEG)[i], wP)) as LegQ); L.stance = false; });      this.height = s.segPos[3 * this.pelvisSeg + 1]; this.pitch = follow(this.pitch, 0.15, dt, 0.1); this.roll = follow(this.roll, 0, dt, 0.1);
      this.vel[0] = J.vel[0]; this.vel[2] = J.vel[1];
      for (const a of this.arms) {
        const k = a.side > 0 ? 0 : 1, wa = this.aimArm(v, cmd, a, k, dt);
        this.setArm(a, lerp(JT.arms * lerp(0.3, 2.4, wP), this.aimAng[k][0], wa), lerp(0.15, this.aimAng[k][1], wa), 0, lerp(0.6, 0.2, Math.max(wP, wa)), 0);
      }
      this.head(-0.9 * this.pitch);
      out.root.height = this.height; out.root.pitch = this.pitch; out.root.roll = this.roll;
      out.planted[0] = J.leg === 0 && v.feet[0].touching; out.planted[1] = J.leg === 1 && v.feet[1].touching;
      out.phase = wP;
      return;
    }
    const hLoad = this.standH - JT.dip, pLoad = Math.min(0.35, 0.1 + JT.dip);
    if (J.stage === 'load') {
      this.pitch = lerp(this.blendRoot.pitch, pLoad, uL);
      this.height = lerp(this.blendRoot.height, hLoad, uL);
    } else if (J.stage === 'launch') {
      this.pitch = lerp(pLoad, 0.05, wP);
      this.height = lerp(hLoad, this.standH + 0.06, wP);
    } else {
      this.pitch = follow(this.pitch, 0.05, dt, 0.1);
      this.height = follow(this.height, s.segPos[3 * this.pelvisSeg + 1], dt, 0.05);
    }
    if (J.stage !== 'flight') { this.vel[0] = J.vel[0]; this.vel[2] = J.vel[1]; }
    else {
      // in the air the root follows the body (no carry), or with air control (JumpTuning.air) the move direction
      const mm = Math.hypot(cmd.move.x, cmd.move.z), vs = GAIT_SPEED[cmd.gait] * this.plan.params.speed * Math.min(1, mm) / Math.max(mm, 1e-9);
      if (JT.air > 0 && mm > 0.05) { this.vel[0] = cmd.move.x * vs; this.vel[2] = cmd.move.z * vs; } else { this.vel[0] = s.comVel[0]; this.vel[2] = s.comVel[2]; }
    }
    this.roll = follow(this.roll, 0, dt, 0.1);
    // Load and push as the dive's: legs solved for about the real pelvis (feet under the hips, so they give under the
    // body and stay on the turf), then hips, knees and ankles extend onto the toes. In the air the knees come up (a
    // hurdle's heels right up), then reach down for the turf as he falls, toes first and soft, so the ankles and knees
    // give (landing flat-footed on stiff legs, the turf stopped the fall in a step at ~20 body weights; on the toes ~4).
    const h = this.height, p = this.pitch, fw = this.segAxis(v, this.pelvisSeg, [0, 0, 1]);
    // (in the push, for hips a little higher than they are, so the legs extend ahead of the rising body and drive)
    this.height = Math.min(Math.max(h, s.segPos[3 * this.pelvisSeg + 1] + (J.stage === 'launch' ? JUMP.ext : -0.01)), this.standH);
    this.pitch = Math.atan2(-fw[1], Math.hypot(fw[0], fw[2]));
    const E: LegQ = [-0.05, 0.05, 0.05, -0.7, 0.3, 0, 0], Ld: LegQ = [0.35, 0.08, 0.5, -0.5, 0, 0, 0];
    const T = (J.running ? JUMP_HURDLE : JUMP_TUCK).map((x, i) => (i === 0 || i === 2 ? x * JT.tuck : x)) as LegQ;
    const wD = J.stage === 'flight' ? s01(-s.comVel[1] / 2) : 0;
    for (const L of this.legs) {
      const C = this.solve(L, [L.side * 0.12, 0], L.side * 0.08, 0).q;
      this.writeLeg(L, C.map((c, i) => lerp(lerp(lerp(c, E[i], wP), T[i], wF), Ld[i], wD)) as LegQ);
      L.stance = false;
      for (const i of this.legDofs(L)) out.gain[i] = lerp(1, 1 - JT.soft, wD);
    }
    this.height = h; this.pitch = p;
    const fl = JT.arms * lerp(lerp(-0.5 * uL, 2.6, wP), 2.2, wF);
    for (const a of this.arms) {
      const k = a.side > 0 ? 0 : 1, w = this.aimArm(v, cmd, a, k, dt) * wP;
      this.setArm(a, lerp(fl, this.aimAng[k][0], w), lerp(0.15, this.aimAng[k][1], w), 0, lerp(0.3, 0.2, w), 0);
    }
    this.add('lumbar.flex', 0.2 * uL * (1 - wP));
    this.head(-0.9 * this.pitch);
    out.root.height = this.height; out.root.pitch = this.pitch; out.root.roll = this.roll;
    out.planted[0] = J.stage !== 'flight' && v.feet[0].touching; out.planted[1] = J.stage !== 'flight' && v.feet[1].touching;
    out.phase = clamp(t / (J.tL + J.tP), 0, 1);
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
