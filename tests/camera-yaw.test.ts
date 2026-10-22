import { describe, expect, it } from 'vitest';
import { autoYaw } from '../src/game/camera';

const run = (yaw: number, f: (t: number) => [number, number, number, number], secs: number) => {
  for (let i = 0; i < secs * 60; i++) { const [h, vx, vz, hr] = f(i / 60); yaw = autoYaw(yaw, h, vx, vz, hr, 1 / 60); }
  return yaw;
};

describe('auto camera yaw', () => {
  it('ignores a spin while the travel direction is steady', () => {
    // running along +Z at 6 m/s while the body spins 4*pi rad/s: view stays on the travel direction
    const yaw = run(0, (t) => [4 * Math.PI * t, 0, 6, 4 * Math.PI], 1);
    expect(Math.abs(yaw)).toBeLessThan(0.05);
  });
  it('follows travel direction when running a new way', () => {
    expect(run(0, () => [0, 6, 0, 0], 1)).toBeCloseTo(Math.PI / 2, 1);
  });
  it('follows facing when nearly stopped', () => {
    expect(run(0, () => [1, 0, 0, 0], 3)).toBeCloseTo(1, 1);
  });
});
