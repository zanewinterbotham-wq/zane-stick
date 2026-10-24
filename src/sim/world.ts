// The simulation loop: brains → commands → motor controller → muscles → physics, at a fixed timestep.
// Runs unchanged in the browser, a Worker, or Node. No DOM, no wall clock, no Math.random.
import { buildBody, totalMass, type AthleteParams, type BodyPlan, type Detail } from './anatomy/body';
import { BALL, GRIP_TIMECONST, EQUIPMENT } from './anatomy/equipment';
import type { Brain, Perception, AthleteView } from './brains/types';
import { neutralCommands, type BodyView, type Commands, type FootContact, type MotorController, type PassCmd } from './control/types';
import { clamp, G, headingOf, lerp, qaxis, qconj, qlog, qmul, qrot, quatAt, sub, vecAt, type Quat, type Vec3 } from './math';
import { MuscleSet, newTargets, type MuscleTargets } from './muscles';
import type { AthleteState, LinkRef, PhysicsEngine, PhysicsScene, PropDesc, SolverOptions } from './physics/engine';
import { Rng } from './rng';
import { boneTuning, InjuryState, koTuning, type BoneTuning, type InjuryEvent, type KoTuning } from './injury';
import { grabTuning, type GrabTuning } from './grab';
import { hitTuning, type HitTuning } from './hits';
import { weightSupport, type SupportSettings, type SupportState } from './anim/types';
import { rootQuat } from './anim/kinematics';
import { jumpTuning, RUN_TAKEOFF, type JumpTuning } from './anim/jump';
import { fumbleTuning, type FumbleTuning } from './fumble';
import { THROW, throwError, throwVelocity, type PassRecord } from './throw';

/** Physics precision of a scene (a quality preset's, set only between reps). The solver options and `lod` are the
 *  low presets' approximations; absent, the scene is exactly as it always was. */
export interface PhysicsSettings extends SolverOptions { hz: number; iterations: number; detail: Detail;
  /** Athlete level of detail (low presets only): an athlete farther than this (m) from the ball and from every
   *  opponent re-plans his motor targets every other step (his muscles still act on his simulated body every step,
   *  from his own Commands). Absent = every athlete plans every step. */
  lod?: number }
export interface AthleteSetup {
  params: AthleteParams;
  pos: Vec3; yaw: number;
  team: 0 | 1;
  controller: (plan: BodyPlan, muscles: MuscleSet) => MotorController;
  brain: Brain;
  hasBall?: boolean;
  /** Bot difficulty (owner decision 2026-10-18): multiplies this athlete's support thresholds (big hit, stun,
   *  held knock, tilt fade), so a tougher bot takes more force to tackle. 1 / absent = the player's. */
  toughness?: number;
  /** Bone strength (owner item 2026-10-18): multiplies this athlete's break tolerances (lower breaks more easily);
   *  1 / absent = the measured tolerances (injury.ts BREAK). */
  boneStrength?: number;
  /** A player (human, local or remote) drives this athlete: the athlete level of detail never applies to him. */
  player?: boolean;
}
export interface FieldInfo { halfWidth: number; goalZ: number; dirZ: 1 | -1 }
export interface WorldSetup { physics: PhysicsSettings; athletes: AthleteSetup[]; props?: PropDesc[]; seed: number; assist: number; field?: FieldInfo; traction?: number;
  /** Active-ragdoll support (design §6.5) for athletes whose controller has root(); absent = balance assist only. */
  support?: SupportSettings;
  /** Arcade hit power (owner decision 2026-10-18): 1 / absent = pure physics; above 1 the athlete a hit drives back
   *  gets (hitPower − 1) × the contact force he receives on top (World.applyHitPower). */
  hitPower?: number;
  /** Jump tuning (owner request 2026-10-19), the same for every athlete; absent / {} = JUMP_DEFAULTS. */
  jump?: Partial<JumpTuning>;
  /** Fumble tuning (fumble.ts): the ball grip's strength and jolt window; absent / {} = FUMBLE_DEFAULTS. */
  fumble?: Partial<FumbleTuning>;
  /** Grabbing, hits & support, bone and knockout tuning (grab.ts, hits.ts, injury.ts); absent / {} = their defaults. */
  grab?: Partial<GrabTuning>; contact?: Partial<HitTuning>; bones?: Partial<BoneTuning>; knockout?: Partial<KoTuning> }

/** Balance assist timing [design §6.4]. */
const ASSIST_FADE_OUT = 0.15, ASSIST_STABLE_TIME = 0.3, ASSIST_FADE_IN = 0.3;
/** Held knock: grip time before it starts (s), further time to full (s), the share one arm takes, and after that
 *  the time over which a two-arm hold drains muscle tone, up to sagMax. */
const HELD = { sag: 1.0, sagMax: 0.8 }; // start, full, oneArm: GrabTuning holdStart, holdFull, oneArm
/** Support [design §6.5]: carry velocity gain (1/s), stable footing before the carry returns and its ramp (s),
 *  window for the impulse received (s), flight a stride may have before the carry fades (s), how fast knock
 *  decays (1/s), get-up ramp (s), pelvis height PD (1/s², 1/s), upright stiffness (m·g·h per rad), damping
 *  (m·h² per s), yaw relative to roll/pitch, the stun: knock impulse (in bigHits) where it starts and the
 *  further amount that makes it full, and its fade time (s); speed along the last big hit beyond the wanted one
 *  where the knock starts and where it is full (m/s), and how long that hit is remembered (s); and a dive
 *  take-off's velocity gain (1/s) and largest acceleration (m/s², about the ~1.5 g net a standing long-jump
 *  take-off reaches; a jump's from a stand, ~1.7 g, about the net a counter-movement jump's ~2.5–3 body-weight
 *  propulsive peak gives, and off a running stride (from 2.5 to 3.5 m/s), ~4 g, a one-foot take-off's ~4–5 body
 *  weights [S4]), and the largest horizontal acceleration of a hip-thrust lunge (m/s², ~1 body weight of horizontal
 *  ground force, a sprint start's); the knock's rise time (s), a big hit's (about two steps at 240 Hz); and
 *  how long after the last contact a tilt or a flight stops counting as a knock (s), and the largest downward brake
 *  on a body rising past its pelvis target (× body weight), and the largest sideways acceleration the carry gives
 *  to turn a run at up to 4 m/s and from 8 m/s (m/s², the animator's LAT_ACCEL). */
const SUP = { kv: 6, stable: 0.1, fadeIn: 0.15, window: 0.2, flight: 0.15, decay: 1, getup: 1, hKp: 36, hKd: 10, kUp: 1.5, cUp: 6, yaw: 0.3,
  stunStart: 1, stunFull: 2, stunTime: 0.5, drivenStart: 0.5, drivenFull: 2, drivenTime: 1.5, launchKv: 20, launch: 15, jump: [17, 40] as const, lunge: 12, rise: 0.02, bigRise: 0.008,
  free: 1, brake: 0.5, goKnock: 0.5, lat: [14, 8.5] as const };

/** One body-part-on-body-part contact between two athletes this step (summed over its contact points). */
export interface HitEvent {
  a: number; segA: string; b: number; segB: string;
  force: number;   // total normal force, N
  pos: Vec3;       // force-weighted contact point
  speed: number;   // closing speed of the two segments along the contact normal, m/s (≥ 0)
}

export interface ImpactStats { closingSpeed: number; peakForce: number; peakHeadG: number[]; firstContactTime: number }

export class Athlete {
  readonly targets: MuscleTargets;
  cmd: Commands = neutralCommands();
  feet: [FootContact, FootContact] = [{ force: 0, cop: [0, 0, 0], touching: false }, { force: 0, cop: [0, 0, 0], touching: false }];
  playerContact = false;
  /** Non-hand, non-foot segment touching the ground (name) or null. */
  downBy: string | null = null;
  assistLevel = 1;          // 0..1 multiplier on the world assist setting (fade state)
  stableTimer = 0;
  playerContactNow = false;
  /** Athletes this one touches (last contact read). */
  touching: number[] = [];
  /** A trunk segment (thorax, lumbar, pelvis) touches an opponent (last contact read): a hug's hands close then. */
  trunkTouch = false;
  grips: { active: boolean; force: number; cooldown: number; jersey: boolean; limit: number; target: LinkRef | null }[] = [0, 1].map(() => ({ active: false, force: 0, cooldown: 0, jersey: false, limit: 0, target: null }));
  /** Last contact per hand: target link and point, for grip forming. */
  handTouch: ({ athlete: number; seg: number; pos: Vec3 } | null)[] = [null, null];
  /** Per hand: the hand geom's segment, its centre in that segment's frame and its half thickness (m). */
  readonly handGeoms: { seg: number; off: Vec3; half: number }[];
  readonly shoulderSegs: number[];
  /** Per hand, this step: where a raised arm reaches for (a little inside the opponent's body nearest its
   *  shoulder, when within GrabTuning.aim of it), or null. */
  reachTo: (Vec3 | null)[] = [null, null];
  readonly segIndex: Map<string, number>;
  /** Pelvis, thorax (the fused trunk at minimum detail) and head segments, and the body's mass (kg). */
  readonly pelvisSeg: number; readonly trunkSeg: number; readonly headSeg: number; readonly mass: number;
  readonly footSegs: Set<number>[];
  readonly handSegs: number[];
  readonly limbEndSegs: Set<number>;
  headVelPrev: Vec3 = [0, 0, 0]; headAccFilt = 0;
  /** Support levels handed to the controller, and the fade state behind them (design §6.5). */
  support: SupportState = { posture: 1, carry: 1, down: false };
  knock = 0; carryLevel = 1; supStable = 0; airT = 0; getup = 0;
  /** Share of the time a foot is on the turf (low-passed): sizes the posture support's push through the feet. */
  grounded = 1;
  /** Time since this athlete last touched another (s): the support's own-movement test and the injury break window. */
  freeT = Infinity;
  /** How long opponents have held this athlete (s), for the held knock. */
  heldT = 0;
  /** 0..1 loss of muscle tone after being driven back by a big hit (handed to controllers that take it). */
  stun = 0;
  /** Horizontal direction (x, z) of the last big hit received, the speed along it before that hit (m/s), and
   *  how recent it is (1 → 0). */
  hitDir: [number, number] = [0, 0]; hitPre = 0; hitMem = 0;
  /** Contact force received from other athletes this step (N, world), and its last SUP.window seconds (N·s). */
  hitForce: Vec3 = [0, 0, 0];
  /** The part of hitForce from opponents: only a hit is boosted by hit power, not a bump into a team mate. */
  hitOpp: Vec3 = [0, 0, 0];
  /** Ring buffer of the window's impulses (3 numbers per step; hitHead = oldest, hitCount filled), and their sum. */
  hitWindow = new Float64Array(0); hitHead = 0; hitCount = 0; hitImpulse: Vec3 = [0, 0, 0];
  /** Carry force applied this step (N, world): tests check it is zero during player contact. */
  carryForce: Vec3 = [0, 0, 0];
  /** Broken joints and knockout (design §6.6); set by World.create. */
  injury!: InjuryState;
  /** World step of the last motor plan (athlete level of detail). */
  planned = -1;
  /** The throw being played (World.throwStep): time into the motion (s), the pass, the throwing hand, released yet. */
  throwing: { t: number; cmd: PassCmd; hand: 0 | 1; released: boolean; from: Vec3 } | null = null;

  /** `muscles` is the set the controller was built with: one per athlete, so both see the same limits. */
  constructor(readonly index: number, readonly setup: AthleteSetup, readonly plan: BodyPlan, readonly muscles: MuscleSet, readonly controller: MotorController, readonly brain: Brain) {
    this.targets = newTargets(this.muscles.n);
    this.segIndex = new Map(plan.segments.map((s, i) => [s.name, i]));
    const idx = (n: string) => this.segIndex.get(n) ?? -1;
    this.pelvisSeg = idx('pelvis'); this.trunkSeg = idx('thorax') >= 0 ? idx('thorax') : idx('trunk'); this.headSeg = idx('head');
    this.mass = totalMass(plan);
    this.footSegs = ['L', 'R'].map((sx) => new Set([idx('foot' + sx), idx('toes' + sx)].filter((i) => i >= 0)));
    this.handSegs = ['L', 'R'].map((sx) => (idx('hand' + sx) >= 0 ? idx('hand' + sx) : idx('forearm' + sx)));
    this.limbEndSegs = new Set([...this.footSegs[0], ...this.footSegs[1], ...this.handSegs]);
    this.shoulderSegs = ['L', 'R'].map((sx) => idx('upperArm' + sx));
    this.handGeoms = this.handSegs.map((k) => {
      const sg = plan.segments[k], g = sg.geoms.find((x) => x.role === 'hand');
      return g?.pos ? { seg: k, off: [g.pos[0] - sg.origin[0], g.pos[1] - sg.origin[1], g.pos[2] - sg.origin[2]] as Vec3, half: Math.min(...g.size) } : { seg: k, off: [0, 0, 0] as Vec3, half: 0 };
    });
  }
}

export class World {
  readonly athletes: Athlete[] = [];
  readonly rng: Rng;
  time = 0; steps = 0;
  assist: number;           // 0..1 world setting
  impact: ImpactStats = { closingSpeed: 0, peakForce: 0, peakHeadG: [], firstContactTime: -1 };
  private forceWindow = new Float64Array(0); private forceHead = 0; private forceCount = 0;
  /** Reused each step; its key is numeric, so no string per contact. */
  private readonly pairBuf = new Map<number, HitEvent & { n: Vec3 }>();
  /** Total inter-athlete contact normal force last step (N) — drives camera shake, rumble, sound. */
  lastHitForce = 0;
  /** Athlete-on-athlete contacts this step, one per segment pair (sound, feel, replays). */
  hits: HitEvent[] = [];
  /** Every break and knockout this rep, in order (sound, effects, HUD). */
  readonly injuries: InjuryEvent[] = [];
  ballCarrier = -1;
  /** Index of the ball among the props (a prop named 'ball'), or −1. */
  readonly ballIndex: number;
  /** Passing (docs/passing.md): the rules' say on a pass command from athlete i (Play sets it; absent: any holder may
   *  throw), told of each throw as the ball leaves the hand, and the last throw. */
  passAllowed?: (i: number, cmd: PassCmd) => boolean;
  onPass?: (rec: PassRecord) => void;
  lastPass: PassRecord | null = null;
  /** setup.jump over the defaults, validated. */
  readonly jump: JumpTuning;
  /** setup.fumble over the defaults, validated. */
  readonly fumble: FumbleTuning;
  /** setup.grab / contact / bones / knockout over their defaults, validated; `sup` is SUP with the hit tuning on top. */
  readonly grab: GrabTuning; readonly contact: HitTuning; readonly bones: BoneTuning; readonly knockout: KoTuning;
  private readonly sup: typeof SUP;

  private constructor(readonly scene: PhysicsScene, readonly setup: WorldSetup) {
    this.rng = new Rng(setup.seed);
    this.assist = setup.assist;
    this.ballIndex = setup.props?.findIndex((p) => p.name === 'ball') ?? -1;
    this.jump = jumpTuning(setup.jump);
    this.fumble = fumbleTuning(setup.fumble);
    this.grab = grabTuning(setup.grab); this.contact = hitTuning(setup.contact); this.bones = boneTuning(setup.bones); this.knockout = koTuning(setup.knockout);
    this.sup = { ...SUP, ...this.contact };
  }

  static async create(engine: PhysicsEngine, setup: WorldSetup): Promise<World> {
    await engine.init();
    const plans = setup.athletes.map((a) => buildBody(a.params, setup.physics.detail));
    const { tolerance, cone } = setup.physics;
    const scene = engine.createScene({
      hz: setup.physics.hz, iterations: setup.physics.iterations, opts: { tolerance, cone },
      athletes: setup.athletes.map((a, i) => ({ plan: plans[i], pos: a.pos, yaw: a.yaw })),
      props: setup.props ?? [], traction: setup.traction,
    });
    const w = new World(scene, setup);
    setup.athletes.forEach((a, i) => {
      const muscles = new MuscleSet(plans[i]);
      const ath = new Athlete(i, a, plans[i], muscles, a.controller(plans[i], muscles), a.brain);
      ath.injury = new InjuryState(ath.muscles, scene.dt, a.boneStrength, w.bones, w.knockout);
      w.athletes.push(ath);
      if (a.hasBall) w.ballCarrier = i;
    });
    w.impact.peakHeadG = w.athletes.map(() => 0);
    // controllers that take support tuning share the world's settings object (tuning-panel edits reach them)
    if (setup.support) for (const a of w.athletes) if ('supportSettings' in a.controller) (a.controller as { supportSettings: SupportSettings }).supportSettings = setup.support;
    w.sense(); // contacts at t = 0, so controllers see their feet on the ground from the first step
    return w;
  }

  get dt() { return this.scene.dt; }

  view(a: Athlete): BodyView {
    const th = a.throwing;
    return { plan: a.plan, muscles: a.muscles, state: this.scene.athletes[a.index].state, dt: this.dt, time: this.time, feet: a.feet, playerContact: a.playerContact, support: this.supported(a) ? a.support : undefined,
      grips: [a.grips[0].active && (a.grips[0].target?.athlete ?? -1) >= 0, a.grips[1].active && (a.grips[1].target?.athlete ?? -1) >= 0], reachTo: a.reachTo, hurt: a.injury, jump: this.jump, grab: this.grab,
      ...(th && { throwing: { t: th.t, at: th.cmd.at, hand: th.hand } }) };
  }

  perception(self: number, shared = this.perceive()): Perception { return { time: this.time, self, ...shared }; }

  /** What every brain sees this step (the same for all of them: nothing moves between their turns). */
  private perceive(): Omit<Perception, 'time' | 'self'> {
    const athletes: AthleteView[] = this.athletes.map((a) => {
      const s = this.scene.athletes[a.index].state;
      const fwd = qrot(quatAt(s.segQuat, a.pelvisSeg), [0, 0, 1]);
      return {
        com: [...s.com] as Vec3, comVel: [...s.comVel] as Vec3,
        pelvis: vecAt(s.segPos, a.pelvisSeg),
        head: vecAt(s.segPos, a.headSeg),
        heading: headingOf(fwd), down: a.downBy !== null, hasBall: a.index === this.ballCarrier, team: a.setup.team, lame: a.injury.leg[0] || a.injury.leg[1],
      };
    });
    const bi = this.ballIndex;
    const ball = bi >= 0 ? { pos: this.scene.propPose(bi).pos, vel: this.scene.propVel(bi) } : undefined;
    return { athletes, field: this.setup.field ?? { halfWidth: 24.38, goalZ: 50, dirZ: 1 }, ball };
  }

  step() {
    const dt = this.dt, seen = this.perceive(), lod = this.setup.physics.lod;
    for (const a of this.athletes) {
      a.cmd = this.hurtCommands(a, a.injury.out ? neutralCommands() : a.brain.think(this.perception(a.index, seen), dt));
      for (const h of [0, 1] as const) a.reachTo[h] = this.raised(a, h) ? this.reachPoint(a, h) : null;
      this.throwStep(a);
      // Athlete level of detail (low presets): far from play, a bot re-plans his motor targets on every other step
      // (half the bots on even steps, half on odd), over the time since his last plan, and his balance controller
      // rests while it has nothing to do; in between his muscles keep acting on his simulated body from the last
      // targets.
      const far = !!lod && this.far(a, lod);
      if (lod) a.controller.lod = far;
      if (!far || this.steps % 2 === a.index % 2) {
        const v = this.view(a);
        if (lod) { v.dt = (this.steps - a.planned) * dt; a.planned = this.steps; }
        a.controller.compute(v, a.cmd, a.targets);
      }
      const s = this.scene.athletes[a.index].state;
      a.muscles.compute(a.targets, s.q, s.qd);
      if (a.injury.broken.size || a.injury.out) this.limp(a);
      this.scene.setTorques(a.index, a.muscles.torque);
      this.scene.setDamping(a.index, a.muscles.damping);
      if (this.supported(a)) this.applySupport(a); else this.applyAssist(a);
      if ((this.setup.hitPower ?? 1) > 1) this.applyHitPower(a, this.setup.hitPower!);
    }
    this.scene.step();
    this.time += dt; this.steps++;
    this.afterStep();
  }

  private supported(a: Athlete) { return !!this.setup.support && !!a.controller.root; }

  /** Far from play (athlete level of detail): a bot, touching nobody, farther than `r` (m) from the ball and from
   *  every opponent. A player's athlete never is. */
  private far(a: Athlete, r: number) {
    if (a.setup.player || a.playerContact) return false;
    const c = this.scene.athletes[a.index].state.com, d2 = r * r, away = (p: ArrayLike<number>) => (p[0] - c[0]) ** 2 + (p[2] - c[2]) ** 2 > d2;
    if (this.ballIndex >= 0 && !away(this.scene.propPose(this.ballIndex).pos)) return false;
    return this.athletes.every((o) => o.setup.team === a.setup.team || away(this.scene.athletes[o.index].state.com));
  }

  /** Active-ragdoll support (design §6.5). Carry: horizontal force toward the root velocity, zero while touching
   *  another athlete. Posture: weight share, pelvis height and pelvis/thorax attitude toward the root target. */
  private applySupport(a: Athlete) {
    const S = this.setup.support!, r = a.controller.root!(), sup = a.support;
    a.carryForce = [0, 0, 0];
    if (!r) return;
    // dive flight is ballistic: no support of any kind, so momentum is the take-off's and the body lands
    if (r.dive === 'flight') return;
    const s = this.scene.athletes[a.index].state, m = a.mass, k = S.strength, pi = a.pelvisSeg;
    const J = this.jump, air = r.jump === 'flight';
    const c = a.playerContact || (air && J.air <= 0) ? 0 : air ? k : sup.carry * k;
    // dive or jump take-off: the carry stands in for the push off the turf, so it needs a foot on it
    // (a running jump's push spans a real one-foot stance from the foot's touchdown: RUN_TAKEOFF; the animator ends it)
    const launch = (r.dive === 'launch' || r.jump === 'launch') && (a.feet[0].touching || a.feet[1].touching
      || (r.jump === 'launch' && a.airT < RUN_TAKEOFF.stance && Math.hypot(s.comVel[0], s.comVel[2]) > RUN_TAKEOFF.from));
    // jump flight is ballistic too (no carry, and weightSupport gives no lift); only the posture's attitude torque stays,
    // the same as through a running stride's flight. The jump tuning's air control (0 = off) is the one exception: a
    // horizontal carry toward the move direction, at most J.air, off contact only.
    if (c > 0 && launch) {
      const f: Vec3 = [0, 1, 2].map((j) => m * this.sup.launchKv * (r.vel[j] - s.comVel[j])) as Vec3, n = Math.hypot(...f);
      const lim = m * (r.jump === 'launch' ? r.power * lerp(this.sup.jump[0], this.sup.jump[1], clamp(Math.hypot(s.comVel[0], s.comVel[2]) - 2.5, 0, 1)) : this.sup.launch);
      a.carryForce = f.map((x) => x * c * (n > lim ? lim / n : 1)) as Vec3;
    } else if (c > 0 && air) {
      let fx = m * this.sup.kv * (r.vel[0] - s.comVel[0]), fz = m * this.sup.kv * (r.vel[2] - s.comVel[2]);
      const n = Math.hypot(fx, fz), lim = m * J.air;
      if (n > lim) { fx *= lim / n; fz *= lim / n; }
      a.carryForce = [fx * c, 0, fz * c];
    } else if (c > 0) {
      // a hip-thrust lunge is a take-off too: the carry stands in for the explosive push off the turf (along the turf,
      // where the pads point once projected on it: never down into it, and the rise is the legs' own)
      const kv = r.thrust > 0 ? this.sup.launchKv : this.sup.kv;
      let fx = m * kv * (r.vel[0] - s.comVel[0]), fz = m * kv * (r.vel[2] - s.comVel[2]);
      const n = Math.hypot(fx, fz), lim = m * (r.thrust > 0 ? this.sup.lunge : S.carryAccel), sp = Math.hypot(s.comVel[0], s.comVel[2]);
      if (r.thrust <= 0 && sp > 0.5) {
        // across the run the carry may turn it harder than it speeds it up (a cut's sideways push), within one
        // ellipse for both (as the animator's root velocity)
        const ux = s.comVel[0] / sp, uz = s.comVel[2] / sp, along = fx * ux + fz * uz;
        const lat = m * Math.max(S.carryAccel, lerp(this.sup.lat[1], this.sup.lat[0], 1 - clamp((sp - 4) / 4, 0, 1)));
        const e = Math.hypot(along / lim, Math.hypot(fx - along * ux, fz - along * uz) / lat);
        if (e > 1) { fx /= e; fz /= e; }
      } else if (n > lim) { fx *= lim / n; fz *= lim / n; }
      a.carryForce = [fx * c, 0, fz * c];
    }
    const p = sup.posture * k;
    let fy = 0;
    // A dive loads and pushes off the athlete's own legs, and so does a hip thrust: the posture support leaves the
    // weight to them (the tracking controller's legShare), so it never lifts the athlete or what he drives.
    const ps = p * weightSupport(r);
    // a commanded sink is not braked as a fall; a rise (thrust) gets no help: the legs must drive it.
    // It holds the body up through the feet, as a leg would: on the feet's share of the stride, harder the less of
    // the time they are down, and not at all in a stride's flight (held up there, a sprinter floated for a quarter
    // second at a time and every landing bounced him into a hop). It still catches a body in the air that drops well
    // below its target (legs that have not reached the turf yet). Lying or getting up it acts as before. All of this
    // is off contact only (it comes in with the carry level); in contact the support holds him up as it always has.
    const off = a.playerContact ? 0 : a.carryLevel;
    const footing = a.feet[0].touching || a.feet[1].touching, y = s.segPos[3 * pi + 1];
    a.grounded += ((footing ? 1 : 0) - a.grounded) * Math.min(1, this.dt / 0.4);
    // (running only: a walker has no flight, and both feet up at a walk is a stumble the support must catch)
    const run = off * clamp((Math.hypot(r.vel[0], r.vel[2]) - 2) / 1, 0, 1);
    const gs = 1 + run * ((a.downBy ? 1 : footing ? 1 / Math.max(0.3, a.grounded) : clamp((r.height - y) / 0.1, 0, 1)) - 1);
    const vy = s.segVel[3 * pi + 1];
    if (ps > 0 && gs > 0) fy = clamp(ps * gs * (S.weightShare * m * G + m * this.sup.hKp * (r.height - y) - m * this.sup.hKd * (vy - Math.min(0, r.vel[1]))), 0, 1.5 * ps * gs * m * G);
    // the height damping brakes a body rising past its target too (a bounce off the turf), not only a falling one
    if (ps > 0 && y > r.height && vy > Math.max(0, r.vel[1])) fy -= off * ps * Math.min(m * this.sup.hKd * (vy - Math.max(0, r.vel[1])), this.sup.brake * m * G);
    this.scene.applyWrench(a.index, pi, [a.carryForce[0], fy + a.carryForce[1], a.carryForce[2]], [0, 0, 0]);
    if (p <= 0) return;
    const H = a.plan.standHeight, kUp = p * this.sup.kUp * m * G * H, cUp = 0.5 * p * this.sup.cUp * m * H * H;
    // Damping acts on the whole body's rotation rate (angular momentum over inertia about the COM): a pelvis is too
    // light for explicit damping of its own spin at 240 Hz, and arm and leg swing leave the total untouched.
    const wb = bodyRate(a.plan, s);
    // the pelvis takes part of the trunk lean, the thorax all of it (as in the hand controller's attitude targets)
    for (const [i, f] of [[pi, 0.3], [a.trunkSeg, 1]] as const) {
      // ... except, off contact, running, where the pelvis pitches with the trunk from 3 to 6 m/s (as the animator
      // solves the legs), and a lean into a turn, which takes the whole body: turning the pelvis through only part of
      // it left the legs solved for hips at the wrong heights, one foot hanging off the turf and the other striking it
      const fp = f + (1 - f) * off * clamp((Math.hypot(s.comVel[0], s.comVel[2]) - 3) / 3, 0, 1), fr = f + (1 - f) * off;
      // the thorax also takes a strike's side bend and, about its own long axis (the spine's rotation), its twist
      const o = f === 1 ? qmul(rootQuat(r.heading, fp * r.pitch, fr * r.roll + r.bank), qaxis([0, 1, 0], r.twist)) : rootQuat(r.heading, fp * r.pitch, fr * r.roll);
      const e = qlog(qmul(o, qconj(quatAt(s.segQuat, i))));
      this.scene.applyWrench(a.index, i, [0, 0, 0], [kUp * e[0] - cUp * wb[0], this.sup.yaw * (kUp * e[1] - cUp * wb[1]), kUp * e[2] - cUp * wb[2]]);
    }
  }

  /** Arcade hit power (owner decision 2026-10-18): the athlete a hit drives back gets (hitPower − 1) × the contact
   *  force he received last step on top, along it (half on the pelvis, half on the thorax, so it does not spin
   *  him), plus a lift so a big hit takes him off the turf. The hitter driving through gets nothing. */
  private applyHitPower(a: Athlete, hp: number) {
    const f = a.hitOpp, fh = Math.hypot(f[0], f[2]);
    if (fh < 1e-6 || a.downBy || this.commonSpeed(a, f[0] / fh, f[2] / fh) < HIT.minV) return;
    // on at most a real hit's force: past it the contact force is the solver prying apart bodies that met inside one
    // step (a head-on closing at 17 m/s), and multiplying that launched the pushed man tens of m/s into the air
    const k = 0.5 * (hp - 1) * Math.min(1, HIT.maxForce / Math.hypot(f[0], f[1], f[2])), F: Vec3 = [k * f[0], k * HIT.lift * fh, k * f[2]];
    this.scene.applyWrench(a.index, a.pelvisSeg, F, [0, 0, 0]);
    this.scene.applyWrench(a.index, a.trunkSeg, F, [0, 0, 0]);
  }

  /** Speed along a horizontal direction (m/s) of this athlete and whoever he touches, together: positive along the
   *  push he gets means that push drives him back. For the hitter it is against his push; equal momenta head on, 0. */
  private commonSpeed(a: Athlete, dx: number, dz: number) {
    const s = this.scene.athletes[a.index].state;
    let m = a.mass, p = m * (s.comVel[0] * dx + s.comVel[2] * dz);
    for (const k of a.touching) {
      const o = this.athletes[k], so = this.scene.athletes[k].state, mo = o.mass;
      p += mo * (so.comVel[0] * dx + so.comVel[2] * dz); m += mo;
    }
    return p / m;
  }

  /** Knock, carry and posture levels from what happened this step (design §6.5). */
  private updateSupport(a: Athlete, dt: number) {
    const S = this.setup.support!, s = this.scene.athletes[a.index].state, m = a.mass, r = a.controller.root!();
    // impulse received from other athletes over the window
    const n = Math.max(1, Math.round(this.sup.window / dt)), J = a.hitImpulse, f = a.hitForce;
    if (a.hitWindow.length !== 3 * n) { a.hitWindow = new Float64Array(3 * n); a.hitHead = 0; a.hitCount = 0; J[0] = J[1] = J[2] = 0; }
    const W = a.hitWindow, h = 3 * a.hitHead, j0 = f[0] * dt, j1 = f[1] * dt, j2 = f[2] * dt;
    J[0] += j0; J[1] += j1; J[2] += j2; // add the new, then take the oldest off: the same sums in the same order as before
    if (a.hitCount === n) { J[0] -= W[h]; J[1] -= W[h + 1]; J[2] -= W[h + 2]; a.hitHead = (a.hitHead + 1) % n; } else a.hitCount++;
    const t = 3 * ((a.hitHead + a.hitCount - 1) % n); W[t] = j0; W[t + 1] = j1; W[t + 2] = j2;
    // Only the part of the impulse the athlete's own momentum did not absorb counts: the momentum it left him
    // moving with along the hit. A hitter who drives through keeps moving into it; the one driven back does not.
    const Jh = Math.hypot(J[0], J[2]), vAlong = Jh > 1e-9 ? (s.comVel[0] * J[0] + s.comVel[2] * J[2]) / Jh : 0;
    // Pad level: a low athlete (meaning to be low, and low) has his weight down and his feet wide, so the same
    // impulse takes him less far off balance than an upright one.
    const pi = a.pelvisSeg, H0 = a.plan.standHeight, T = a.setup.toughness ?? 1;
    const low = r ? clamp(Math.min(H0 - r.height, H0 - s.segPos[3 * pi + 1]) / LOW.drop, 0, 1) : 0, big = S.bigHit * T * (1 + LOW.base * low);
    const Jknock = Math.min(Jh, m * Math.max(0, vAlong)), knockHit = Jknock / big;
    // Stun: an athlete driven back hard loses muscle tone for a moment (the controller loosens), so the hit's
    // momentum goes through a limp-ish body instead of being caught by a stiff balance reaction.
    a.stun = Math.max(clamp((Jknock - this.sup.stunStart * big) / (this.sup.stunFull * big), 0, 1), a.stun - dt / this.sup.stunTime);
    // Driven back: still moving along the last big hit faster than the animation wants, the athlete has not caught
    // the momentum yet, so the knock stays up after the impulse window (else posture returns mid-stumble).
    // Measured against the speed he already had along it before the hit (own momentum is not the hit's).
    if (knockHit > 0.3) a.hitDir = [J[0] / Jh, J[2] / Jh];
    const vHit = s.comVel[0] * a.hitDir[0] + s.comVel[2] * a.hitDir[1], vWant = r ? r.vel[0] * a.hitDir[0] + r.vel[2] * a.hitDir[1] : 0;
    // (the lowest estimate over the hit: once the impulse leaves the window the estimate would be his new speed)
    if (knockHit > 0.3) { a.hitPre = a.hitMem > 0 ? Math.min(a.hitPre, vHit - Jh / m) : vHit - Jh / m; a.hitMem = 1; } else a.hitMem = Math.max(0, a.hitMem - dt / this.sup.drivenTime);
    const knockDriven = a.hitMem <= 0 ? 0 : clamp((vHit - Math.max(0, vWant, a.hitPre) - this.sup.drivenStart) / Math.max(1e-6, this.sup.drivenFull - this.sup.drivenStart), 0, 1);
    // Trunk tilt away from both upright and the lean the animation wants: a deliberate lean (low drive) is not a
    // knock, nor is the trunk still on its way into or out of one.
    const up = qrot(quatAt(s.segQuat, a.trunkSeg), [0, 1, 0]);
    const upD: Vec3 = r ? qrot(rootQuat(r.heading, r.pitch, r.roll + r.bank), [0, 1, 0]) : [0, 1, 0];
    const tilt = Math.min(Math.acos(clamp(up[1], -1, 1)), Math.acos(clamp(up[0] * upD[0] + up[1] * upD[1] + up[2] * upD[2], -1, 1)));
    const knockTilt = clamp((tilt - S.tiltStart * T) / Math.max(1e-6, (S.tiltEnd - S.tiltStart) * T), 0, 1);
    // both feet off the turf: a sprint stride's flight is allowed, longer means the athlete was lifted or launched
    const footing = a.feet[0].touching || a.feet[1].touching, speed = Math.hypot(s.comVel[0], s.comVel[2]);
    a.airT = footing ? 0 : a.airT + dt;
    const knockAir = clamp((a.airT - (0.08 + 0.015 * speed)) / 0.15, 0, 1);
    // Lifted: an opponent driving up and under him carries part of his weight, so his feet (and their traction) unload.
    const knockLift = clamp((J[1] / this.sup.window / (m * G) - LOW.liftStart) / (LOW.liftFull - LOW.liftStart), 0, 1);
    // Wrapped up, an athlete cannot keep his balance freely: the posture help drains while opponents hold him (one
    // arm takes it part way, two all the way), so the tackler's weight and pull bring him down unless he breaks free.
    let held = 0;
    // a hand on the ball he carries holds him as much as a hand on his jersey
    const onHim = (t: LinkRef | null) => !!t && (t.athlete === a.index || (t.athlete < 0 && this.ballCarrier === a.index && t.seg === this.ballIndex));
    for (const o of this.athletes) if (o !== a) for (const g of o.grips) if (g.active && onHim(g.target)) held++;
    a.heldT = held > 0 ? a.heldT + dt : Math.max(0, a.heldT - 2 * dt);
    const GT = this.grab, knockHeld = clamp((a.heldT - GT.holdStart * T) / (GT.holdFull * T), 0, 1) * (held >= 2 ? 1 : GT.oneArm);
    // Held on to past that, his legs give: a balance controller alone would keep a wrapped athlete standing for
    // ever. Muscle tone drains (the stun's looseness) until he goes down or breaks free.
    if (held >= 2) a.stun = Math.max(a.stun, clamp((a.heldT - (GT.holdStart + GT.holdFull) * T) / (HELD.sag * T), 0, HELD.sagMax));
    // Untouched for a while (no contact, no hit still carrying him, nobody holding him) and not still knocked from
    // one, a tilt or a flight is his own running, cutting or leaning, never a knock: off contact the support keeps
    // him upright (design §6.5). One still off balance from a hit keeps stumbling until he has caught himself.
    const own = a.freeT > this.sup.free && a.hitMem <= 0 && a.heldT <= 0 && a.knock < 0.05 ? 0 : 1;
    // (his own jump's flight is no knock either, even just after a contact) ... but an athlete in a jump's flight who
    // touches another has no turf to balance on: no posture support, so a contact that stops his legs pitches him
    // over. (The hit rule above misses it at speed: driving through, his momentum absorbs the impulse.)
    const knockAirHit = r?.jump === 'flight' && !footing && a.playerContact ? 1 : 0;
    const target = Math.min(1, Math.max(knockHit, own * knockTilt, r?.jump === 'flight' ? 0 : own * knockAir, knockDriven, knockLift, knockHeld, knockAirHit));
    // rises fast, within a couple of steps on a big hit (the body goes as its impulse lands), decays slowly
    a.knock = target > a.knock ? a.knock + (target - a.knock) * Math.min(1, dt / (knockHit >= 1 ? this.sup.bigRise : this.sup.rise)) : Math.max(target, a.knock - dt * this.sup.decay);
    const down = a.downBy !== null, clip = a.controller.debug?.().clip;
    if (clip === 'getup') {
      // posture support ramps back in with the get-up, while the body is actually rising (not falling back)
      if (s.segVel[3 * pi + 1] > -0.2) a.getup = Math.min(1, a.getup + dt / this.sup.getup);
      a.knock = Math.min(a.knock, 1 - a.getup);
    } else {
      a.getup = 0;
      if (down) a.knock = 1;
    }
    // carry: off while touching another athlete; back after separation and stable footing
    if (a.playerContact) { a.carryLevel = 0; a.supStable = 0; }
    else {
      // stable footing: a step's brief flight does not count against it, a lifted or falling body does
      // (still part knocked counts once the hit no longer drives him back: he gets going on the carry's (1 − knock)
      // share and may stumble, rather than standing still until fully steady)
      a.supStable = a.airT < 0.1 && !down && a.knock < this.sup.goKnock && knockDriven < 0.1 ? a.supStable + dt : 0;
      if (a.supStable >= this.sup.stable) a.carryLevel = Math.min(1, a.carryLevel + dt / this.sup.fadeIn);
    }
    const flight = clamp(1 - (a.airT - this.sup.flight) / 0.1, 0, 1);
    a.support = { posture: down && clip !== 'getup' ? 0 : 1 - a.knock, carry: a.playerContact ? 0 : a.carryLevel * flight * (1 - a.knock), down };
    if (a.injury.out) { a.knock = 1; a.support = { posture: 0, carry: 0, down, out: true }; }
    if ('stun' in a.controller) a.controller.stun = a.stun;
  }

  /** Invisible posture/weight support. Vertical force and roll/pitch torque only — never horizontal force. */
  private applyAssist(a: Athlete) {
    const level = a.injury.out ? 0 : this.assist * a.assistLevel;
    if (level <= 0) return;
    const s = this.scene.athletes[a.index].state, m = a.mass, g = G;
    if (!a.feet[0].touching && !a.feet[1].touching) return;
    const pi = a.pelvisSeg;
    const standY = a.plan.standHeight;
    const y = s.segPos[3 * pi + 1];
    // Fade support out as the pelvis drops toward the ground, so the assist never holds up a falling body.
    const w = Math.min(1, Math.max(0, (y - 0.45 * standY) / (0.3 * standY)));
    // At 100 % the assist carries at most half the body weight.
    this.scene.applyWrench(a.index, pi, [0, level * m * g * w * 0.5, 0], [0, 0, 0]);
    // Posture: pull pelvis and thorax "up" axes toward vertical (roll/pitch only), and damp roll/pitch rates.
    for (const i of [pi, a.trunkSeg]) {
      const upv = qrot(quatAt(s.segQuat, i), [0, 1, 0]);
      const k = level * m * g * standY * 1.5, c = level * m * standY * standY * 1.2;
      const wx = s.segAngVel[3 * i], wz = s.segAngVel[3 * i + 2];
      // torque = k (up × ŷ) − c ω_horizontal
      this.scene.applyWrench(a.index, i, [0, 0, 0], [-k * upv[2] - c * wx, 0, k * upv[0] - c * wz]);
    }
  }

  private afterStep() {
    this.sense();
    for (const a of this.athletes) {
      a.freeT = a.playerContact ? 0 : a.freeT + this.dt;
      this.updateInjury(a, this.dt);
      this.updateAssistFade(a, this.dt);
      if (this.supported(a)) this.updateSupport(a, this.dt);
      this.updateGrips(a, this.dt);
      this.updateHeadAccel(a, this.dt);
    }
    this.updateImpact(this.lastHitForce);
  }

  /** Read contacts: foot loads and centres of pressure, player contact, hand touches, down detection (after each
   *  step; a multiplayer replica calls it after writing a snapshot into the scene). */
  sense() {
    for (const a of this.athletes) {
      a.feet.forEach((f) => { f.force = 0; f.cop.fill(0); f.touching = false; });
      a.downBy = null; a.handTouch = [null, null];
      a.playerContactNow = false;
      a.touching = []; a.trunkTouch = false;
      a.hitForce = [0, 0, 0]; a.hitOpp = [0, 0, 0];
    }
    let hit = 0;
    const pairs = this.pairBuf; pairs.clear();
    for (const c of this.scene.contacts()) {
      for (const [p, o] of [[c.a, c.b], [c.b, c.a]] as const) {
        if (p.athlete < 0) continue;
        const a = this.athletes[p.athlete];
        if (o.athlete < 0 && o.seg < 0) { // ground
          a.feet.forEach((f, k) => {
            if (a.footSegs[k].has(p.seg)) {
              for (let j = 0; j < 3; j++) f.cop[j] += c.pos[j] * c.force;
              f.force += c.force; f.touching = true;
            }
          });
          if (!a.limbEndSegs.has(p.seg)) a.downBy = a.plan.segments[p.seg].name;
        } else {
          if (o.athlete >= 0 && o.athlete !== p.athlete) { a.playerContactNow = true; if (!a.touching.includes(o.athlete)) a.touching.push(o.athlete);
            if (this.athletes[o.athlete].setup.team !== a.setup.team && /thorax|lumbar|trunk|pelvis/.test(a.plan.segments[p.seg].name)) a.trunkTouch = true; }
          const hand = a.handSegs.indexOf(p.seg);
          // a hand closes on props and opponents, never on a teammate (a blocker must not grab his own runner)
          if (hand >= 0 && (o.athlete < 0 || this.athletes[o.athlete].setup.team !== a.setup.team)) a.handTouch[hand] = { athlete: o.athlete, seg: o.seg, pos: c.pos };
        }
      }
      if (c.a.athlete >= 0 && c.b.athlete >= 0 && c.a.athlete !== c.b.athlete) {
        hit += c.force;
        // the contact normal points from the first geom to the second: b is pushed along it, a against it
        const fa = this.athletes[c.a.athlete].hitForce, fb = this.athletes[c.b.athlete].hitForce;
        for (let j = 0; j < 3; j++) { fa[j] -= c.normal[j] * c.force; fb[j] += c.normal[j] * c.force; }
        const A = this.athletes[c.a.athlete], B = this.athletes[c.b.athlete];
        if (A.setup.team !== B.setup.team) for (let j = 0; j < 3; j++) { A.hitOpp[j] -= c.normal[j] * c.force; B.hitOpp[j] += c.normal[j] * c.force; }
        const key = ((c.a.athlete * 1024 + c.a.seg) * 1024 + c.b.athlete) * 1024 + c.b.seg;
        let e = pairs.get(key);
        if (!e) {
          e = { a: c.a.athlete, segA: this.athletes[c.a.athlete].plan.segments[c.a.seg].name, b: c.b.athlete, segB: this.athletes[c.b.athlete].plan.segments[c.b.seg].name, force: 0, pos: [0, 0, 0], speed: 0, n: c.normal };
          const va = this.scene.athletes[c.a.athlete].state.segVel, vb = this.scene.athletes[c.b.athlete].state.segVel;
          e.speed = Math.max(0, -((vb[3 * c.b.seg] - va[3 * c.a.seg]) * c.normal[0] + (vb[3 * c.b.seg + 1] - va[3 * c.a.seg + 1]) * c.normal[1] + (vb[3 * c.b.seg + 2] - va[3 * c.a.seg + 2]) * c.normal[2]));
          pairs.set(key, e);
        }
        e.force += c.force;
        for (let j = 0; j < 3; j++) e.pos[j] += c.pos[j] * c.force;
      }
    }
    this.lastHitForce = hit;
    this.hits = [...pairs.values()].map(({ n: _n, ...e }) => ({ ...e, pos: e.force > 0 ? [e.pos[0] / e.force, e.pos[1] / e.force, e.pos[2] / e.force] : e.pos }));
    for (const a of this.athletes) {
      for (const f of a.feet) if (f.force > 0) for (let j = 0; j < 3; j++) f.cop[j] /= f.force;
      a.playerContact = a.playerContactNow;
    }
  }

  // ---------------------------------------------------------------- injuries (design §6.6)
  /** Breaks and knockout from this step's loads. A broken joint's range gives way at the end that broke (the limb
   *  dangles past where it should stop), a broken arm goes limp and a broken leg weak (InjuryState.breakJoint); he
   *  plays on, hobbling or one-armed. A knockout, or both legs broken, puts him out of play for the rep. */
  private updateInjury(a: Athlete, dt: number) {
    const s = this.scene.athletes[a.index].state, inj = a.injury;
    if (inj.out) inj.outFor += dt;
    for (const b of inj.checkBreaks(this.scene.limitTorques(a.index), s, a.freeT, dt)) {
      this.breakJoint(a.index, b.joint, b.dof, b.end, b.relax);
      const j = a.plan.joints.find((x) => x.name === b.joint)!;
      this.injuries.push({ athlete: a.index, kind: 'break', joint: b.joint, what: b.what, seg: j.child, parentSeg: j.parent, pos: vecAt(s.dofAnchor, b.dof), load: b.load, time: this.time });
    }
    const hi = a.headSeg;
    if (inj.checkKo(vecAt(s.segVel, hi), dt))
      this.injuries.push({ athlete: a.index, kind: 'ko', joint: 'head', what: 'ko', seg: 'head', parentSeg: a.plan.joints.find((x) => x.child === 'head')!.parent, pos: vecAt(s.segPos, hi), load: inj.peakDv, time: this.time });
  }

  /** Break a joint of athlete ai (a physics load did, or a test): its range gives way by `relax` rad at the end that
   *  broke, and a ball held in an arm that broke goes to the other arm while that one is sound (else it comes loose). */
  breakJoint(ai: number, joint: string, dof: number, end: -1 | 1, relax: number) {
    const a = this.athletes[ai], lo = a.muscles.lo[dof], hi = a.muscles.hi[dof];
    a.injury.breakJoint(joint);
    this.scene.setJointRange(ai, dof, end < 0 ? lo - relax : lo, end > 0 ? hi + relax : hi);
    const h = (this.ballCarrier === ai ? this.gripping(ai, { athlete: -1, seg: this.ballIndex }) : -1) as -1 | 0 | 1;
    if (h !== -1 && a.injury.arm[h] && !a.injury.arm[1 - h]) {
      this.releaseGrip(ai, h);
      this.tuckBall(ai, h === 1 ? 0 : 1);
    }
    a.cmd = this.hurtCommands(a, a.cmd);
  }

  /** Passing (docs/passing.md): a pass command from the ball holder starts the throwing motion (the animator plays it
   *  from BodyView.throwing); at THROW.release the hand lets go and the ball leaves it. Ignored while a motion runs,
   *  without the ball in hand, down, out of play, or when the rules say no. */
  private throwStep(a: Athlete) {
    const th = a.throwing;
    if (th) {
      th.t += this.dt;
      if (!th.released && th.t >= THROW.release) this.release(a, th);
      if (th.t >= THROW.end) a.throwing = null;
      return;
    }
    const p = a.cmd.pass;
    if (!p || this.ballCarrier !== a.index || a.downBy || a.injury.out || !(this.passAllowed?.(a.index, p) ?? true)) return;
    const hand = this.gripping(a.index, { athlete: -1, seg: this.ballIndex });
    const com = this.scene.athletes[a.index].state.com;
    if (hand >= 0) a.throwing = { t: 0, cmd: { at: [p.at[0], p.at[1], p.at[2]], loft: clamp(p.loft, 0, 1), follow: !!p.follow }, hand: hand as 0 | 1, released: false, from: [com[0], com[1], com[2]] };
  }

  /** The release: the ball leaves the hand on the trajectory to the pass's point (throw.ts), off by the passer's error
   *  (seeded), its nose along the flight and spinning about it (a spiral). A ball lost during the motion stays lost. */
  private release(a: Athlete, th: NonNullable<Athlete['throwing']>) {
    th.released = true;
    const bi = this.ballIndex, h = th.hand;
    if (this.ballCarrier !== a.index || this.gripping(a.index, { athlete: -1, seg: bi }) !== h) return;
    const s = this.scene.athletes[a.index].state, from = this.handPoint(a, h), loft = th.cmd.loft;
    // a point that follows him: moved along the ground as far as he ran since the throw began
    const at: Vec3 = th.cmd.follow ? [th.cmd.at[0] + s.com[0] - th.from[0], th.cmd.at[1], th.cmd.at[2] + s.com[2] - th.from[2]] : th.cmd.at;
    const pressured = this.athletes.some((o) => o.setup.team !== a.setup.team && Math.hypot(...sub(this.scene.athletes[o.index].state.com, s.com)) < THROW.pressR);
    const e = throwError(Math.hypot(at[0] - from[0], at[2] - from[2]), Math.hypot(s.comVel[0], s.comVel[2]), a.knock, pressured, loft);
    const to: Vec3 = [at[0] + e * this.rng.gauss(), at[1] + 0.5 * e * this.rng.gauss(), at[2] + e * this.rng.gauss()];
    let vel = throwVelocity(from, to, loft).vel;
    // it leaves from just ahead of the hand along its flight, its tail clear of it: a ball let go against the palm was
    // struck by the hand still closing on it (fingers would roll it off the hand; the hand model has none)
    const n = Math.hypot(vel[0], vel[1], vel[2]) || 1;
    for (let k = 0; k < 3; k++) from[k] += vel[k] / n * THROW.clear;
    vel = throwVelocity(from, to, loft).vel;
    this.releaseGrip(a.index, h);
    // the opened hand does not close on the ball again on its way out, nor does the carry arm
    a.grips[h].cooldown = THROW.end; a.cmd.carry = 0; this.ballCarrier = -1;
    this.scene.placeProp(bi, from, noseAlong(vel));
    this.scene.launchProp(bi, vel, [0, 0, THROW.spin]);
    this.lastPass = { athlete: a.index, time: this.time, at: [at[0], at[1], at[2]], to, loft, speed: Math.hypot(vel[0], vel[1], vel[2]), error: Math.hypot(...sub(to, at)) };
    this.onPass?.(this.lastPass);
  }

  /** Drill rules: put the ball against athlete ai's palm and grip it (a rep start, a recovery, or a hand-off from a
   *  broken arm: the possession rule standing in for what fingerless hands cannot do). The gap clears the contact
   *  margin, so the grip carries only the ball's own load, not a squeeze against the hand. */
  tuckBall(ai: number, h: 0 | 1) {
    const a = this.athletes[ai], s = this.scene.athletes[ai].state, k = a.handSegs[h], seg = a.plan.segments[k], q = quatAt(s.segQuat, k);
    const g = seg.geoms.find((x) => x.role === 'hand' && x.type === 'box');
    const c: Vec3 = g ? [g.pos![0] - seg.origin[0], g.pos![1] - seg.origin[1], g.pos![2] - seg.origin[2]] : [0, -0.05, 0];
    // the palm faces the body: +X in the right hand's frame, −X in the left's; the ball's long axis along the hand
    const half = (g ? g.size[0] : 0.02) * (h === 1 ? 1 : -1);
    const at = (x: number): Vec3 => { const p = qrot(q, [c[0] + x, c[1], c[2]]); return [s.segPos[3 * k] + p[0], s.segPos[3 * k + 1] + p[1], s.segPos[3 * k + 2] + p[2]]; };
    this.scene.placeProp(this.ballIndex, at(half + Math.sign(half) * (BALL.diameter / 2 + 0.008)), qmul(q, qaxis([1, 0, 0], Math.PI / 2)));
    this.attachGrip(ai, h, { athlete: -1, seg: this.ballIndex }, at(half));
    this.ballCarrier = ai;
  }

  /** Muscle output of an injured athlete: a limp arm gives nothing and a broken leg HOBBLE.legTone, at once; out of
   *  play, the rest lose tone over knockout.fade (the hit's own load is still met by muscles that were braced for it). */
  private limp(a: Athlete) {
    const m = a.muscles, inj = a.injury, K = this.knockout, f = Math.min(1, inj.outFor / K.fade), tone = inj.out ? 1 + ((inj.ko ? K.koTone : K.hurtTone) - 1) * f : 1;
    for (let i = 0; i < m.n; i++) {
      // a limp dof keeps its damping: the torn tissue still resists motion (and light limbs need it at 240 Hz)
      m.torque[i] *= inj.tone[i] * tone; m.damping[i] *= tone;
    }
  }

  /** Commands as an injured body carries them out: out of play, none but the ball kept where it is; a broken arm
   *  neither reaches nor grips, and the ball is carried in the other arm while that one is sound. */
  private hurtCommands(a: Athlete, c: Commands): Commands {
    const arm = a.injury.arm;
    if (a.injury.out) c.carry = a.cmd.carry;
    if (arm[0]) { c.armL = 0; c.gripL = false; }
    if (arm[1]) { c.armR = 0; c.gripR = false; }
    if (c.carry && arm[c.carry - 1]) c.carry = arm[2 - c.carry] ? 0 : c.carry === 1 ? 2 : 1;
    return c;
  }

  private updateAssistFade(a: Athlete, dt: number) {
    const footing = a.feet[0].touching || a.feet[1].touching;
    if (a.playerContact) { a.assistLevel = Math.max(0, a.assistLevel - dt / ASSIST_FADE_OUT); a.stableTimer = 0; return; }
    if (a.assistLevel < 1) {
      a.stableTimer = footing && a.downBy === null ? a.stableTimer + dt : 0;
      if (a.stableTimer >= ASSIST_STABLE_TIME) a.assistLevel = Math.min(1, a.assistLevel + dt / ASSIST_FADE_IN);
    }
  }

  private updateGrips(a: Athlete, dt: number) {
    // a hug's hands close once my trunk meets him, and hold while it is held
    const hug = a.cmd.hug && (a.trunkTouch || a.grips[0].active || a.grips[1].active);
    const want = [a.cmd.gripL || (a.cmd.wrap && !a.cmd.hug) || hug || a.cmd.carry === 1, a.cmd.gripR || (a.cmd.wrap && !a.cmd.hug) || hug || a.cmd.carry === 2].map((x, h) => x && !a.injury.arm[h]);
    for (const h of [0, 1] as const) {
      const g = a.grips[h];
      g.cooldown = Math.max(0, g.cooldown - dt);
      if (g.active) {
        // Grip force averaged over ~20 ms (the ball grip: the fumble window); breaks when it exceeds grip (or jersey) strength.
        const alpha = Math.min(1, dt / (this.isBall(g.target) ? this.fumble.window : this.grab.window));
        g.force += (this.scene.gripForce(a.index, h) - g.force) * alpha;
        if (!want[h] || g.force > g.limit) {
          this.scene.gripOff(a.index, h);
          g.active = false;
          g.cooldown = want[h] ? this.grab.cooldown : 0;
        }
      } else if (want[h] && g.cooldown <= 0) {
        // a raised hand closes on a fistful of jersey (or a limb) within GrabTuning.reach of it, not only on contact
        const near = !a.handTouch[h] && this.raised(a, h) ? this.nearestBody(a, this.handPoint(a, h), this.grab.reach + a.handGeoms[h].half) : null;
        const t = a.handTouch[h] ?? (near && { athlete: near.athlete, seg: near.seg, pos: this.handPoint(a, h) });
        if (!t) continue;
        const tgtAth = t.athlete >= 0 ? this.athletes[t.athlete] : null;
        const segName = tgtAth ? tgtAth.plan.segments[t.seg].name : '';
        g.jersey = /thorax|lumbar|trunk|pelvis/.test(segName);
        g.limit = g.jersey ? Math.min(GRIP_ECC * a.plan.gripStrength * this.grab.grip, EQUIPMENT.jersey.tearStrength * this.grab.tear) : GRIP_ECC * a.plan.gripStrength * this.grab.grip * (this.isBall(t) ? this.fumble.hold : 1);
        this.scene.gripOn(a.index, h, { athlete: t.athlete, seg: t.seg }, t.pos, g.jersey ? GRIP_TIMECONST.jersey : GRIP_TIMECONST.hand);
        g.active = true; g.force = 0; g.target = { athlete: t.athlete, seg: t.seg };
      }
    }
  }

  /** Drill rules only: a hand gripping something without a touch (the ball at rep start, or on a recovery). */
  attachGrip(ai: number, hand: 0 | 1, target: { athlete: number; seg: number }, point: Vec3) {
    const a = this.athletes[ai], g = a.grips[hand];
    this.scene.gripOn(ai, hand, target, point, GRIP_TIMECONST.hand);
    g.active = true; g.force = 0; g.jersey = false; g.limit = GRIP_ECC * a.plan.gripStrength * this.grab.grip * (this.isBall(target) ? this.fumble.hold : 1); g.target = target;
  }

  /** A grip target that is the ball (fumble tuning applies to it). */
  isBall(t: { athlete: number; seg: number } | null | undefined) { return !!t && t.athlete < 0 && t.seg === this.ballIndex; }

  /** The arm is raised to grab (reach button or wrap), so the hand may close on what it nearly touches. */
  raised(a: Athlete, h: 0 | 1) { return a.cmd.wrap || (h === 0 ? a.cmd.armL : a.cmd.armR) > 0.3; }

  /** Centre of a hand's geom (world). */
  handPoint(a: Athlete, h: 0 | 1): Vec3 {
    const s = this.scene.athletes[a.index].state, { seg, off } = a.handGeoms[h];
    const p = qrot(quatAt(s.segQuat, seg), off);
    return [s.segPos[3 * seg] + p[0], s.segPos[3 * seg + 1] + p[1], s.segPos[3 * seg + 2] + p[2]];
  }

  /** Aim point for a raised arm: REACH.into inside the opponent's body surface nearest the shoulder, so the hand
   *  arrives on it rather than short of it. */
  private reachPoint(a: Athlete, h: 0 | 1): Vec3 | null {
    const k = a.shoulderSegs[h];
    if (k < 0) return null;
    const s = this.scene.athletes[a.index].state, sp = vecAt(s.segPos, k);
    const n = this.nearestBody(a, sp, this.grab.aim);
    // a loose ball nearer than any opponent is what the hand goes for
    const bi = this.ballIndex;
    if (bi >= 0 && this.ballCarrier < 0) {
      const b = this.scene.propPose(bi).pos, gap = Math.hypot(b[0] - sp[0], b[1] - sp[1], b[2] - sp[2]) - REACH.ballR;
      if (gap < REACH.ball && (!n || gap < Math.hypot(n.pt[0] - sp[0], n.pt[1] - sp[1], n.pt[2] - sp[2]))) return [b[0], b[1], b[2]];
    }
    if (!n) return null;
    const d: Vec3 = [n.pt[0] - sp[0], n.pt[1] - sp[1], n.pt[2] - sp[2]], m = Math.hypot(...d) || 1;
    return [n.pt[0] + d[0] * REACH.into / m, n.pt[1] + d[1] * REACH.into / m, n.pt[2] + d[2] * REACH.into / m];
  }

  /** Nearest surface point of another team's body to `hp`, if closer than `range` (m). */
  private nearestBody(a: Athlete, hp: Vec3, range: number): { pt: Vec3; athlete: number; seg: number } | null {
    let best = range, out: { pt: Vec3; athlete: number; seg: number } | null = null;
    for (const o of this.athletes) {
      if (o.setup.team === a.setup.team) continue;
      const s = this.scene.athletes[o.index].state;
      if (Math.hypot(hp[0] - s.com[0], hp[1] - s.com[1], hp[2] - s.com[2]) > best + 1.5) continue;
      o.plan.segments.forEach((sg, k) => {
        const q = quatAt(s.segQuat, k), org = vecAt(s.segPos, k);
        // the point in the segment's rest frame, where its geoms are given
        const l = qrot(qconj(q), [hp[0] - org[0], hp[1] - org[1], hp[2] - org[2]]);
        l[0] += sg.origin[0]; l[1] += sg.origin[1]; l[2] += sg.origin[2];
        for (const g of sg.geoms) {
          let c: Vec3, r = g.size[0];
          if (g.type === 'capsule') {
            const [p0, p1] = g.fromto!, d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
            const u = clamp(((l[0] - p0[0]) * d[0] + (l[1] - p0[1]) * d[1] + (l[2] - p0[2]) * d[2]) / (dd || 1), 0, 1);
            c = [p0[0] + u * d[0], p0[1] + u * d[1], p0[2] + u * d[2]];
          } else if (g.type === 'box') {
            c = [0, 1, 2].map((j) => clamp(l[j], g.pos![j] - g.size[j], g.pos![j] + g.size[j])) as Vec3; r = 0;
          } else c = g.pos!;
          const e: Vec3 = [l[0] - c[0], l[1] - c[1], l[2] - c[2]], n = Math.hypot(...e), gap = n - r;
          if (gap >= best) continue;
          best = gap;
          const f = n > 1e-9 ? r / n : 0, w = qrot(q, [c[0] + e[0] * f - sg.origin[0], c[1] + e[1] * f - sg.origin[1], c[2] + e[2] * f - sg.origin[2]]);
          out = { pt: [org[0] + w[0], org[1] + w[1], org[2] + w[2]], athlete: o.index, seg: k };
        }
      });
    }
    return out;
  }

  /** The hand of athlete `ai` gripping `target` (an athlete segment or a prop), or −1. */
  gripping(ai: number, target: LinkRef): number {
    return this.athletes[ai].grips.findIndex((g) => g.active && g.target?.athlete === target.athlete && g.target.seg === target.seg);
  }

  /** Open a hand (drill rules, e.g. a loose ball cannot be picked up by hand). */
  releaseGrip(ai: number, hand: 0 | 1) {
    this.scene.gripOff(ai, hand);
    this.athletes[ai].grips[hand].active = false;
  }

  private updateHeadAccel(a: Athlete, dt: number) {
    const v = vecAt(this.scene.athletes[a.index].state.segVel, a.headSeg);
    const acc = Math.hypot(v[0] - a.headVelPrev[0], v[1] - a.headVelPrev[1], v[2] - a.headVelPrev[2]) / dt;
    a.headVelPrev = v;
    // First-order low-pass at ~60 Hz: a filtered rigid-body estimate, not a sensor reading.
    const alpha = 1 - Math.exp(-2 * Math.PI * 60 * dt);
    a.headAccFilt += (acc - a.headAccFilt) * alpha;
    if (this.impact.firstContactTime >= 0) this.impact.peakHeadG[a.index] = Math.max(this.impact.peakHeadG[a.index], a.headAccFilt / G);
  }

  private updateImpact(hit: number) {
    const n = Math.max(1, Math.round(0.01 / this.dt)); // 10 ms moving average
    if (this.forceWindow.length !== n) { this.forceWindow = new Float64Array(n); this.forceHead = 0; this.forceCount = 0; }
    const F = this.forceWindow;
    if (this.forceCount === n) { F[this.forceHead] = hit; this.forceHead = (this.forceHead + 1) % n; } else F[(this.forceHead + this.forceCount++) % n] = hit;
    let sum = 0; // oldest to newest, the order reduce summed in
    for (let i = 0; i < this.forceCount; i++) sum += F[(this.forceHead + i) % n];
    const avg = sum / this.forceCount;
    this.impact.peakForce = Math.max(this.impact.peakForce, avg);
    if (hit > 0 && this.impact.firstContactTime < 0 && this.athletes.length >= 2) {
      this.impact.firstContactTime = this.time;
      const [s0, s1] = [0, 1].map((i) => this.scene.athletes[i].state);
      const d = [s1.com[0] - s0.com[0], s1.com[1] - s0.com[1], s1.com[2] - s0.com[2]], L = Math.hypot(...d) || 1;
      this.impact.closingSpeed = -((s1.comVel[0] - s0.comVel[0]) * d[0] + (s1.comVel[1] - s0.comVel[1]) * d[1] + (s1.comVel[2] - s0.comVel[2]) * d[2]) / L;
    }
  }

  destroy() { this.scene.destroy(); }
}

/** Reaching (design §6.5): gap between a raised hand's surface and an opponent's body (m) under which the hand
 *  closes on it (a fistful of jersey stands off the body by a few cm); distance from the shoulder within which
 *  the arm aims at the nearest part of that body (an arm's length and a lean: the eyes guide the hand), and how
 *  far inside its surface the aim point lies. A loose ball is aimed at from further (the body bends to it): its
 *  surface within `ball` m of the shoulder, taken as a sphere of radius `ballR`. */
const REACH = { into: 0.03, ball: 1.3, ballR: 0.1 }; // grab, aim: GrabTuning reach, aim
/** The rotation that turns the prop's long axis (+z) along v. */
function noseAlong(v: Vec3): Quat {
  const n = Math.hypot(v[0], v[1], v[2]) || 1, c = v[2] / n, ax: Vec3 = [-v[1], v[0], 0];
  return Math.hypot(ax[0], ax[1]) < 1e-9 ? (c > 0 ? [0, 0, 0, 1] : [1, 0, 0, 0]) : qaxis(ax, Math.acos(clamp(c, -1, 1)));
}
/** Pad level (design §6.5): pelvis drop below standing (m) at which an athlete counts as fully low, how much
 *  more impulse a fully low athlete takes for the same knock (assumption: a sunk, wide base), and the upward force
 *  from opponents (× body weight, over the impulse window) where the lift knock starts and where it is full. */
const LOW = { drop: 0.25, base: 1, liftStart: 0.2, liftFull: 0.6 };
/** A grip pulled open loads the finger flexors eccentrically, which hold ~1.5× their isometric (dynamometer)
 *  force; at 1× tacklers' wraps and the carrier's ball grip let go of loads a hand really holds. */
const GRIP_ECC = 1.5;
/** Hit power: combined speed along the push (m/s) above which the athlete pushed counts as driven back (a lean on a
 *  standing opponent does not), the lift added per unit of horizontal boost, and the largest contact force the boost
 *  multiplies (N): ~100 kg stopped from 5 m/s over a 25 ms padded impact (Wusk 2022 pulse) averages 20 kN. */
const HIT = { minV: 0.3, lift: 0.5, maxForce: 20000 };

/** Whole-body angular velocity about the COM per world axis: L / I, segment inertias taken as isotropic. */
function bodyRate(plan: BodyPlan, s: AthleteState): Vec3 {
  let lx = 0, ly = 0, lz = 0, ix = 0, iy = 0, iz = 0;
  plan.segments.forEach((g, k) => {
    const m = g.mass, I = (g.inertia[0] + g.inertia[4] + g.inertia[8]) / 3;
    const rx = s.segCom[3 * k] - s.com[0], ry = s.segCom[3 * k + 1] - s.com[1], rz = s.segCom[3 * k + 2] - s.com[2];
    const vx = s.segVel[3 * k] - s.comVel[0], vy = s.segVel[3 * k + 1] - s.comVel[1], vz = s.segVel[3 * k + 2] - s.comVel[2];
    lx += m * (ry * vz - rz * vy) + I * s.segAngVel[3 * k];
    ly += m * (rz * vx - rx * vz) + I * s.segAngVel[3 * k + 1];
    lz += m * (rx * vy - ry * vx) + I * s.segAngVel[3 * k + 2];
    ix += m * (ry * ry + rz * rz) + I; iy += m * (rx * rx + rz * rz) + I; iz += m * (rx * rx + ry * ry) + I;
  });
  return [lx / ix, ly / iy, lz / iz];
}
