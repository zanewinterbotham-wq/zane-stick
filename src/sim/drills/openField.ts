// Open-field 1-on-1: the human tackles a bot ball carrier. Rep rules from the design doc: the rep ends when
// the carrier is down (any segment but hands/feet on the ground), out of bounds, scores, or time runs out.
import { DEFAULT_ATHLETE, type AthleteParams } from '../anatomy/body';
import { BALL } from '../anatomy/equipment';
import { DEFAULT_SUPPORT, type SupportSettings } from '../anim/types';
import { CarrierBrain, DIFFICULTY, type BotDifficulty } from '../brains/carrier';
import type { Brain } from '../brains/types';
import type { Gains } from '../control/hand';
import type { Gait } from '../control/types';
import { qaxis, qmul, qrot, type Quat, type Vec3 } from '../math';
import type { PhysicsEngine } from '../physics/engine';
import { Rng } from '../rng';
import { World, type AthleteSetup, type PhysicsSettings, type WorldSetup } from '../world';
import { makeController } from './controllers';

export type RepEnd = 'down' | 'out of bounds' | 'touchdown' | 'time' | null;
export interface OpenFieldConfig {
  physics: PhysicsSettings;
  assist: number;
  seed: number;
  human: AthleteParams;
  carrier: AthleteParams;
  difficulty: BotDifficulty;
  carrierGait: Gait;
  timeLimit: number;
  traction?: number;
  gains?: Partial<Gains>;
  /** Active-ragdoll support for both athletes; absent = old balance assist only. */
  support?: SupportSettings;
}
export const DEFAULT_OPEN_FIELD: Omit<OpenFieldConfig, 'physics'> = {
  assist: 0.2, seed: 1, human: DEFAULT_ATHLETE, carrier: { height: 1.80, mass: 98, strength: 1, speed: 1 },
  difficulty: DIFFICULTY.normal, carrierGait: 'jog', timeLimit: 10, support: DEFAULT_SUPPORT,
};

/** Controller factory applying tuned gains (same for human and bot: bots get no special treatment). */
const ctl = (cfg: OpenFieldConfig): AthleteSetup['controller'] => (p, m) => makeController(p, m, 'tracking', cfg.gains);

const HALF_WIDTH = (160 / 3) * 0.9144 / 2; // 24.38 m
const GOAL_Z = -50 * 0.9144;               // carrier runs toward −Z, the human's goal line

export class OpenFieldDrill {
  rep = 0;
  repStart = 0;
  ended: RepEnd = null;
  endTime = 0;
  /** Index of the ball in the world's props, and the carrier's athlete index. */
  readonly ball = 0;
  readonly carrier = 1;
  readonly human = 0;
  private constructor(public world: World, readonly cfg: OpenFieldConfig) {}

  static async create(engine: PhysicsEngine, cfg: OpenFieldConfig, humanBrain: Brain, rep = 0): Promise<OpenFieldDrill> {
    const rng = new Rng(cfg.seed * 7919 + rep * 104729);
    const hx = rng.range(-2, 2), cx = hx + rng.range(-3, 3), gap = rng.range(10, 14);
    const setup: WorldSetup = {
      physics: cfg.physics, seed: cfg.seed + rep, assist: cfg.assist, traction: cfg.traction,
      field: { halfWidth: HALF_WIDTH, goalZ: GOAL_Z, dirZ: -1 },
      athletes: [
        { params: cfg.human, pos: [hx, 0, 0], yaw: 0, team: 0, controller: ctl(cfg), brain: humanBrain },
        { params: cfg.carrier, pos: [cx, 0, gap], yaw: Math.PI, team: 1, controller: ctl(cfg), brain: new CarrierBrain(new Rng(rng.next() * 1e9), cfg.difficulty, cfg.carrierGait), hasBall: true },
      ],
      // ball parked under the field until the carrier has tucked his arm (setup only)
      props: [{ name: 'ball', shape: 'ellipsoid', size: [BALL.diameter / 2, BALL.diameter / 2, BALL.length / 2], mass: BALL.mass, pos: [cx, -5, gap], friction: 0.8 }],
      support: cfg.support && { ...cfg.support },
    };
    const world = await World.create(engine, setup);
    const d = new OpenFieldDrill(world, cfg);
    d.rep = rep;
    d.setup();
    return d;
  }

  /** Pre-roll: let both settle and the carrier tuck his arm, then put the ball in his hand and grip it. */
  private setup() {
    const w = this.world;
    const carrierBrain = w.athletes[this.carrier].brain;
    const saved = w.athletes[this.carrier].brain;
    // hold the carrier still while tucking: a brain that only carries
    (w.athletes[this.carrier] as { brain: Brain }).brain = { think: () => ({ ...saved.think({ ...w.perception(this.carrier), time: -1 }, w.dt), move: { x: 0, z: 0 } }) };
    for (let i = 0; i < Math.round(0.5 / w.dt); i++) w.step();
    (w.athletes[this.carrier] as { brain: Brain }).brain = carrierBrain;
    const a = w.athletes[this.carrier], s = w.scene.athletes[this.carrier].state;
    const hi = a.handSegs[1];
    const hp: Vec3 = [s.segCom[3 * hi], s.segCom[3 * hi + 1], s.segCom[3 * hi + 2]];
    const hq: Quat = [s.segQuat[4 * hi], s.segQuat[4 * hi + 1], s.segQuat[4 * hi + 2], s.segQuat[4 * hi + 3]];
    // ball sits in the palm (palm faces the body for the right hand: +X in hand frame), long axis along the forearm
    const palm = qrot(hq, [0.06, 0.02, 0]);
    const ballPos: Vec3 = [hp[0] + palm[0], hp[1] + palm[1], hp[2] + palm[2]];
    const ballQuat = qmul(hq, qaxis([1, 0, 0], Math.PI / 2));
    w.scene.placeProp(this.ball, ballPos, ballQuat);
    w.attachGrip(this.carrier, 1, { athlete: -1, seg: this.ball }, hp);
    this.repStart = w.time;
  }

  get repTime() { return this.world.time - this.repStart; }

  step() {
    if (this.ended) { this.world.step(); return; }
    this.world.step();
    const w = this.world, c = w.athletes[this.carrier], s = w.scene.athletes[this.carrier].state;
    if (c.downBy) this.end('down');
    else if (Math.abs(s.com[0]) > HALF_WIDTH) this.end('out of bounds');
    else if (s.com[2] < GOAL_Z) this.end('touchdown');
    else if (this.repTime > this.cfg.timeLimit) this.end('time');
  }

  private end(reason: RepEnd) { this.ended = reason; this.endTime = this.world.time; }

  destroy() { this.world.destroy(); }
}
