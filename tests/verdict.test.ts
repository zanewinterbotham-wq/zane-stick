// Result words from each side (multiplayer: a player on team 1 lost Sumo and was told he won). The mode words the
// result for a team from state every screen has, so a guest's replica words it for his own side.
import { beforeAll, describe, expect, it } from 'vitest';
import { ScriptBrain } from '../src/sim/brains/script';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { Play, type RepEnd } from '../src/sim/modes/play';
import { modeById, resolveOptions } from '../src/sim/modes/registry';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier, seed: 1 };

async function ended(id: string, reason: Exclude<RepEnd, null>, scorer: 0 | 1) {
  const def = modeById(id), p = await Play.create(mujocoEngine, CFG, def, resolveOptions(def), new ScriptBrain(() => {}), 0);
  p.end(reason, scorer, 1);
  const words = [p.verdictFor(0), p.verdictFor(1)];
  p.destroy();
  return words;
}

describe('result words from each side', () => {
  it('Sumo, Scramble, Goal-Line Stand and Keep Away tell the loser he lost and the winner he won', async () => {
    expect(await ended('sumo', 'sumo', 1)).toEqual(['You are out of the ring', 'Ring cleared: you win']);
    expect(await ended('sumo', 'sumo', 0)).toEqual(['Ring cleared: you win', 'You are out of the ring']);
    expect(await ended('scramble', 'recovered', 1)).toEqual(['They won the scramble', 'You won the scramble']);
    const [def, off] = await ended('goalline', 'touchdown', 1);
    expect([def, off]).toEqual(['Touchdown: they got in', 'Touchdown! You got in']);
    const [d2, o2] = await ended('goalline', 'time', 0);
    expect(d2).toMatch(/^Goal-line stand!/); expect(o2).toMatch(/^They held/);
    const [k0, k1] = await ended('keepaway', 'stripped', 1);
    expect([k0, k1]).toEqual(['The ball was taken', 'You took the ball']);
  }, 120_000);

  it('a kick mode words the spot from each side (the tee is team 0\'s 35)', async () => {
    const [w0, w1] = await ended('kickoff', 'down', 0);
    expect(w0).toMatch(/at your 35$/); expect(w1).toMatch(/at their 35$/);
  }, 60_000);
});
