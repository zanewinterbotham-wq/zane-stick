// Headless scenario helpers shared by physics tests and the tuning scripts.
import { DEFAULT_ATHLETE, type AthleteParams } from '../../src/sim/anatomy/body';
import { ScriptBrain } from '../../src/sim/brains/script';
import { HandController } from '../../src/sim/control/hand';
import type { Commands } from '../../src/sim/control/types';
import type { Perception } from '../../src/sim/brains/types';
import { mujocoEngine } from '../../src/sim/physics/mujoco';
import { World, type PhysicsSettings } from '../../src/sim/world';

export const STD: PhysicsSettings = { hz: 240, iterations: 30, detail: 'standard' };

export async function soloWorld(script: (t: number, p: Perception, c: Commands) => void, opts: { physics?: PhysicsSettings; assist?: number; params?: AthleteParams; seed?: number } = {}) {
  return World.create(mujocoEngine, {
    physics: opts.physics ?? STD, seed: opts.seed ?? 1, assist: opts.assist ?? 0.3,
    athletes: [{ params: opts.params ?? DEFAULT_ATHLETE, pos: [0, 0, 0], yaw: 0, team: 0, controller: (p, m) => new HandController(p, m), brain: new ScriptBrain(script) }],
  });
}

/** Pelvis height, torso tilt from vertical (rad), and horizontal COM speed of athlete i. */
export function metrics(w: World, i = 0) {
  const a = w.athletes[i], s = w.scene.athletes[i].state;
  const ti = a.segIndex.get('thorax') ?? a.segIndex.get('trunk')!;
  const q = s.segQuat.subarray(4 * ti, 4 * ti + 4);
  const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
  const pi = a.segIndex.get('pelvis')!;
  return { pelvisY: s.segPos[3 * pi + 1], tilt: Math.acos(Math.max(-1, Math.min(1, upY))), speed: Math.hypot(s.comVel[0], s.comVel[2]), com: s.com, vel: s.comVel, down: a.downBy };
}
