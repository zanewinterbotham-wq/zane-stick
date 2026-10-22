import { describe, expect, it } from 'vitest';
import { frontAim } from '../src/sim/anim/procedural';

// root frame: y up, z forward; side 1 (left arm) has +x outward
describe('frontAim: a reach behind the back goes round the outside', () => {
  it('leaves targets in front alone (across the body too)', () => {
    expect(frontAim([0.3, 0.1, 0.5], 1)).toEqual([0.3, 0.1, 0.5]);
    expect(frontAim([-0.4, 0, 0.5], 1)).toEqual([-0.4, 0, 0.5]);
  });
  it('a target straight behind takes the arm out to its own side at the same height', () => {
    expect(frontAim([0, 0.2, -1], 1)).toEqual([1, 0.2, 0]);
    expect(frontAim([0, 0.2, -1], -1)).toEqual([-1, 0.2, 0]);
  });
  it('anywhere behind: never behind the frontal plane, never across the body', () => {
    for (const side of [1, -1]) for (let a = Math.PI + 0.05; a < 2 * Math.PI; a += 0.1) {
      const p = frontAim([Math.cos(a), 0.2, Math.sin(a)], side);
      expect(p[2]).toBe(0);
      expect(side * p[0]).toBeGreaterThan(0);
    }
  });
  it('is continuous as a same-side target swings from beside to behind', () => {
    const a = frontAim([1, 0, 1e-9], 1), b = frontAim([1, 0, -1e-9], 1);
    expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeLessThan(1e-6);
  });
});
