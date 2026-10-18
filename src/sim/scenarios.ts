// Named scenarios shared by headless tests, benchmarks and the browser dev view.
import { DEFAULT_ATHLETE, type AthleteParams, type BodyPlan } from './anatomy/body';
import { DEFAULT_SUPPORT, type SupportSettings } from './anim/types';
import { ScriptBrain } from './brains/script';
import { HandController } from './control/hand';
import { TrackingController } from './control/tracking';
import type { Commands, Gait } from './control/types';
import type { Perception } from './brains/types';
import type { MuscleSet } from './muscles';
import type { PhysicsSettings, WorldSetup, World } from './world';

export interface Scenario {
  setup: WorldSetup;
  /** Called before every world step (e.g. to apply a push). */
  onStep?: (w: World) => void;
  duration: number;
}

const solo = (physics: PhysicsSettings, assist: number, script: (t: number, p: Perception, c: Commands) => void, params: AthleteParams = DEFAULT_ATHLETE): WorldSetup => ({
  physics, seed: 1, assist,
  athletes: [{ params, pos: [0, 0, 0], yaw: 0, team: 0, controller: (p, m) => new HandController(p, m), brain: new ScriptBrain(script) }],
});

export function standScenario(physics: PhysicsSettings, assist = 0): Scenario {
  return { setup: solo(physics, assist, () => {}), duration: 60 };
}

/** Shove the thorax for 0.1 s at t = 1 s. dirDeg 0 = forward (+Z), 90 = to the athlete's left (+X). */
export function pushScenario(physics: PhysicsSettings, dirDeg: number, impulse: number, assist = 0): Scenario {
  const dir = [Math.sin((dirDeg * Math.PI) / 180), 0, Math.cos((dirDeg * Math.PI) / 180)];
  return {
    setup: solo(physics, assist, () => {}), duration: 4,
    onStep: (w) => {
      if (w.time < 1 || w.time >= 1.1) return;
      const a = w.athletes[0], th = a.segIndex.get('thorax') ?? a.segIndex.get('trunk')!;
      const F = impulse / 0.1;
      w.scene.applyWrench(0, th, [dir[0] * F, 0, dir[2] * F], [0, 0, 0]);
    },
  };
}

/** Accelerate along +Z with a gait, optionally cutting 45° to the left at `cutAt` seconds. */
export function runScenario(physics: PhysicsSettings, gait: Gait, opts: { assist?: number; cutAt?: number; duration?: number; params?: AthleteParams } = {}): Scenario {
  return {
    setup: solo(physics, opts.assist ?? 0, (t, _p, c) => {
      if (t < 0.5) return;
      c.gait = gait;
      const cut = opts.cutAt !== undefined && t > opts.cutAt;
      c.move = cut ? { x: Math.SQRT1_2, z: Math.SQRT1_2 } : { x: 0, z: 1 };
    }, opts.params),
    duration: opts.duration ?? 8,
  };
}

// ---- active ragdoll (design §6.5): tracking controller + world support

const tracked = (p: BodyPlan, m: MuscleSet) => new TrackingController(p, m);

/** One supported athlete running along +Z with a gait (null = stand), optionally cutting 45° left at `cutAt` s. */
export function supportRunScenario(physics: PhysicsSettings, gait: Gait | null, opts: { cutAt?: number; duration?: number; params?: AthleteParams; support?: SupportSettings } = {}): Scenario {
  return {
    setup: {
      physics, seed: 1, assist: 0, support: opts.support ?? { ...DEFAULT_SUPPORT },
      athletes: [{
        params: opts.params ?? DEFAULT_ATHLETE, pos: [0, 0, 0], yaw: 0, team: 0, controller: tracked,
        brain: new ScriptBrain((t, _p, c) => {
          if (gait === null || t < 0.5) return;
          c.gait = gait;
          c.move = opts.cutAt !== undefined && t > opts.cutAt ? { x: Math.SQRT1_2, z: Math.SQRT1_2 } : { x: 0, z: 1 };
        }),
      }],
    },
    duration: opts.duration ?? 10,
  };
}

/** Ball carrier sprinting straight for the goal at +Z against a tackler who sprints at him and hits low and hard
 *  (a collision for physics tests: the CarrierBrain jukes a straight-line tackler, so it would not give one). */
export function carrierVsTacklerScenario(physics: PhysicsSettings, opts: { carrier?: AthleteParams; tackler?: AthleteParams; seed?: number; gap?: number; support?: SupportSettings } = {}): Scenario {
  const seed = opts.seed ?? 1, gap = opts.gap ?? 14;
  const tackler = new ScriptBrain((t, p, c) => {
    const me = p.athletes[p.self], ball = p.athletes[1 - p.self];
    if (me.down || t < 0.3) return;
    const dx = ball.com[0] - me.com[0], dz = ball.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1;
    c.gait = 'sprint'; c.move = { x: dx / d, z: dz / d };
    if (d < 2.5) { c.contactMode = true; c.sink = 0.6; c.lean.fwd = 0.4; c.driveLegs = 1; c.shoot = true; c.wrap = d < 1.2; }
  });
  return {
    setup: {
      physics, seed, assist: 0, support: opts.support ?? { ...DEFAULT_SUPPORT },
      field: { halfWidth: 24.38, goalZ: 50, dirZ: 1 },
      athletes: [
        { params: opts.carrier ?? DEFAULT_ATHLETE, pos: [0, 0, 0], yaw: 0, team: 0, controller: tracked, brain: new ScriptBrain((_t, _p, c) => { c.gait = 'sprint'; c.move = { x: 0, z: 1 }; c.carry = 2; }), hasBall: true },
        { params: opts.tackler ?? DEFAULT_ATHLETE, pos: [0, 0, gap], yaw: Math.PI, team: 1, controller: tracked, brain: tackler },
      ],
    },
    duration: 6,
  };
}
