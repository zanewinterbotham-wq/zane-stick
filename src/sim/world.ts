// The simulation loop: brains → commands → motor controller → muscles → physics, at a fixed timestep.
// Runs unchanged in the browser, a Worker, or Node. No DOM, no wall clock, no Math.random.
import { buildBody, type AthleteParams, type BodyPlan, type Detail } from './anatomy/body';
import { GRIP_TIMECONST, EQUIPMENT } from './anatomy/equipment';
import type { Brain, Perception, AthleteView } from './brains/types';
import { neutralCommands, type BodyView, type Commands, type FootContact, type MotorController } from './control/types';
import { clamp, headingOf, qaxis, qconj, qlog, qmul, qrot, type Quat, type Vec3 } from './math';
import { MuscleSet, newTargets, type MuscleTargets } from './muscles';
import type { AthleteState, PhysicsEngine, PhysicsScene, PropDesc } from './physics/engine';
import { Rng } from './rng';
import { weightSupport, type SupportSettings, type SupportState } from './anim/types';

export interface PhysicsSettings { hz: number; iterations: number; detail: Detail }
export interface AthleteSetup {
  params: AthleteParams;
  pos: Vec3; yaw: number;
  team: 0 | 1;
  controller: (plan: BodyPlan, muscles: MuscleSet) => MotorController;
  brain: Brain;
  hasBall?: boolean;
}
export interface FieldInfo { halfWidth: number; goalZ: number; dirZ: 1 | -1 }
export interface WorldSetup { physics: PhysicsSettings; athletes: AthleteSetup[]; props?: PropDesc[]; seed: number; assist: number; field?: FieldInfo; traction?: number;
  /** Active-ragdoll support (design §6.5) for athletes whose controller has root(); absent = balance assist only. */
  support?: SupportSettings }

/** Balance assist timing [design §6.4]. */
const ASSIST_FADE_OUT = 0.15, ASSIST_STABLE_TIME = 0.3, ASSIST_FADE_IN = 0.3;
/** Support [design §6.5]: carry velocity gain (1/s), stable footing before the carry returns and its ramp (s),
 *  window for the impulse received (s), flight a stride may have before the carry fades (s), how fast knock
 *  decays (1/s), get-up ramp (s), pelvis height PD (1/s², 1/s), upright stiffness (m·g·h per rad), damping
 *  (m·h² per s), yaw relative to roll/pitch, the stun: knock impulse (in bigHits) where it starts and the
 *  further amount that makes it full, and its fade time (s); speed along the last big hit beyond the wanted one
 *  where the knock starts and where it is full (m/s), and how long that hit is remembered (s); and a dive
 *  take-off's velocity gain (1/s) and largest acceleration (m/s², about the ~1.5 g net a standing long-jump
 *  take-off reaches). */
const SUP = { kv: 6, stable: 0.3, fadeIn: 0.3, window: 0.2, flight: 0.15, decay: 1, getup: 1, hKp: 36, hKd: 10, kUp: 1.5, cUp: 6, yaw: 0.3,
  stunStart: 1, stunFull: 2, stunTime: 0.5, drivenStart: 0.5, drivenFull: 2, drivenTime: 1.5, launchKv: 20, launch: 15 };

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
  grips: { active: boolean; force: number; cooldown: number; jersey: boolean; limit: number }[] = [0, 1].map(() => ({ active: false, force: 0, cooldown: 0, jersey: false, limit: 0 }));
  /** Last contact per hand: target link and point, for grip forming. */
  handTouch: ({ athlete: number; seg: number; pos: Vec3 } | null)[] = [null, null];
  readonly segIndex: Map<string, number>;
  readonly footSegs: Set<number>[];
  readonly handSegs: number[];
  readonly limbEndSegs: Set<number>;
  headVelPrev: Vec3 = [0, 0, 0]; headAccFilt = 0;
  /** Support levels handed to the controller, and the fade state behind them (design §6.5). */
  support: SupportState = { posture: 1, carry: 1, down: false };
  knock = 0; carryLevel = 1; supStable = 0; airT = 0; getup = 0;
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

  constructor(readonly index: number, readonly setup: AthleteSetup, readonly plan: BodyPlan, readonly controller: MotorController, readonly brain: Brain) {
    this.muscles = new MuscleSet(plan);
    this.targets = newTargets(this.muscles.n);
    this.segIndex = new Map(plan.segments.map((s, i) => [s.name, i]));
    const idx = (n: string) => this.segIndex.get(n) ?? -1;
    this.footSegs = ['L', 'R'].map((sx) => new Set([idx('foot' + sx), idx('toes' + sx)].filter((i) => i >= 0)));
    this.handSegs = ['L', 'R'].map((sx) => (idx('hand' + sx) >= 0 ? idx('hand' + sx) : idx('forearm' + sx)));
    this.limbEndSegs = new Set([...this.footSegs[0], ...this.footSegs[1], ...this.handSegs]);
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
  ballCarrier = -1;

  private constructor(readonly scene: PhysicsScene, readonly setup: WorldSetup) {
    this.rng = new Rng(setup.seed);
    this.assist = setup.assist;
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
    return { plan: a.plan, muscles: a.muscles, state: this.scene.athletes[a.index].state, dt: this.dt, time: this.time, feet: a.feet, playerContact: a.playerContact, support: this.supported(a) ? a.support : undefined };
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
        heading: headingOf(fwd), down: a.downBy !== null, hasBall: a.index === this.ballCarrier,
      };
    });
    return { time: this.time, self, athletes, field: this.setup.field ?? { halfWidth: 24.38, goalZ: 50, dirZ: 1 } };
  }

  step() {
    const dt = this.dt;
    for (const a of this.athletes) {
      a.cmd = a.brain.think(this.perception(a.index), dt);
      a.controller.compute(this.view(a), a.cmd, a.targets);
      const s = this.scene.athletes[a.index].state;
      a.muscles.compute(a.targets, s.q, s.qd);
      this.scene.setTorques(a.index, a.muscles.torque);
      this.scene.setDamping(a.index, a.muscles.damping);
      if (this.supported(a)) this.applySupport(a); else this.applyAssist(a);
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
    const c = a.playerContact ? 0 : sup.carry * k;
    // dive take-off: the carry stands in for the push off the turf, so it needs a foot on it
    const launch = r.dive === 'launch' && (a.feet[0].touching || a.feet[1].touching);
    if (c > 0 && launch) {
      const f: Vec3 = [0, 1, 2].map((j) => m * SUP.launchKv * (r.vel[j] - s.comVel[j])) as Vec3, n = Math.hypot(...f), lim = m * SUP.launch;
      a.carryForce = f.map((x) => x * c * (n > lim ? lim / n : 1)) as Vec3;
    } else if (c > 0) {
      let fx = m * SUP.kv * (r.vel[0] - s.comVel[0]), fz = m * SUP.kv * (r.vel[2] - s.comVel[2]);
      const n = Math.hypot(fx, fz), lim = m * S.carryAccel;
      if (n > lim) { fx *= lim / n; fz *= lim / n; }
      a.carryForce = [fx * c, 0, fz * c];
    }
    const p = sup.posture * k;
    let fy = 0;
    // A dive loads and pushes off the athlete's own legs, and so does a hip thrust: the posture support leaves the
    // weight to them (the tracking controller's legShare), so it never lifts the athlete or what he drives.
    const ps = p * weightSupport(r);
    if (ps > 0) fy = clamp(ps * (S.weightShare * m * G + m * SUP.hKp * (r.height - s.segPos[3 * pi + 1]) - m * SUP.hKd * s.segVel[3 * pi + 1]), 0, 1.5 * ps * m * G);
    this.scene.applyWrench(a.index, pi, [a.carryForce[0], fy + a.carryForce[1], a.carryForce[2]], [0, 0, 0]);
    if (p <= 0) return;
    const H = a.plan.standHeight, kUp = p * SUP.kUp * m * G * H, cUp = 0.5 * p * SUP.cUp * m * H * H;
    // Damping acts on the whole body's rotation rate (angular momentum over inertia about the COM): a pelvis is too
    // light for explicit damping of its own spin at 240 Hz, and arm and leg swing leave the total untouched.
    const wb = bodyRate(a.plan, s);
    // the pelvis takes part of the trunk lean, the thorax all of it (as in the hand controller's attitude targets)
    for (const [name, f] of [['pelvis', 0.3], [a.segIndex.has('thorax') ? 'thorax' : 'trunk', 1]] as const) {
      const i = a.segIndex.get(name)!, q = s.segQuat.subarray(4 * i, 4 * i + 4);
      const e = qlog(qmul(orient(r.heading, f * r.pitch, f * r.roll), qconj([q[0], q[1], q[2], q[3]])));
      this.scene.applyWrench(a.index, i, [0, 0, 0], [kUp * e[0] - cUp * wb[0], SUP.yaw * (kUp * e[1] - cUp * wb[1]), kUp * e[2] - cUp * wb[2]]);
    }
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
    const Jknock = Math.min(Jh, m * Math.max(0, vAlong)), knockHit = Jknock / S.bigHit;
    // Stun: an athlete driven back hard loses muscle tone for a moment (the controller loosens), so the hit's
    // momentum goes through a limp-ish body instead of being caught by a stiff balance reaction.
    a.stun = Math.max(clamp((Jknock - SUP.stunStart * S.bigHit) / (SUP.stunFull * S.bigHit), 0, 1), a.stun - dt / SUP.stunTime);
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
    const knockTilt = clamp((tilt - S.tiltStart) / Math.max(1e-6, S.tiltEnd - S.tiltStart), 0, 1);
    // both feet off the turf: a sprint stride's flight is allowed, longer means the athlete was lifted or launched
    const footing = a.feet[0].touching || a.feet[1].touching, speed = Math.hypot(s.comVel[0], s.comVel[2]);
    a.airT = footing ? 0 : a.airT + dt;
    const knockAir = clamp((a.airT - (0.08 + 0.015 * speed)) / 0.15, 0, 1);
    const target = Math.min(1, Math.max(knockHit, knockTilt, knockAir, knockDriven));
    // rises fast, decays slowly
    a.knock = target > a.knock ? a.knock + (target - a.knock) * Math.min(1, dt / 0.02) : Math.max(target, a.knock - dt * SUP.decay);
    const down = a.downBy !== null, clip = a.controller.debug?.().clip;
    if (clip === 'getup') {
      // posture support ramps back in with the get-up, while the body is actually rising (not falling back)
      const pi = a.segIndex.get('pelvis')!;
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
    if ('stun' in a.controller) a.controller.stun = a.stun;
  }

  /** Invisible posture/weight support. Vertical force and roll/pitch torque only — never horizontal force. */
  private applyAssist(a: Athlete) {
    const level = this.assist * a.assistLevel;
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
          if (o.athlete >= 0 && o.athlete !== p.athlete) a.playerContactNow = true;
          const hand = a.handSegs.indexOf(p.seg);
          if (hand >= 0 && (o.athlete !== p.athlete)) a.handTouch[hand] = { athlete: o.athlete, seg: o.seg, pos: c.pos };
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

  private updateAssistFade(a: Athlete, dt: number) {
    const footing = a.feet[0].touching || a.feet[1].touching;
    if (a.playerContact) { a.assistLevel = Math.max(0, a.assistLevel - dt / ASSIST_FADE_OUT); a.stableTimer = 0; return; }
    if (a.assistLevel < 1) {
      a.stableTimer = footing && a.downBy === null ? a.stableTimer + dt : 0;
      if (a.stableTimer >= ASSIST_STABLE_TIME) a.assistLevel = Math.min(1, a.assistLevel + dt / ASSIST_FADE_IN);
    }
  }

  private updateGrips(a: Athlete, dt: number) {
    const want = [a.cmd.gripL || a.cmd.wrap || a.cmd.carry === 1, a.cmd.gripR || a.cmd.wrap || a.cmd.carry === 2];
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
      } else if (want[h] && g.cooldown <= 0 && a.handTouch[h]) {
        const t = a.handTouch[h]!;
        const tgtAth = t.athlete >= 0 ? this.athletes[t.athlete] : null;
        const segName = tgtAth ? tgtAth.plan.segments[t.seg].name : '';
        g.jersey = /thorax|lumbar|trunk|pelvis/.test(segName);
        g.limit = g.jersey ? Math.min(GRIP_ECC * a.plan.gripStrength, EQUIPMENT.jersey.tearStrength) : GRIP_ECC * a.plan.gripStrength;
        this.scene.gripOn(a.index, h, { athlete: t.athlete, seg: t.seg }, t.pos, g.jersey ? GRIP_TIMECONST.jersey : GRIP_TIMECONST.hand);
        g.active = true; g.force = 0;
      }
    }
  }

  /** Setup only: start a rep with a hand already gripping something (e.g. the carrier holding the ball). */
  attachGrip(ai: number, hand: 0 | 1, target: { athlete: number; seg: number }, point: Vec3) {
    const a = this.athletes[ai], g = a.grips[hand];
    this.scene.gripOn(ai, hand, target, point, GRIP_TIMECONST.hand);
    g.active = true; g.force = 0; g.jersey = false; g.limit = GRIP_ECC * a.plan.gripStrength;
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
/** A grip pulled open loads the finger flexors eccentrically, which hold ~1.5× their isometric (dynamometer)
 *  force; at 1× tacklers' wraps and the carrier's ball grip let go of loads a hand really holds. */
const GRIP_ECC = 1.5;
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
