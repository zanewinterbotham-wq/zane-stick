// Rate-dependent breaks (owner item 2026-10-21): a held tug carries far more load before a joint gives than an impact.
import { describe, expect, it } from 'vitest';
import { BREAK, InjuryState } from '../src/sim/injury';
import type { MuscleSet } from '../src/sim/muscles';
import type { AthleteState } from '../src/sim/physics/engine';

const dt = 0.002, T = BREAK['knee.flex'].torque;
const ms = { names: ['kneeL.flex'], n: 1, lo: new Float64Array([-0.1]), hi: new Float64Array([2.5]) } as unknown as MuscleSet;
const s = { q: new Float64Array([-0.1]) } as unknown as AthleteState; // at the hyper-extension end

/** Seconds until the knee breaks under the limit torque `load(t)` over `seconds` (Infinity if it holds). */
function breakAt(load: (t: number) => number, seconds: number) {
  const inj = new InjuryState(ms, dt), lim = new Float64Array(1);
  for (let t = 0; t < seconds; t += dt) {
    lim[0] = load(t);
    if (inj.checkBreaks(lim, s, 0, dt).length) return t;
  }
  return Infinity;
}

describe('rate-dependent break tolerance', () => {
  it('a tug at 1.2 × the tolerance built over 0.5 s and held 2 s does not break; a 50 ms spike of that size does', () => {
    expect(breakAt((t) => 1.2 * T * Math.min(1, t / 0.5), 2.5)).toBe(Infinity);
    expect(breakAt((t) => (t < 0.05 ? 1.2 * T : 0), 0.5)).toBeLessThan(0.05);
  });
  it('a held load far beyond the tolerance (3.2 ×) still breaks', () => {
    expect(breakAt((t) => 3.2 * T * Math.min(1, t / 0.5), 2.5)).toBeLessThan(2.5);
  });
});
