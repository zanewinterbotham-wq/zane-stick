import { describe, expect, it } from 'vitest';
import { HumanBrain, type HumanInput } from '../src/sim/brains/human';
import type { AthleteView, Perception } from '../src/sim/brains/types';

const view = (z: number, vz = 0, team: 0 | 1 = 1): AthleteView => ({ com: [0, 1, z], comVel: [0, 0, vz], pelvis: [0, 1, z], head: [0, 1.8, z], heading: 0, down: false, hasBall: team === 1, team });
const perceive = (me: AthleteView, him: AthleteView): Perception => ({ time: 0, self: 0, athletes: [me, him], field: { halfWidth: 24, goalZ: 50, dirZ: 1 } });
const input = (armL: number, armR: number): HumanInput => ({ move: { x: 0, y: 1 }, torso: 0, sprint: 0, armL, armR, held: new Set(), cameraYaw: 0, aimPitch: 0 });

describe('HumanBrain auto wrap', () => {
  it('both arm buttons near an opponent wrap him (arms at his hips, facing him); one arm or far away does not', () => {
    const b = new HumanBrain();
    b.latest = input(1, 1);
    let c = b.think(perceive(view(0, 0, 0), view(1)));
    expect([c.wrap, c.gripL, c.gripR, c.aim![2]]).toEqual([true, true, true, 1]);
    expect(c.face).toEqual({ x: 0, z: 1 });
    c = b.think(perceive(view(0, 0, 0), view(3)));                     // 3 m, standing still: not yet
    expect([c.wrap, c.aim![2]]).toEqual([false, 1.5]);           // arms at the camera aim instead
    c = b.think(perceive(view(0, 8, 0), view(2, -4)));                 // 2 m closing at 12 m/s: 0.17 s to contact
    expect([c.wrap, c.aim![2], c.face]).toEqual([false, 2, { x: 0, z: 1 }]);
    b.latest = input(1, 0);
    expect(b.think(perceive(view(0, 0, 0), view(1))).wrap).toBe(false);
  });
});
