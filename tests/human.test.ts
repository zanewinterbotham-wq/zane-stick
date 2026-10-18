import { describe, expect, it } from 'vitest';
import { HumanBrain, type HumanInput } from '../src/sim/brains/human';
import type { AthleteView, Perception } from '../src/sim/brains/types';

const view = (x: number, z: number, heading = 0): AthleteView => ({ com: [x, 1, z], comVel: [0, 0, 0], pelvis: [x, 1, z], head: [x, 1.8, z], heading, down: false, hasBall: false });
const perceive = (carrier: AthleteView): Perception => ({ time: 0, self: 0, athletes: [view(0, 0), { ...carrier, hasBall: true }], field: { halfWidth: 24, goalZ: 50, dirZ: 1 } });
const input = (o: Partial<HumanInput> = {}): HumanInput => ({ move: { x: 0, y: 1 }, torso: 0, sprint: 0, sink: 0, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0, ...o });

describe('HumanBrain', () => {
  it('switches contact mode on near a target ahead, with hysteresis, and off behind or far', () => {
    const b = new HumanBrain();
    b.latest = input();
    expect(b.think(perceive(view(0, 4.5))).contactMode).toBe(false);
    const c = b.think(perceive(view(0, 3.5)));
    expect(c.contactMode).toBe(true);
    expect(c.sink).toBeGreaterThan(0);                                // ready stance
    expect(b.think(perceive(view(0, 4.5))).contactMode).toBe(true);   // inside the off limit
    expect(b.think(perceive(view(0, 5.5))).contactMode).toBe(false);
    expect(b.think(perceive(view(0, -2))).contactMode).toBe(false);   // behind
  });

  it('thrust overrides sink and torso; an arm button raises and grips toward the camera aim', () => {
    const b = new HumanBrain();
    b.latest = input({ sink: 1, torso: 1, held: new Set(['thrust']) });
    let c = b.think(perceive(view(0, 3)));
    expect([c.thrustHips, c.sink, c.lean.fwd]).toEqual([true, 0, 0]);
    b.latest = input({ armL: 1, cameraYaw: Math.PI / 2, aimPitch: 0.3 });
    c = b.think(perceive(view(0, 20)));
    expect([c.armL, c.gripL, c.armR, c.gripR]).toEqual([1, true, 0, false]);
    expect(c.aim![0]).toBeGreaterThan(1);                              // camera looks along +X
    expect(c.aim![1]).toBeGreaterThan(1.5);                            // aimed above level
  });
});
