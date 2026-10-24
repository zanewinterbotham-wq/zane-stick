// The hit-impulse and impact-force windows are ring buffers now: they must give exactly (bit for bit) what the
// push/shift arrays gave, so the physics hashes (bench/perf/sim.ts, realism suite) do not move.
import { beforeAll, expect, it } from 'vitest';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { collide, technique } from './helpers/contact';
import type { Vec3 } from '../src/sim/math';
import { DEFAULT_SUPPORT } from '../src/sim/anim/types';

beforeAll(() => mujocoEngine.init());

it('hit impulse sum and peak impact force match the array algorithm exactly', async () => {
  const ref: { win: Vec3[]; J: Vec3 }[] = [], force: number[] = [];
  let peak = 0, steps = 0, hitSteps = 0;
  await collide({ speed: 6, script: technique.upright }, { speed: 6, script: technique.upright }, 1, { hz: 240, iterations: 30, detail: 'standard' }, 0.8, { support: { ...DEFAULT_SUPPORT },
    onStep: (w) => {
      if (w.steps === 0) return; // onStep runs before each step: it sees the previous step's loads
      const dt = w.dt, sup = (w as unknown as { sup: { window: number } }).sup;
      const n = Math.max(1, Math.round(sup.window / dt)), m = Math.max(1, Math.round(0.01 / dt));
      w.athletes.forEach((a, i) => {
        const r = (ref[i] ??= { win: [], J: [0, 0, 0] }), f = a.hitForce;
        const jn: Vec3 = [f[0] * dt, f[1] * dt, f[2] * dt];
        r.win.push(jn); for (let k = 0; k < 3; k++) r.J[k] += jn[k];
        if (r.win.length > n) { const o = r.win.shift()!; for (let k = 0; k < 3; k++) r.J[k] -= o[k]; }
        expect(Array.from(a.hitImpulse)).toEqual(r.J);
      });
      force.push(w.lastHitForce); if (force.length > m) force.shift();
      peak = Math.max(peak, force.reduce((x, y) => x + y, 0) / force.length);
      expect(w.impact.peakForce).toBe(peak);
      steps++; if (w.lastHitForce > 0) hitSteps++;
    },
  });
  expect(steps).toBeGreaterThan(100);
  expect(hitSteps).toBeGreaterThan(10); // the windows were fed real contacts, and rolled over (n < steps)
});
