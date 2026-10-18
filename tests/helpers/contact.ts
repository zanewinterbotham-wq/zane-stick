// Contact scenarios for the realism contract: two athletes start moving at each other (initial velocity is
// test setup only), their brains issue ordinary Commands, physics decides. Judged on rates over many runs.
import { DEFAULT_ATHLETE, type AthleteParams } from '../../src/sim/anatomy/body';
import { ScriptBrain } from '../../src/sim/brains/script';
import { HandController } from '../../src/sim/control/hand';
import type { Commands } from '../../src/sim/control/types';
import type { Perception } from '../../src/sim/brains/types';
import { mujocoEngine } from '../../src/sim/physics/mujoco';
import { Rng } from '../../src/sim/rng';
import { World, type PhysicsSettings } from '../../src/sim/world';

export interface Side { params?: AthleteParams; speed: number; script: (t: number, c: Commands) => void }
export interface Outcome { aDown: boolean; bDown: boolean; aBack: number; bBack: number; peakForce: number }

/** A at z = −gap/2 facing +Z, B at +gap/2 facing −Z; both moving toward each other. */
export async function collide(a: Side, b: Side, seed: number, physics: PhysicsSettings, seconds = 2): Promise<Outcome> {
  const rng = new Rng(seed);
  const gap = 1.6 + rng.range(-0.1, 0.1), lateral = rng.range(-0.08, 0.08);
  const brain = (s: Side) => new ScriptBrain((t: number, _p: Perception, c: Commands) => s.script(t, c));
  const w = await World.create(mujocoEngine, {
    physics, seed, assist: 0,
    athletes: [
      { params: a.params ?? DEFAULT_ATHLETE, pos: [0, 0, -gap / 2], yaw: 0, team: 0, controller: (p, m) => new HandController(p, m), brain: brain(a) },
      { params: b.params ?? DEFAULT_ATHLETE, pos: [lateral, 0, gap / 2], yaw: Math.PI, team: 1, controller: (p, m) => new HandController(p, m), brain: brain(b) },
    ],
  });
  const va = a.speed * (1 + rng.range(-0.05, 0.05)), vb = b.speed * (1 + rng.range(-0.05, 0.05));
  w.scene.setInitialVelocity(0, [0, 0, va]);
  w.scene.setInitialVelocity(1, [0, 0, -vb]);
  let contactZ: number | null = null;
  for (let i = 0, n = Math.round(seconds / w.dt); i < n; i++) {
    w.step();
    if (contactZ === null && w.lastHitForce > 0) contactZ = (w.scene.athletes[0].state.com[2] + w.scene.athletes[1].state.com[2]) / 2;
  }
  const za = w.scene.athletes[0].state.com[2], zb = w.scene.athletes[1].state.com[2];
  const cz = contactZ ?? 0;
  const out = { aDown: !!w.athletes[0].downBy, bDown: !!w.athletes[1].downBy, aBack: cz - za, bBack: zb - cz, peakForce: w.impact.peakForce };
  w.destroy();
  return out;
}

/** Common technique scripts (only body-part Commands, as a human would press). */
export const technique = {
  lowDrive: (t: number, c: Commands) => { c.contactMode = true; c.move = { x: 0, z: 1 }; c.gait = 'sprint'; c.driveLegs = 1; c.sink = 0.8; c.lean.fwd = 0.5; if (t > 0.1) c.shoot = true; },
  upright: (_t: number, c: Commands) => { c.move = { x: 0, z: 1 }; c.gait = 'jog'; },
  wrapLow: (t: number, c: Commands) => { c.contactMode = true; c.move = { x: 0, z: 1 }; c.gait = 'jog'; c.sink = 0.7; c.lean.fwd = 0.4; c.driveLegs = 1; if (t > 0.15) c.wrap = true; },
  armHigh: (_t: number, c: Commands) => { c.contactMode = true; c.move = { x: 0, z: 1 }; c.gait = 'walk'; c.armL = 1; c.armR = 1; },
  carry: (_t: number, c: Commands) => { c.move = { x: 0, z: 1 }; c.gait = 'jog'; c.carry = 2; },
};
