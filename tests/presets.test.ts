// The quality ladder (src/game/presets.ts): what each level keeps from today's presets, and the Advanced overrides.
import { expect, it } from 'vitest';
import { cleanPerf, effectivePreset, PERF_KNOBS, PRESET_ORDER, PRESETS } from '../src/game/presets';

it('the ladder: every level once, lowest first; Low and High are today\'s physics, Ultra is High\'s exactly', () => {
  expect([...PRESET_ORDER].sort()).toEqual(Object.keys(PRESETS).sort());
  expect(PRESETS.minimum.physics).toEqual({ hz: 240, iterations: 20, detail: 'minimum' });
  expect(PRESETS.high.physics).toEqual({ hz: 480, iterations: 40, detail: 'standard' });
  expect(PRESETS.ultra.physics).toEqual(PRESETS.high.physics);
  // the approximations only below Low
  for (const n of PRESET_ORDER.slice(1)) expect(Object.keys(PRESETS[n].physics).sort()).toEqual(['detail', 'hz', 'iterations']);
  // the physics cost never rises down the ladder
  const cost = (n: (typeof PRESET_ORDER)[number]) => PRESETS[n].physics.hz * (PRESETS[n].physics.detail === 'standard' ? 1.3 : 1);
  for (let k = 1; k < PRESET_ORDER.length; k++) expect(cost(PRESET_ORDER[k])).toBeGreaterThanOrEqual(cost(PRESET_ORDER[k - 1]));
});

it('overrides change single knobs; Far bots 0 switches the level of detail off; unknown or bad values are dropped', () => {
  const p = effectivePreset('potato', { hz: 240, lod: 0, shadows: true });
  expect([p.physics.hz, 'lod' in p.physics, p.physics.cone, p.render.shadows, p.render.maxFps, p.worker]).toEqual([240, false, 'pyramidal', true, 30, true]);
  expect(effectivePreset('high').physics).toEqual(PRESETS.high.physics);
  expect(effectivePreset(null).name).toBe('minimum');
  expect(cleanPerf({ hz: 123, tolerance: 1e-5, cone: 'square', faces: 999, x: 1 })).toEqual({ tolerance: 1e-5, faces: 999 });
  expect(cleanPerf('nope')).toEqual({});
  for (const k of PERF_KNOBS) expect(k.choices.length).toBeGreaterThan(1);
});
