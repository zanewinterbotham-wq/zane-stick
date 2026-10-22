// Every Tuning-panel group (sim/tuning.ts tuned()): its defaults survive the merge unchanged (so they sit inside their
// ranges), the game's values do too, and junk is dropped or clamped to the range.
import { expect, it } from 'vitest';
import { JUMP_RANGES, jumpTuning } from '../src/sim/anim/jump';
import { QB_RANGES, qbTuning } from '../src/sim/brains/football/qbTuning';
import { CATCH_RANGES, catchTuning } from '../src/sim/modes/catching';
import { FUMBLE_RANGES, fumbleTuning } from '../src/sim/fumble';
import { GRAB_RANGES, grabTuning } from '../src/sim/grab';
import { HIT_RANGES, hitTuning } from '../src/sim/hits';
import { BONE_RANGES, boneTuning, KO_RANGES, koTuning } from '../src/sim/injury';
import { GAME_TUNING } from '../src/game/settings';

const GROUPS: [keyof typeof GAME_TUNING, Record<string, readonly number[]>, (o: any) => object][] = [ // (any: jumpTuning takes a typed partial)
  ['jump', JUMP_RANGES, jumpTuning], ['qb', QB_RANGES, qbTuning], ['catching', CATCH_RANGES, catchTuning], ['fumble', FUMBLE_RANGES, fumbleTuning],
  ['grab', GRAB_RANGES, grabTuning], ['contact', HIT_RANGES, hitTuning], ['bones', BONE_RANGES, boneTuning], ['knockout', KO_RANGES, koTuning],
];

it.each(GROUPS)('%s: defaults and game values pass unchanged, junk is clamped or dropped', (key, ranges, tune) => {
  const d = tune(undefined) as Record<string, number>;
  expect(Object.keys(d).sort()).toEqual(Object.keys(ranges).sort());
  expect(tune(d)).toEqual(d);
  expect(tune(GAME_TUNING[key])).toEqual(GAME_TUNING[key]);
  const k = Object.keys(d);
  expect(tune(Object.fromEntries(k.map((n) => [n, 1e9])))).toEqual(Object.fromEntries(k.map((n) => [n, ranges[n][1]])));
  expect(tune(Object.fromEntries(k.map((n) => [n, -1e9])))).toEqual(Object.fromEntries(k.map((n) => [n, ranges[n][0]])));
  expect(tune({ ...Object.fromEntries(k.map((n, i) => [n, [NaN, 'x', null, Infinity][i % 4]])), bogus: 1 })).toEqual(d);
  expect(tune('junk')).toEqual(d);
});
