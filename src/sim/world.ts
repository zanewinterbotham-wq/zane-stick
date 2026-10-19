// The simulation loop: brains → commands → motor controller → muscles → physics, at a fixed timestep.
// Runs unchanged in the browser, a Worker, or Node. No DOM, no wall clock, no Math.random.
import { buildBody, type AthleteParams, type BodyPlan, type Detail } from './anatomy/body';
import { BALL, GRIP_TIMECONST, EQUIPMENT } from './anatomy/equipment';
import type { Brain, Perception, AthleteView } from './brains/types';
import { neutralCommands, type BodyView, type Commands, type FootContact, type MotorController } from './control/types';
import { clamp, headingOf, lerp, qaxis, qconj, qlog, qmul, qrot, type Quat, type Vec3 } from './math';
import { MuscleSet, newTargets, type MuscleTargets } from './muscles';
import type { AthleteState, LinkRef, PhysicsEngine, PhysicsScene, PropDesc } from './physics/engine';
import { Rng } from './rng';
import { InjuryState, type InjuryEvent } from './injury';
import { weightSupport, type SupportSettings, type SupportState } from './anim/types';

export interface PhysicsSettings { hz: number; iterations: number; detail: Detail }
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
}
export interface FieldInfo { halfWidth: number; goalZ: number; dirZ: 1 | -1 }
export interface WorldSetup { physics: PhysicsSettings; athletes: AthleteSetup[]; props?: PropDesc[]; seed: number; assist: number; field?: FieldInfo; traction?: number;
  /** Active-ragdoll support (design §6.5) for athletes whose controller has root(); absent = balance assist only. */
  support?: SupportSettings;
  /** Arcade hit power (owner decision 2026-10-18): 1 / absent = pure physics; above 1 the athlete a hit drives back
   *  gets (hitPower − 1) × the contact force he receives on top (World.applyHitPower). */
  hitPower?: number }

/** Balance assist timing [design §6.4]. */
const ASSIST_FADE_OUT = 0.15, ASSIST_STABLE_TIME = 0.3, ASSIST_FADE_IN = 0.3;
/** Held knock: grip time before it starts (s), further time to full (s), the share one arm takes, and after that
 *  the time over which a two-arm hold drains muscle tone, up to sagMax. */
const HELD = { start: 0.3, full: 0.9, oneArm: 0.6, sag: 1.0, sagMax: 0.8 };
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
const SUP = { kv: 6, stable: 0.3, fadeIn: 0.3, window: 0.2, flight: 0.15, decay: 1, getup: 1, hKp: 36, hKd: 10, kUp: 1.5, cUp: 6, yaw: 0.3,
  stunStart: 1, stunFull: 2, stunTime: 0.5, drivenStart: 0.5, drivenFull: 2, drivenTime: 1.5, launchKv: 20, launch: 15, jump: [17, 40] as const, lunge: 12, rise: 0.02, bigRise: 0.008,
  free: 1, brake: 0.5, lat: [14, 8.5] as const };

/** One body-part-on-body-part contact between two athletes this step (summed over its contact points). */
export interface HitEvent {
  a: number; segA: string; b: number; segB: string;
  force: number;   // total normal force, N
  pos: Vec3;       // force-weighted contact point
  speed: number;   // closing speed of the two segments along the contact normal, m/s (≥ 0)
}

export interface ImpactStats { closingSpeed: number; peakForce: number; peakHeadG: number[]; firstContactTime: number }

export class Athlete {
  readonly muscles: MuscleSet;
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
  grips: { active: boolean; force: number; cooldown: number; jersey: boolean; limit: number; target: LinkRef | null }[] = [0, 1].map(() => ({ active: false, force: 0, cooldown: 0, jersey: false, limit: 0, target: null }));
  /** Last contact per hand: target link and point, for grip forming. */
  handTouch: ({ athlete: number; seg: number; pos: Vec3 } | null)[] = [null, null];
  /** Per hand: the hand geom's segment, its centre in that segment's frame and its half thickness (m). */
  readonly handGeoms: { seg: number; off: Vec3; half: number }[];
  readonly shoulderSegs: number[];
  /** Per hand, this step: where a raised arm reaches for (a little inside the opponent's body nearest its
   *  shoulder, when within REACH.aim of it), or null. */
  reachTo: (Vec3 | null)[] = [null, null];
  readonly segIndex: Map<string, number>;
  readonly footSegs: Set<number>[];
  readonly handSegs: number[];
  readonly limbEndSegs: Set<number>;
  headVelPrev: Vec3 = [0, 0, 0]; headAccFilt = 0;
  /** Support levels handed to the controller, and the fade state behind them (design §6.5). */
  support: SupportState = { posture: 1, carry: 1, down: false };
  knock = 0; carryLevel = 1; supStable = 0; airT = 0; getup = 0;
  /** Share of the time a foot is on the turf (low-passed): sizes the posture support's push through the feet. */
  grounded = 1;
  /** Time since this athlete last touched another (s). */
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
  hitWindow: Vec3[] = []; hitImpulse: Vec3 = [0, 0, 0];
  /** Carry force applied this step (N, world): tests check it is zero during player contact. */
  carryForce: Vec3 = [0, 0, 0];
  /** Broken joints and knockout (design §6.6); set by World.create. */
  injury!: InjuryState;

  constructor(readonly index: number, readonly setup: AthleteSetup, readonly plan: BodyPlan, readonly controller: MotorController, readonly brain: Brain) {
    this.muscles = new MuscleSet(plan);
    this.targets = newTargets(this.muscles.n);
    this.segIndex = new Map(plan.segments.map((s, i) => [s.name, i]));
    const idx = (n: string) => this.segIndex.get(n) ?? -1;
    this.footSegs = ['L', 'R'].map((sx) => new Set([idx('foot' + sx), idx('toes' + sx)].filter((i) => i >= 0)));
    this.handSegs = ['L', 'R'].map((sx) => (idx('hand' + sx) >= 0 ? idx('hand' + sx) : idx('forearm' + sx)));
    this.limbEndSegs = new Set([...this.footSegs[0], ...this.footSegs[1], ...this.handSegs]);
    this.shoulderSegs = ['L', 'R'].map((sx) => idx('upperArm' + sx));
    this.handGeoms = this.handSegs.map((k) => {
      const sg = plan.segments[k], g = sg.geoms.find((x) => x.role === 'hand');
      return g?.pos ? { seg: k, off: [g.pos[0] - sg.origin[0], g.pos[1] - sg.origin[1], g.pos[2] - sg.origin[2]] as Vec3, half: Math.min(...g.size) } : { seg: k, off: [0, 0, 0] as Vec3, half: 0 };
    });
  }
  get mass() { return this.plan.segments.reduce((a, s) => a + s.mass, 0); }
}

export class World {
  readonly athletes: Athlete[] = [];
  readonly rng: Rng;
  time = 0; steps = 0;
  assist: number;           // 0..1 world setting
  impact: ImpactStats = { closingSpeed: 0, peakForce: 0, peakHeadG: [], firstContactTime: -1 };
  private forceWindow: number[] = [];
  /** Total inter-athlete contact normal force last step (N) — drives camera shake, rumble, sound. */
  lastHitForce = 0;
  /** Athlete-on-athlete contacts this step, one per segment pair (sound, feel, replays). */
  hits: HitEvent[] = [];
  /** Every break and knockout this rep, in order (sound, effects, HUD). */
  readonly injuries: InjuryEvent[] = [];
  ballCarrier = -1;
  /** Index of the ball among the props (a prop named 'ball'), or −1. */
  readonly ballIndex: number;

  private constructor(readonly scene: PhysicsScene, readonly setup: WorldSetup) {
    this.rng = new Rng(setup.seed);
    this.assist = setup.assist;
    this.ballIndex = setup.props?.findIndex((p) => p.name === 'ball') ?? -1;
  }

  static async create(engine: PhysicsEngine, setup: WorldSetup): Promise<World> {
    await engine.init();
    const plans = setup.athletes.map((a) => buildBody(a.params, setup.physics.detail));
    const scene = engine.createScene({
      hz: setup.physics.hz, iterations: setup.physics.iterations,
      athletes: setup.athletes.map((a, i) => ({ plan: plans[i], pos: a.pos, yaw: a.yaw })),
      props: setup.props ?? [], traction: setup.traction,
    });
    const w = new World(scene, setup);
    setup.athletes.forEach((a, i) => {
      const muscles = new MuscleSet(plans[i]);
      const ath = new Athlete(i, a, plans[i], a.controller(plans[i], muscles), a.brain);
      ath.injury = new InjuryState(ath.muscles, scene.dt, a.boneStrength);
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
    return { plan: a.plan, muscles: a.muscles, state: this.scene.athletes[a.index].state, dt: this.dt, time: this.time, feet: a.feet, playerContact: a.playerContact, support: this.supported(a) ? a.support : undefined,
      grips: [a.grips[0].active && (a.grips[0].target?.athlete ?? -1) >= 0, a.grips[1].active && (a.grips[1].target?.athlete ?? -1) >= 0], reachTo: a.reachTo, hurt: a.injury };
  }

  perception(self: number): Perception {
    const athletes: AthleteView[] = this.athletes.map((a) => {
      const s = this.scene.athletes[a.index].state;
      const pi = a.segIndex.get('pelvis')!, hi = a.segIndex.get('head')!;
      const q = s.segQuat.subarray(4 * pi, 4 * pi + 4) as unknown as Quat;
      const fwd = qrot([q[0], q[1], q[2], q[3]], [0, 0, 1]);
      return {
        com: [...s.com] as Vec3, comVel: [...s.comVel] as Vec3,
        pelvis: [s.segPos[3 * pi], s.segPos[3 * pi + 1], s.segPos[3 * pi + 2]],
        head: [s.segPos[3 * hi], s.segPos[3 * hi + 1], s.segPos[3 * hi + 2]],
        heading: headingOf(fwd), down: a.downBy !== null, hasBall: a.index === this.ballCarrier, team: a.setup.team, lame: a.injury.leg[0] || a.injury.leg[1],
      };
    });
    const bi = this.ballIndex;
    const ball = bi >= 0 ? { pos: this.scene.propPose(bi).pos, vel: this.scene.propVel(bi) } : undefined;
    return { time: this.time, self, athletes, field: this.setup.field ?? { halfWidth: 24.38, goalZ: 50, dirZ: 1 }, ball };
  }

  step() {
    const dt = this.dt;
    for (const a of this.athletes) {
      a.cmd = this.hurtCommands(a, a.injury.out ? neutralCommands() : a.brain.think(this.perception(a.index), dt));
      for (const h of [0, 1] as const) a.reachTo[h] = this.raised(a, h) ? this.reachPoint(a, h) : null;
      a.controller.compute(this.view(a), a.cmd, a.targets);
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

  /** Active-ragdoll support (design §6.5). Carry: horizontal force toward the root velocity, zero while touching
   *  another athlete. Posture: weight share, pelvis height and pelvis/thorax attitude toward the root target. */
  private applySupport(a: Athlete) {
    const S = this.setup.support!, r = a.controller.root!(), sup = a.support;
    a.carryForce = [0, 0, 0];
    if (!r) return;
    // dive flight is ballistic: no support of any kind, so momentum is the take-off's and the body lands
    if (r.dive === 'flight') return;
    const s = this.scene.athletes[a.index].state, m = a.mass, k = S.strength, pi = a.segIndex.get('pelvis')!;
    const c = a.playerContact || r.jump === 'flight' ? 0 : sup.carry * k;
    // dive or jump take-off: the carry stands in for the push off the turf, so it needs a foot on it
    const launch = (r.dive === 'launch' || r.jump === 'launch') && (a.feet[0].touching || a.feet[1].touching);
    // jump flight is ballistic too (no carry, and weightSupport gives no lift); only the posture's attitude torque stays,
    // the same as through a running stride's flight
    if (c > 0 && launch) {
      const f: Vec3 = [0, 1, 2].map((j) => m * SUP.launchKv * (r.vel[j] - s.comVel[j])) as Vec3, n = Math.hypot(...f), lim = m * (r.jump === 'launch' ? lerp(SUP.jump[0], SUP.jump[1], clamp(Math.hypot(s.comVel[0], s.comVel[2]) - 2.5, 0, 1)) : SUP.launch);
      a.carryForce = f.map((x) => x * c * (n > lim ? lim / n : 1)) as Vec3;
    } else if (c > 0) {
      // a hip-thrust lunge is a take-off too: the carry stands in for the explosive push off the turf
      const kv = r.thrust > 0 ? SUP.launchKv : SUP.kv;
      let fx = m * kv * (r.vel[0] - s.comVel[0]), fz = m * kv * (r.vel[2] - s.comVel[2]);
      const n = Math.hypot(fx, fz), lim = m * (r.thrust > 0 ? SUP.lunge : S.carryAccel), sp = Math.hypot(s.comVel[0], s.comVel[2]);
      if (r.thrust <= 0 && sp > 0.5) {
        // across the run the carry may turn it harder than it speeds it up (a cut's sideways push), within one
        // ellipse for both (as the animator's root velocity)
        const ux = s.comVel[0] / sp, uz = s.comVel[2] / sp, along = fx * ux + fz * uz;
        const lat = m * Math.max(S.carryAccel, lerp(SUP.lat[1], SUP.lat[0], 1 - clamp((sp - 4) / 4, 0, 1)));
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
    if (ps > 0 && gs > 0) fy = clamp(ps * gs * (S.weightShare * m * G + m * SUP.hKp * (r.height - y) - m * SUP.hKd * (vy - Math.min(0, r.vel[1]))), 0, 1.5 * ps * gs * m * G);
    // the height damping brakes a body rising past its target too (a bounce off the turf), not only a falling one
    if (ps > 0 && y > r.height && vy > Math.max(0, r.vel[1])) fy -= off * ps * Math.min(m * SUP.hKd * (vy - Math.max(0, r.vel[1])), SUP.brake * m * G);
    this.scene.applyWrench(a.index, pi, [a.carryForce[0], fy + a.carryForce[1], a.carryForce[2]], [0, 0, 0]);
    if (p <= 0) return;
    const H = a.plan.standHeight, kUp = p * SUP.kUp * m * G * H, cUp = 0.5 * p * SUP.cUp * m * H * H;
    // Damping acts on the whole body's rotation rate (angular momentum over inertia about the COM): a pelvis is too
    // light for explicit damping of its own spin at 240 Hz, and arm and leg swing leave the total untouched.
    const wb = bodyRate(a.plan, s);
    // the pelvis takes part of the trunk lean, the thorax all of it (as in the hand controller's attitude targets)
    for (const [name, f] of [['pelvis', 0.3], [a.segIndex.has('thorax') ? 'thorax' : 'trunk', 1]] as const) {
      const i = a.segIndex.get(name)!, q = s.segQuat.subarray(4 * i, 4 * i + 4);
      // ... except, off contact, running, where the pelvis pitches with the trunk from 3 to 6 m/s (as the animator
      // solves the legs), and a lean into a turn, which takes the whole body: turning the pelvis through only part of
      // it left the legs solved for hips at the wrong heights, one foot hanging off the turf and the other striking it
      const fp = f + (1 - f) * off * clamp((Math.hypot(s.comVel[0], s.comVel[2]) - 3) / 3, 0, 1), fr = f + (1 - f) * off;
      const e = qlog(qmul(orient(r.heading, fp * r.pitch, fr * r.roll), qconj([q[0], q[1], q[2], q[3]])));
      this.scene.applyWrench(a.index, i, [0, 0, 0], [kUp * e[0] - cUp * wb[0], SUP.yaw * (kUp * e[1] - cUp * wb[1]), kUp * e[2] - cUp * wb[2]]);
    }
  }

  /** Arcade hit power (owner decision 2026-10-18): the athlete a hit drives back gets (hitPower − 1) × the contact
   *  force he received last step on top, along it (half on the pelvis, half on the thorax, so it does not spin
   *  him), plus a lift so a big hit takes him off the turf. The hitter driving through gets nothing. */
  private applyHitPower(a: Athlete, hp: number) {
    const f = a.hitForce, fh = Math.hypot(f[0], f[2]);
    if (fh < 1e-6 || a.downBy || this.commonSpeed(a, f[0] / fh, f[2] / fh) < HIT.minV) return;
    // on at most a real hit's force: past it the contact force is the solver prying apart bodies that met inside one
    // step (a head-on closing at 17 m/s), and multiplying that launched the pushed man tens of m/s into the air
    const k = 0.5 * (hp - 1) * Math.min(1, HIT.maxForce / Math.hypot(f[0], f[1], f[2])), F: Vec3 = [k * f[0], k * HIT.lift * fh, k * f[2]];
    this.scene.applyWrench(a.index, a.segIndex.get('pelvis')!, F, [0, 0, 0]);
    this.scene.applyWrench(a.index, a.segIndex.get('thorax') ?? a.segIndex.get('trunk')!, F, [0, 0, 0]);
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
    const n = Math.max(1, Math.round(SUP.window / dt)), J = a.hitImpulse, f = a.hitForce;
    const jn: Vec3 = [f[0] * dt, f[1] * dt, f[2] * dt];
    a.hitWindow.push(jn); J[0] += jn[0]; J[1] += jn[1]; J[2] += jn[2];
    if (a.hitWindow.length > n) { const o = a.hitWindow.shift()!; J[0] -= o[0]; J[1] -= o[1]; J[2] -= o[2]; }
    // Only the part of the impulse the athlete's own momentum did not absorb counts: the momentum it left him
    // moving with along the hit. A hitter who drives through keeps moving into it; the one driven back does not.
    const Jh = Math.hypot(J[0], J[2]), vAlong = Jh > 1e-9 ? (s.comVel[0] * J[0] + s.comVel[2] * J[2]) / Jh : 0;
    // Pad level: a low athlete (meaning to be low, and low) has his weight down and his feet wide, so the same
    // impulse takes him less far off balance than an upright one.
    const pi = a.segIndex.get('pelvis')!, H0 = a.plan.standHeight, T = a.setup.toughness ?? 1;
    const low = r ? clamp(Math.min(H0 - r.height, H0 - s.segPos[3 * pi + 1]) / LOW.drop, 0, 1) : 0, big = S.bigHit * T * (1 + LOW.base * low);
    const Jknock = Math.min(Jh, m * Math.max(0, vAlong)), knockHit = Jknock / big;
    // Stun: an athlete driven back hard loses muscle tone for a moment (the controller loosens), so the hit's
    // momentum goes through a limp-ish body instead of being caught by a stiff balance reaction.
    a.stun = Math.max(clamp((Jknock - SUP.stunStart * big) / (SUP.stunFull * big), 0, 1), a.stun - dt / SUP.stunTime);
    // Driven back: still moving along the last big hit faster than the animation wants, the athlete has not caught
    // the momentum yet, so the knock stays up after the impulse window (else posture returns mid-stumble).
    // Measured against the speed he already had along it before the hit (own momentum is not the hit's).
    if (knockHit > 0.3) a.hitDir = [J[0] / Jh, J[2] / Jh];
    const vHit = s.comVel[0] * a.hitDir[0] + s.comVel[2] * a.hitDir[1], vWant = r ? r.vel[0] * a.hitDir[0] + r.vel[2] * a.hitDir[1] : 0;
    // (the lowest estimate over the hit: once the impulse leaves the window the estimate would be his new speed)
    if (knockHit > 0.3) { a.hitPre = a.hitMem > 0 ? Math.min(a.hitPre, vHit - Jh / m) : vHit - Jh / m; a.hitMem = 1; } else a.hitMem = Math.max(0, a.hitMem - dt / SUP.drivenTime);
    const knockDriven = a.hitMem <= 0 ? 0 : clamp((vHit - Math.max(0, vWant, a.hitPre) - SUP.drivenStart) / (SUP.drivenFull - SUP.drivenStart), 0, 1);
    // Trunk tilt away from both upright and the lean the animation wants: a deliberate lean (low drive) is not a
    // knock, nor is the trunk still on its way into or out of one.
    const ti = a.segIndex.get('thorax') ?? a.segIndex.get('trunk')!, q = s.segQuat.subarray(4 * ti, 4 * ti + 4);
    const up = qrot([q[0], q[1], q[2], q[3]], [0, 1, 0]);
    const upD: Vec3 = r ? qrot(orient(r.heading, r.pitch, r.roll), [0, 1, 0]) : [0, 1, 0];
    const tilt = Math.min(Math.acos(clamp(up[1], -1, 1)), Math.acos(clamp(up[0] * upD[0] + up[1] * upD[1] + up[2] * upD[2], -1, 1)));
    const knockTilt = clamp((tilt - S.tiltStart * T) / Math.max(1e-6, (S.tiltEnd - S.tiltStart) * T), 0, 1);
    // both feet off the turf: a sprint stride's flight is allowed, longer means the athlete was lifted or launched
    const footing = a.feet[0].touching || a.feet[1].touching, speed = Math.hypot(s.comVel[0], s.comVel[2]);
    a.airT = footing ? 0 : a.airT + dt;
    const knockAir = clamp((a.airT - (0.08 + 0.015 * speed)) / 0.15, 0, 1);
    // Lifted: an opponent driving up and under him carries part of his weight, so his feet (and their traction) unload.
    const knockLift = clamp((J[1] / SUP.window / (m * G) - LOW.liftStart) / (LOW.liftFull - LOW.liftStart), 0, 1);
    // Wrapped up, an athlete cannot keep his balance freely: the posture help drains while opponents hold him (one
    // arm takes it part way, two all the way), so the tackler's weight and pull bring him down unless he breaks free.
    let held = 0;
    // a hand on the ball he carries holds him as much as a hand on his jersey
    const onHim = (t: LinkRef | null) => !!t && (t.athlete === a.index || (t.athlete < 0 && this.ballCarrier === a.index && t.seg === this.ballIndex));
    for (const o of this.athletes) if (o !== a) for (const g of o.grips) if (g.active && onHim(g.target)) held++;
    a.heldT = held > 0 ? a.heldT + dt : Math.max(0, a.heldT - 2 * dt);
    const knockHeld = clamp((a.heldT - HELD.start * T) / (HELD.full * T), 0, 1) * (held >= 2 ? 1 : HELD.oneArm);
    // Held on to past that, his legs give: a balance controller alone would keep a wrapped athlete standing for
    // ever. Muscle tone drains (the stun's looseness) until he goes down or breaks free.
    if (held >= 2) a.stun = Math.max(a.stun, clamp((a.heldT - (HELD.start + HELD.full) * T) / (HELD.sag * T), 0, HELD.sagMax));
    // Untouched for a while (no contact, no hit still carrying him, nobody holding him) and not still knocked from
    // one, a tilt or a flight is his own running, cutting or leaning, never a knock: off contact the support keeps
    // him upright (design §6.5). One still off balance from a hit keeps stumbling until he has caught himself.
    a.freeT = a.playerContact ? 0 : a.freeT + dt;
    const own = a.freeT > SUP.free && a.hitMem <= 0 && a.heldT <= 0 && a.knock < 0.05 ? 0 : 1;
    // (his own jump's flight is no knock either, even just after a contact)
    const target = Math.min(1, Math.max(knockHit, own * knockTilt, r?.jump === 'flight' ? 0 : own * knockAir, knockDriven, knockLift, knockHeld));
    // rises fast, within a couple of steps on a big hit (the body goes as its impulse lands), decays slowly
    a.knock = target > a.knock ? a.knock + (target - a.knock) * Math.min(1, dt / (knockHit >= 1 ? SUP.bigRise : SUP.rise)) : Math.max(target, a.knock - dt * SUP.decay);
    const down = a.downBy !== null, clip = a.controller.debug?.().clip;
    if (clip === 'getup') {
      // posture support ramps back in with the get-up, while the body is actually rising (not falling back)
      if (s.segVel[3 * pi + 1] > -0.2) a.getup = Math.min(1, a.getup + dt / SUP.getup);
      a.knock = Math.min(a.knock, 1 - a.getup);
    } else {
      a.getup = 0;
      if (down) a.knock = 1;
    }
    // carry: off while touching another athlete; back after separation and stable footing
    if (a.playerContact) { a.carryLevel = 0; a.supStable = 0; }
    else {
      // stable footing: a step's brief flight does not count against it, a lifted or falling body does
      a.supStable = a.airT < 0.1 && !down && a.knock < 0.3 ? a.supStable + dt : 0;
      if (a.supStable >= SUP.stable) a.carryLevel = Math.min(1, a.carryLevel + dt / SUP.fadeIn);
    }
    const flight = clamp(1 - (a.airT - SUP.flight) / 0.1, 0, 1);
    a.support = { posture: down && clip !== 'getup' ? 0 : 1 - a.knock, carry: a.playerContact ? 0 : a.carryLevel * flight * (1 - a.knock), down };
    if (a.injury.out) { a.knock = 1; a.support = { posture: 0, carry: 0, down, out: true }; }
    if ('stun' in a.controller) a.controller.stun = a.stun;
  }

  /** Invisible posture/weight support. Vertical force and roll/pitch torque only — never horizontal force. */
  private applyAssist(a: Athlete) {
    const level = a.injury.out ? 0 : this.assist * a.assistLevel;
    if (level <= 0) return;
    const s = this.scene.athletes[a.index].state, m = a.mass, g = 9.81;
    if (!a.feet[0].touching && !a.feet[1].touching) return;
    const pi = a.segIndex.get('pelvis')!;
    const standY = a.plan.standHeight;
    const y = s.segPos[3 * pi + 1];
    // Fade support out as the pelvis drops toward the ground, so the assist never holds up a falling body.
    const w = Math.min(1, Math.max(0, (y - 0.45 * standY) / (0.3 * standY)));
    // At 100 % the assist carries at most half the body weight.
    this.scene.applyWrench(a.index, pi, [0, level * m * g * w * 0.5, 0], [0, 0, 0]);
    // Posture: pull pelvis and thorax "up" axes toward vertical (roll/pitch only), and damp roll/pitch rates.
    for (const name of ['pelvis', a.segIndex.has('thorax') ? 'thorax' : 'trunk']) {
      const i = a.segIndex.get(name)!;
      const q = s.segQuat.subarray(4 * i, 4 * i + 4);
      const upv = qrot([q[0], q[1], q[2], q[3]], [0, 1, 0]);
      const k = level * m * g * standY * 1.5, c = level * m * standY * standY * 1.2;
      const wx = s.segAngVel[3 * i], wz = s.segAngVel[3 * i + 2];
      // torque = k (up × ŷ) − c ω_horizontal
      this.scene.applyWrench(a.index, i, [0, 0, 0], [-k * upv[2] - c * wx, 0, k * upv[0] - c * wz]);
    }
  }

  private afterStep() {
    this.sense();
    for (const a of this.athletes) {
      this.updateInjury(a, this.dt);
      this.updateAssistFade(a, this.dt);
      if (this.supported(a)) this.updateSupport(a, this.dt);
      this.updateGrips(a, this.dt);
      this.updateHeadAccel(a, this.dt);
    }
    this.updateImpact(this.lastHitForce);
  }

  /** Read contacts: foot loads and centres of pressure, player contact, hand touches, down detection. */
  private sense() {
    for (const a of this.athletes) {
      a.feet.forEach((f) => { f.force = 0; f.cop = [0, 0, 0]; f.touching = false; });
      a.downBy = null; a.handTouch = [null, null];
      a.playerContactNow = false;
      a.touching = [];
      a.hitForce = [0, 0, 0];
    }
    let hit = 0;
    const pairs = new Map<string, HitEvent & { n: Vec3 }>();
    for (const c of this.scene.contacts()) {
      for (const [p, o] of [[c.a, c.b], [c.b, c.a]] as const) {
        if (p.athlete < 0) continue;
        const a = this.athletes[p.athlete];
        if (o.athlete < 0 && o.seg < 0) { // ground
          a.feet.forEach((f, k) => {
            if (a.footSegs[k].has(p.seg)) {
              f.cop = [f.cop[0] + c.pos[0] * c.force, f.cop[1] + c.pos[1] * c.force, f.cop[2] + c.pos[2] * c.force];
              f.force += c.force; f.touching = true;
            }
          });
          if (!a.limbEndSegs.has(p.seg)) a.downBy = a.plan.segments[p.seg].name;
        } else {
          if (o.athlete >= 0 && o.athlete !== p.athlete) { a.playerContactNow = true; if (!a.touching.includes(o.athlete)) a.touching.push(o.athlete); }
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
        const key = `${c.a.athlete}:${c.a.seg}:${c.b.athlete}:${c.b.seg}`;
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
      for (const f of a.feet) if (f.force > 0) f.cop = [f.cop[0] / f.force, f.cop[1] / f.force, f.cop[2] / f.force];
      a.playerContact = a.playerContactNow;
    }
  }

  // ---------------------------------------------------------------- injuries (design §6.6)
  /** Breaks and knockout from this step's loads. A broken joint's range gives way at the end that broke (the limb
   *  dangles past where it should stop), a broken arm goes limp and a broken leg weak (InjuryState.breakJoint); he
   *  plays on, hobbling or one-armed. A knockout, or both legs broken, puts him out of play for the rep. */
  private updateInjury(a: Athlete, dt: number) {
    const s = this.scene.athletes[a.index].state, inj = a.injury, at = (k: number): Vec3 => [s.dofAnchor[3 * k], s.dofAnchor[3 * k + 1], s.dofAnchor[3 * k + 2]];
    if (inj.out) inj.outFor += dt;
    for (const b of inj.checkBreaks(this.scene.limitTorques(a.index), s, a.playerContact, dt)) {
      this.breakJoint(a.index, b.joint, b.dof, b.end, b.relax);
      const j = a.plan.joints.find((x) => x.name === b.joint)!;
      this.injuries.push({ athlete: a.index, kind: 'break', joint: b.joint, what: b.what, seg: j.child, parentSeg: j.parent, pos: at(b.dof), load: b.load, time: this.time });
    }
    const hi = a.segIndex.get('head')!;
    if (inj.checkKo([s.segVel[3 * hi], s.segVel[3 * hi + 1], s.segVel[3 * hi + 2]], dt))
      this.injuries.push({ athlete: a.index, kind: 'ko', joint: 'head', what: 'ko', seg: 'head', parentSeg: a.plan.joints.find((x) => x.child === 'head')!.parent, pos: [s.segPos[3 * hi], s.segPos[3 * hi + 1], s.segPos[3 * hi + 2]], load: inj.peakDv, time: this.time });
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
   *  play, the rest lose tone over INJURY.fade (the hit's own load is still met by muscles that were braced for it). */
  private limp(a: Athlete) {
    const m = a.muscles, inj = a.injury, f = Math.min(1, inj.outFor / INJURY.fade), tone = inj.out ? 1 + ((inj.ko ? INJURY.koTone : INJURY.hurtTone) - 1) * f : 1;
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
    const want = [a.cmd.gripL || a.cmd.wrap || a.cmd.carry === 1, a.cmd.gripR || a.cmd.wrap || a.cmd.carry === 2].map((x, h) => x && !a.injury.arm[h]);
    for (const h of [0, 1] as const) {
      const g = a.grips[h];
      g.cooldown = Math.max(0, g.cooldown - dt);
      if (g.active) {
        // Grip force averaged over ~20 ms; breaks when it exceeds grip (or jersey) strength.
        const alpha = Math.min(1, dt / 0.02);
        g.force += (this.scene.gripForce(a.index, h) - g.force) * alpha;
        if (!want[h] || g.force > g.limit) {
          this.scene.gripOff(a.index, h);
          g.active = false;
          g.cooldown = want[h] ? 0.25 : 0;
        }
      } else if (want[h] && g.cooldown <= 0) {
        // a raised hand closes on a fistful of jersey (or a limb) within REACH.grab of it, not only on contact
        const near = !a.handTouch[h] && this.raised(a, h) ? this.nearestBody(a, this.handPoint(a, h), REACH.grab + a.handGeoms[h].half) : null;
        const t = a.handTouch[h] ?? (near && { athlete: near.athlete, seg: near.seg, pos: this.handPoint(a, h) });
        if (!t) continue;
        const tgtAth = t.athlete >= 0 ? this.athletes[t.athlete] : null;
        const segName = tgtAth ? tgtAth.plan.segments[t.seg].name : '';
        g.jersey = /thorax|lumbar|trunk|pelvis/.test(segName);
        g.limit = g.jersey ? Math.min(GRIP_ECC * a.plan.gripStrength, EQUIPMENT.jersey.tearStrength) : GRIP_ECC * a.plan.gripStrength;
        this.scene.gripOn(a.index, h, { athlete: t.athlete, seg: t.seg }, t.pos, g.jersey ? GRIP_TIMECONST.jersey : GRIP_TIMECONST.hand);
        g.active = true; g.force = 0; g.target = { athlete: t.athlete, seg: t.seg };
      }
    }
  }

  /** Drill rules only: a hand gripping something without a touch (the ball at rep start, or on a recovery). */
  attachGrip(ai: number, hand: 0 | 1, target: { athlete: number; seg: number }, point: Vec3) {
    const a = this.athletes[ai], g = a.grips[hand];
    this.scene.gripOn(ai, hand, target, point, GRIP_TIMECONST.hand);
    g.active = true; g.force = 0; g.jersey = false; g.limit = GRIP_ECC * a.plan.gripStrength; g.target = target;
  }

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
    const s = this.scene.athletes[a.index].state, sp: Vec3 = [s.segPos[3 * k], s.segPos[3 * k + 1], s.segPos[3 * k + 2]];
    const n = this.nearestBody(a, sp, REACH.aim);
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
        const q = quatAt(s.segQuat, k), org: Vec3 = [s.segPos[3 * k], s.segPos[3 * k + 1], s.segPos[3 * k + 2]];
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
    const s = this.scene.athletes[a.index].state, hi = a.segIndex.get('head')!;
    const v: Vec3 = [s.segVel[3 * hi], s.segVel[3 * hi + 1], s.segVel[3 * hi + 2]];
    const acc = Math.hypot(v[0] - a.headVelPrev[0], v[1] - a.headVelPrev[1] + 9.81 * dt * 0, v[2] - a.headVelPrev[2]) / dt;
    a.headVelPrev = v;
    // First-order low-pass at ~60 Hz: a filtered rigid-body estimate, not a sensor reading.
    const alpha = 1 - Math.exp(-2 * Math.PI * 60 * dt);
    a.headAccFilt += (acc - a.headAccFilt) * alpha;
    if (this.impact.firstContactTime >= 0) this.impact.peakHeadG[a.index] = Math.max(this.impact.peakHeadG[a.index], a.headAccFilt / 9.81);
  }

  private updateImpact(hit: number) {
    const n = Math.max(1, Math.round(0.01 / this.dt)); // 10 ms moving average
    this.forceWindow.push(hit);
    if (this.forceWindow.length > n) this.forceWindow.shift();
    const avg = this.forceWindow.reduce((x, y) => x + y, 0) / this.forceWindow.length;
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

const G = 9.81;
/** Reaching (design §6.5): gap between a raised hand's surface and an opponent's body (m) under which the hand
 *  closes on it (a fistful of jersey stands off the body by a few cm); distance from the shoulder within which
 *  the arm aims at the nearest part of that body (an arm's length and a lean: the eyes guide the hand), and how
 *  far inside its surface the aim point lies. A loose ball is aimed at from further (the body bends to it): its
 *  surface within `ball` m of the shoulder, taken as a sphere of radius `ballR`. */
const REACH = { grab: 0.07, aim: 0.9, into: 0.03, ball: 1.3, ballR: 0.1 };
const quatAt = (a: Float64Array, k: number): Quat => [a[4 * k], a[4 * k + 1], a[4 * k + 2], a[4 * k + 3]];
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
/** Muscle tone left to an athlete out of play (× all muscle output): knocked out (unconscious, assumption), or both
 *  legs broken and conscious (curled up on the turf, assumption), and how long the tone takes to go (s, assumption). */
const INJURY = { koTone: 0.2, hurtTone: 0.5, fade: 0.3 };
/** Orientation from heading, forward pitch and left roll (same convention as the hand controller). */
const orient = (heading: number, pitchFwd: number, rollLeft: number): Quat =>
  qmul(qaxis([0, 1, 0], heading), qmul(qaxis([1, 0, 0], pitchFwd), qaxis([0, 0, -1], rollLeft)));

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
