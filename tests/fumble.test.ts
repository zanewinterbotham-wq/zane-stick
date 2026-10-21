// Fumble tuning (fumble.ts): the knobs reach the ball grip only, validated like every tuning group.
import { beforeAll, expect, it } from 'vitest';
import { fumbleTuning, FUMBLE_DEFAULTS } from '../src/sim/fumble';
import { IdleBrain } from '../src/sim/brains/idle';
import { MODES } from '../src/sim/modes/registry';
import { Play } from '../src/sim/modes/play';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { Rng } from '../src/sim/rng';
import { CFG } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

it('stored values are validated: unknown keys and non-numbers dropped, numbers clamped', () => {
  expect(fumbleTuning({ hold: 99, window: 'x', junk: 1 })).toEqual({ ...FUMBLE_DEFAULTS, hold: 10 });
  expect(fumbleTuning(null)).toEqual(FUMBLE_DEFAULTS);
});

it('Ball security scales the carrier\'s grip on the ball, nothing else', async () => {
  const carry = MODES.find((m) => m.id === 'carry')!;
  const limit = async (hold: number) => {
    const p = await Play.create(mujocoEngine, { ...CFG, fumble: { hold } }, carry, {}, new IdleBrain(new Rng(1)), 0);
    const w = p.world, a = w.athletes[w.ballCarrier], g = a.grips.find((x) => x.active && w.isBall(x.target))!;
    const v = g.limit; p.destroy(); return v;
  };
  const base = await limit(1);
  expect(await limit(3)).toBeCloseTo(base * 3, 6);
});
