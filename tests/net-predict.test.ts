// A multiplayer guest's prediction of his own athlete (game/net/session.ts Predictor): it answers his input at once,
// stays bounded, drains to the host's pose when steady, and fades or snaps away where physics is the host's.
import { describe, expect, it } from 'vitest';
import type { HumanInput } from '../src/sim/brains/human';
import { Predictor } from '../src/game/net/session';

const input = (y: number, sprint = 0): HumanInput => ({ move: { x: 0, y }, torso: 0, sprint, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0 });
const LEAD = 0.25, DT = 1 / 120, BOUND = (9 * LEAD * LEAD) / 2 + 1e-3; // decel·lead²/2

/** Run `p` for `secs` with `i`, returning the largest |shift| seen and the last one. */
function run(p: Predictor, t0: number, secs: number, i: HumanInput | null, weight = 1, snap = false) {
  let max = 0, t = t0;
  for (; t < t0 + secs - 1e-9; t += DT) max = Math.max(max, Math.hypot(...p.update(t, i, LEAD, weight, snap)));
  return { max, off: [...p.off], t };
}

describe('guest prediction', () => {
  it('standing still with no input shows the host pose', () => {
    const p = new Predictor();
    expect(run(p, 0, 1, input(0)).max).toBe(0);
  });

  it('a start moves him the way he asked at once, bounded, then drains back to the host pose', () => {
    const p = new Predictor();
    const early = run(p, 0, 0.1, input(1, 1)); // camera yaw 0: forward is +z
    expect(early.off[1]).toBeGreaterThan(0.005);
    expect(Math.abs(early.off[0])).toBeLessThan(1e-9);
    const all = run(p, early.t, 3, input(1, 1)); // sprinting steadily: the host has caught up
    expect(Math.max(early.max, all.max)).toBeLessThan(BOUND);
    expect(Math.hypot(...all.off)).toBeLessThan(1e-3);
    // letting go: he stops before the host shows it (shift backward), then drains again
    const stop = run(p, all.t, 0.15, input(0));
    expect(stop.off[1]).toBeLessThan(-0.01);
    expect(stop.max).toBeLessThan(BOUND);
    expect(Math.hypot(...run(p, stop.t, 3, input(0)).off)).toBeLessThan(1e-3);
  });

  it('fades over ~100 ms where physics is the host\'s, and snaps on host contact', () => {
    const p = new Predictor();
    const a = run(p, 0, 0.2, input(1, 1));
    const shown = Math.hypot(...a.off);
    expect(shown).toBeGreaterThan(0.02);
    const half = run(p, a.t, 0.05, input(1, 1), 0); // weight 0 (an opponent near): blending out, not jumping
    expect(Math.hypot(...half.off)).toBeLessThan(shown);
    expect(Math.hypot(...half.off)).toBeGreaterThan(0.05 * shown);
    expect(Math.hypot(...run(p, half.t, 0.4, input(1, 1), 0).off)).toBeLessThan(1e-3);
    const q = new Predictor();
    const b = run(q, 0, 0.2, input(1, 1));
    expect(q.update(b.t, input(1, 1), LEAD, 0, true)).toEqual([0, 0]); // contact: snapped
  });
});
