// Named scenarios shared by headless tests, benchmarks and the browser dev view.
import { DEFAULT_ATHLETE, type AthleteParams } from './anatomy/body';
import { ScriptBrain } from './brains/script';
import { HandController } from './control/hand';
import type { Commands, Gait } from './control/types';
import type { Perception } from './brains/types';
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
