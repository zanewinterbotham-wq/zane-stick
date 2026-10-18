// The simulation loop: brains → commands → motor controller → muscles → physics, at a fixed timestep.
// Runs unchanged in the browser, a Worker, or Node. No DOM, no wall clock, no Math.random.
import { buildBody, type AthleteParams, type BodyPlan, type Detail } from './anatomy/body';
import { GRIP_TIMECONST, EQUIPMENT } from './anatomy/equipment';
import type { Brain, Perception, AthleteView } from './brains/types';
import { neutralCommands, type BodyView, type Commands, type FootContact, type MotorController } from './control/types';
import { headingOf, qrot, type Quat, type Vec3 } from './math';
import { MuscleSet, newTargets, type MuscleTargets } from './muscles';
import type { PhysicsEngine, PhysicsScene, PropDesc } from './physics/engine';
import { Rng } from './rng';

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
export interface WorldSetup { physics: PhysicsSettings; athletes: AthleteSetup[]; props?: PropDesc[]; seed: number; assist: number; field?: FieldInfo; traction?: number }

/** Balance assist timing [design §6.4]. */
const ASSIST_FADE_OUT = 0.15, ASSIST_STABLE_TIME = 0.3, ASSIST_FADE_IN = 0.3;

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
    w.sense(); // contacts at t = 0, so controllers see their feet on the ground from the first step
    return w;
  }

  get dt() { return this.scene.dt; }

  view(a: Athlete): BodyView {
    return { plan: a.plan, muscles: a.muscles, state: this.scene.athletes[a.index].state, dt: this.dt, time: this.time, feet: a.feet, playerContact: a.playerContact };
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
      this.applyAssist(a);
    }
    this.scene.step();
    this.time += dt; this.steps++;
    this.afterStep();
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
    }
    let hit = 0;
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
      if (c.a.athlete >= 0 && c.b.athlete >= 0 && c.a.athlete !== c.b.athlete) hit += c.force;
    }
    this.lastHitForce = hit;
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
        g.limit = g.jersey ? Math.min(a.plan.gripStrength, EQUIPMENT.jersey.tearStrength) : a.plan.gripStrength;
        this.scene.gripOn(a.index, h, { athlete: t.athlete, seg: t.seg }, t.pos, g.jersey ? GRIP_TIMECONST.jersey : GRIP_TIMECONST.hand);
        g.active = true; g.force = 0;
      }
    }
  }

  /** Setup only: start a rep with a hand already gripping something (e.g. the carrier holding the ball). */
  attachGrip(ai: number, hand: 0 | 1, target: { athlete: number; seg: number }, point: Vec3) {
    const a = this.athletes[ai], g = a.grips[hand];
    this.scene.gripOn(ai, hand, target, point, GRIP_TIMECONST.hand);
    g.active = true; g.force = 0; g.jersey = false; g.limit = a.plan.gripStrength;
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
