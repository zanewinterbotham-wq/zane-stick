import { describe, expect, it } from 'vitest';
import { HandController } from '../src/sim/control/hand';

// Forward kinematics of the hip (flex → abd → internal rotation) and knee chain in the pelvis frame.
function ankle(L: { side: number; L1: number; L2: number }, flex: number, abd: number, knee: number, rot: number) {
  const A = L.L1 + L.L2 * Math.cos(knee), B = L.L2 * Math.sin(knee);
  const x = L.side * (A * Math.sin(abd) + B * Math.sin(rot) * Math.cos(abd)), y = B * Math.sin(rot) * Math.sin(abd) - A * Math.cos(abd), z = -B * Math.cos(rot);
  return [x, y * Math.cos(flex) + z * Math.sin(flex), -y * Math.sin(flex) + z * Math.cos(flex)];
}

describe('swing leg IK', () => {
  it('puts the ankle on target with a bent knee, abduction and hip rotation', () => {
    const legIK = (HandController.prototype as unknown as { legIK: (L: object, rel: number[], rot: number) => number[] }).legIK;
    let worst = 0;
    for (const side of [1, -1]) for (const flex of [-0.2, 0.3, 0.9]) for (const abd of [-0.3, 0.2, 0.7]) for (const knee of [0.2, 1.0, 1.6]) for (const rot of [-0.5, 0, 0.5]) {
      const L = { side, L1: 0.43, L2: 0.45 };
      const p = ankle(L, flex, abd, knee, rot);
      const [f, a, k] = legIK.call({}, L, p, rot);
      const q = ankle(L, f, a, k, rot);
      worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    expect(worst).toBeLessThan(0.005);
  });
});
