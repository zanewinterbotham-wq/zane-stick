// Athlete level of detail (the Potato level, PhysicsSettings.lod): far from play a bot re-plans every other step, a
// player's athlete always plans, and every body is simulated on every step either way.
import { beforeAll, expect, it } from 'vitest';
import { ScriptBrain } from '../src/sim/brains/script';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { Play } from '../src/sim/modes/play';
import { modeById, resolveOptions } from '../src/sim/modes/registry';
import { mujocoEngine } from '../src/sim/physics/mujoco';

beforeAll(() => mujocoEngine.init());

it('far bots plan every other step, the player every step; every body keeps moving under its muscles', async () => {
  const def = modeById('kickoffReturn'), { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
  const human = new ScriptBrain((_t, _p, c) => { c.gait = 'jog'; c.move = { x: 0, z: 1 }; });
  const d = await Play.create(mujocoEngine, { ...base, bot: carrier, physics: { hz: 200, iterations: 20, detail: 'minimum', lod: 12 } }, def, resolveOptions(def, { block: 7, cover: 9 }), human);
  const w = d.world, plans = w.athletes.map(() => 0), moved = w.athletes.map(() => 0);
  w.athletes.forEach((a, i) => { const c = a.controller, f = c.compute.bind(c); c.compute = (...x) => { plans[i]++; f(...x); }; });
  const q0 = w.scene.athletes.map((a) => Float64Array.from(a.state.q));
  const n = 200;
  for (let k = 0; k < n; k++) d.step();
  w.scene.athletes.forEach((a, i) => (moved[i] = a.state.q.reduce((s, q, j) => s + Math.abs(q - q0[i][j]), 0)));
  expect(plans[d.human]).toBe(n);
  // at the kick most of the field is far from the ball and from every opponent
  const halved = plans.filter((p) => p <= 0.6 * n).length;
  expect(halved).toBeGreaterThan(w.athletes.length / 3);
  expect(Math.min(...plans)).toBeGreaterThanOrEqual(n / 2 - 1);
  for (const m of moved) expect(m).toBeGreaterThan(0);
  expect(w.scene.stats().instabilities).toBe(0);
  d.destroy();
});
