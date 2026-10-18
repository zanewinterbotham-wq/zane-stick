// Open-field 1-on-1: the human tackles a bot ball carrier. Rep rules: the rep ends only when whoever holds the
// ball is down (any segment but hands/feet on the ground) or reaches the end zone he attacks. A ball knocked
// loose stays live: any athlete recovers it by touching it with his trunk (diving on it), then attacks his own way.
import { DEFAULT_ATHLETE, type AthleteParams } from '../anatomy/body';
import { BALL } from '../anatomy/equipment';
import { DEFAULT_SUPPORT, type SupportSettings } from '../anim/types';
import { DIFFICULTY, type BotDifficulty } from '../brains/carrier';
import type { Brain } from '../brains/types';
import type { Gains } from '../control/hand';
import type { Gait } from '../control/types';
import { qaxis, qmul, qrot, type Quat, type Vec3 } from '../math';
import type { PhysicsEngine } from '../physics/engine';
import { Rng } from '../rng';
import { World, type AthleteSetup, type PhysicsSettings, type WorldSetup } from '../world';
import { makeCarrier, makeTackler } from './brains';
import { makeController } from './controllers';

export type RepEnd = 'down' | 'touchdown' | 'time' | null;
export interface OpenFieldConfig {
  physics: PhysicsSettings;
  assist: number;
  seed: number;
  human: AthleteParams;
  carrier: AthleteParams;
  difficulty: BotDifficulty;
  carrierGait: Gait;
  /** Safety timeout (s): reps end on a tackle or a score; this only stops a rep nobody finishes. */
  timeLimit: number;
  traction?: number;
  gains?: Partial<Gains>;
  /** Active-ragdoll support for both athletes; absent = old balance assist only. */
  support?: SupportSettings;
}
export const DEFAULT_OPEN_FIELD: Omit<OpenFieldConfig, 'physics'> = {
  assist: 0.2, seed: 1, human: DEFAULT_ATHLETE, carrier: { height: 1.80, mass: 98, strength: 1, speed: 1 },
  difficulty: DIFFICULTY.normal, carrierGait: 'jog', timeLimit: 60, support: DEFAULT_SUPPORT,
};

/** Controller factory applying tuned gains (same for human and bot: bots get no special treatment). */
const ctl = (cfg: OpenFieldConfig): AthleteSetup['controller'] => (p, m) => makeController(p, m, 'tracking', cfg.gains);

const HALF_WIDTH = (160 / 3) * 0.9144 / 2; // 24.38 m
/** Goal lines at ±50 yd. The bot (team 1) attacks −Z, the human's goal line behind his start; the human, once
 *  he has the ball, attacks +Z. */
export const GOAL_LINE = 50 * 0.9144;
const attackDir = (team: 0 | 1): 1 | -1 => (team === 1 ? -1 : 1);
/** Segments that recover a loose ball: the trunk ('trunk' is the minimum body's fused one). */
const TORSO = /^(pelvis|lumbar|thorax|trunk)$/;
/** Off the turf this long counts as up (s): a body lying on the turf flickers out of contact for a few steps. */
const UP_TIME = 0.5;

export class OpenFieldDrill {
  rep = 0;
  repStart = 0;
  ended: RepEnd = null;
  endTime = 0;
  /** Index of the ball in the world's props, the bot's athlete index (he starts with the ball), and the human's. */
  readonly ball = 0;
  readonly carrier = 1;
  readonly human = 0;
  /** Fumbles this rep, and who recovered the last one (−1: none yet). */
  fumbles = 0;
  recoveredBy = -1;
  /** The athlete who last lost the ball: he can recover it only once it has been clear of his body. */
  private fumbler = -1;
  private clear = false;
  /** How long the holder has been off the turf since he got the ball (s). Recovered on the ground (a dive), he is
   *  down only once an opponent touches him (down by contact) until he has been up UP_TIME, so he can get up and run. */
  private upT = UP_TIME;
  private readonly ballRef = { athlete: -1, seg: this.ball };

  /** `brains`: what each athlete thinks with; the world's brains delegate here, so the drill can swap the bot's. */
  private constructor(public world: World, readonly cfg: OpenFieldConfig, readonly brains: Brain[], private rng: Rng) {}

  static async create(engine: PhysicsEngine, cfg: OpenFieldConfig, humanBrain: Brain, rep = 0): Promise<OpenFieldDrill> {
    const rng = new Rng(cfg.seed * 7919 + rep * 104729);
    const hx = rng.range(-2, 2), cx = hx + rng.range(-3, 3), gap = rng.range(10, 14);
    const brains: Brain[] = [humanBrain, makeCarrier(new Rng(rng.next() * 1e9), cfg.difficulty, cfg.carrierGait)];
    // whoever holds the ball keeps it tucked in the right arm (a human's input has no carry button)
    const possess = (i: number): Brain => ({ think: (p, dt) => { const c = brains[i].think(p, dt); if (p.athletes[i].hasBall) c.carry = 2; return c; } });
    const setup: WorldSetup = {
      physics: cfg.physics, seed: cfg.seed + rep, assist: cfg.assist, traction: cfg.traction,
      field: { halfWidth: HALF_WIDTH, goalZ: attackDir(1) * GOAL_LINE, dirZ: attackDir(1) },
      athletes: [
        { params: cfg.human, pos: [hx, 0, 0], yaw: 0, team: 0, controller: ctl(cfg), brain: possess(0) },
        { params: cfg.carrier, pos: [cx, 0, gap], yaw: Math.PI, team: 1, controller: ctl(cfg), brain: possess(1), hasBall: true },
      ],
      // ball parked under the field until the carrier has tucked his arm (setup only)
      props: [{ name: 'ball', shape: 'ellipsoid', size: [BALL.diameter / 2, BALL.diameter / 2, BALL.length / 2], mass: BALL.mass, pos: [cx, -5, gap], friction: 0.8 }],
      support: cfg.support && { ...cfg.support },
    };
    const world = await World.create(engine, setup);
    const d = new OpenFieldDrill(world, cfg, brains, new Rng(rng.next() * 1e9));
    d.rep = rep;
    d.setup();
    return d;
  }

  /** Pre-roll: let both settle and the carrier tuck his arm, then put the ball in his hand and grip it. */
  private setup() {
    const w = this.world, carrier = this.brains[this.carrier];
    // hold the carrier still while tucking: a brain that only carries
    this.brains[this.carrier] = { think: (p, dt) => ({ ...carrier.think({ ...p, time: -1 }, dt), move: { x: 0, z: 0 } }) };
    for (let i = 0; i < Math.round(0.5 / w.dt); i++) w.step();
    this.brains[this.carrier] = carrier;
    this.tuck(this.carrier);
    this.repStart = w.time;
  }

  /** Put the ball in athlete ai's right hand and grip it (rep start, and a fumble recovery). */
  private tuck(ai: number) {
    const w = this.world, a = w.athletes[ai], s = w.scene.athletes[ai].state;
    const hi = a.handSegs[1], seg = a.plan.segments[hi];
    const hq: Quat = [s.segQuat[4 * hi], s.segQuat[4 * hi + 1], s.segQuat[4 * hi + 2], s.segQuat[4 * hi + 3]];
    // Ball against the palm (palm faces the body for the right hand: +X in hand frame), long axis along the hand,
    // gripped at the palm surface. Placed overlapping the hand, the contact pushed it out against the grip with
    // ~2 kN and broke the grip on the first steps of every rep. The gap clears the contact margin (5 mm), so the
    // grip carries only the ball's own load, not a squeeze against the hand.
    const g = seg.geoms.find((x) => x.role === 'hand' && x.type === 'box');
    const centre: Vec3 = g ? [g.pos![0] - seg.origin[0], g.pos![1] - seg.origin[1], g.pos![2] - seg.origin[2]] : [0, -0.05, 0];
    const half = g ? g.size[0] : 0.02;
    const at = (x: number): Vec3 => { const p = qrot(hq, [centre[0] + x, centre[1], centre[2]]); return [s.segPos[3 * hi] + p[0], s.segPos[3 * hi + 1] + p[1], s.segPos[3 * hi + 2] + p[2]]; };
    const ballQuat = qmul(hq, qaxis([1, 0, 0], Math.PI / 2));
    // On a recovery this moves the ball from under the trunk to the palm: the possession rule standing in for a
    // scoop the hands (no fingers) cannot do.
    w.scene.placeProp(this.ball, at(half + BALL.diameter / 2 + 0.008), ballQuat);
    w.attachGrip(ai, 1, this.ballRef, at(half));
    w.ballCarrier = ai;
    const dirZ = attackDir(a.setup.team);
    w.setup.field = { halfWidth: HALF_WIDTH, goalZ: dirZ * GOAL_LINE, dirZ };
  }

  get repTime() { return this.world.time - this.repStart; }

  step() {
    this.world.step();
    if (this.ended) return;
    const w = this.world, hi = w.ballCarrier;
    if (hi >= 0) {
      const a = w.athletes[hi], s = w.scene.athletes[hi].state;
      if (this.upT < UP_TIME) this.upT = a.downBy ? 0 : this.upT + w.dt;
      // checked before the grip: a ball that comes out on the step he lands was still held when he went down
      if (a.downBy && (this.upT >= UP_TIME || a.playerContact)) return this.end('down');
      if (w.gripping(hi, this.ballRef) < 0) this.fumble(hi);
      else if (s.com[2] * attackDir(a.setup.team) > GOAL_LINE) return this.end('touchdown');
    }
    if (w.ballCarrier < 0) this.loose();
    if (this.repTime > this.cfg.timeLimit) this.end('time');
  }

  private fumble(ai: number) {
    this.world.ballCarrier = -1;
    this.fumbler = ai; this.clear = false; this.fumbles++;
    if (ai === this.carrier) this.brains[this.carrier] = makeTackler(this.rng, this.cfg.difficulty);
  }

  /** Loose ball: hands cannot pick it up; the first trunk to touch it recovers it. */
  private loose() {
    const w = this.world;
    // grips form after the physics step, so one formed on the ball this step has not pulled on it yet
    w.athletes.forEach((_, i) => { const h = w.gripping(i, this.ballRef); if (h >= 0) w.releaseGrip(i, h as 0 | 1); });
    let by = -1, fumblerTouch = false;
    for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]] as const) {
      if (p.athlete >= 0 || p.seg !== this.ball || o.athlete < 0) continue;
      if (o.athlete === this.fumbler) fumblerTouch = true;
      if (by < 0 && TORSO.test(w.athletes[o.athlete].plan.segments[o.seg].name) && (o.athlete !== this.fumbler || this.clear)) by = o.athlete;
    }
    this.clear ||= !fumblerTouch;
    if (by < 0) return;
    this.tuck(by);
    this.recoveredBy = by; this.upT = 0;
    this.brains[this.carrier] = by === this.carrier ? makeCarrier(this.rng, this.cfg.difficulty, this.cfg.carrierGait) : makeTackler(this.rng, this.cfg.difficulty);
  }

  private end(reason: RepEnd) { this.ended = reason; this.endTime = this.world.time; }

  destroy() { this.world.destroy(); }
}
