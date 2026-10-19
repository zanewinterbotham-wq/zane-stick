// Kick coverage and return assignments, measured headlessly: on a kickoff the cover men run down in their lanes
// (spaced across the field until the catch, not bunched on the ball), the contain men stay outside the returner, the
// safety (the kicker) trails behind the coverage, and the return blockers get hands on cover men.
import { beforeAll, describe, expect, it } from 'vitest';
import { CoverBrain } from '../src/sim/brains/cover';
import type { Brain } from '../src/sim/brains/types';
import { neutralCommands } from '../src/sim/control/types';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { coverLanes } from '../src/sim/modes/kicks';
import { Play } from '../src/sim/modes/play';
import { modeById, resolveOptions } from '../src/sim/modes/registry';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier };

/** The human's role played by the bot brain the play would give him, swapped when the role changes. */
function autoHuman(get: () => Play | null): Brain {
  let cur: Brain | null = null, at = -1;
  return { think(p, dt) {
    const play = get();
    if (!play) return neutralCommands();
    if (!cur || p.time - at > 0.25) { const b = play.roleBrain(0); if (!cur || b.constructor !== cur.constructor) cur = b; at = p.time; }
    return cur.think(p, dt);
  } };
}

describe('coverage assignments (pure)', () => {
  it('the outermost cover men contain, the rest keep lanes, the kicker is the safety', () => {
    const P = (team: 0 | 1, x: number) => ({ team, pos: [x, 0] as [number, number] });
    const lanes = coverLanes([P(0, 4), P(0, 0), P(0, -13), P(0, 13), P(0, -4), P(1, 0)], 0, 1);
    expect(lanes.map((l) => l?.role)).toEqual(['lane', 'safety', 'contain', 'contain', 'lane', undefined]);
    expect(lanes[2]!.x).toBe(-13);
  });
});

describe('kickoff coverage (headless)', () => {
  it('cover men keep their lanes until the catch, contain stays outside the returner, blockers engage', async () => {
    const def = modeById('kickoff');
    let play: Play | null = null;
    play = await Play.create(mujocoEngine, CFG, def, { ...resolveOptions(def), cover: 4, block: 3 }, autoHuman(() => play), 1);
    const w = play.world, cover = [0, 2, 3, 4], blockers = [6, 7, 8], R = 5;
    const xs = () => cover.map((i) => w.scene.athletes[i].state.com[0]).sort((a, b) => a - b);
    let minGap = Infinity, caught = -1, outside = 0, inside = 0, safetyGap = NaN;
    const engaged = new Set<number>();
    const all = coverLanes(play.mode.players, 0, 1), lanes = cover.map((i) => all[i]!);
    while (!play.ended && play.repTime < 15) {
      play.step();
      const bc = w.ballCarrier, com = (i: number) => w.scene.athletes[i].state.com;
      if (play.repTime > 1 && caught < 0) { const x = xs(); for (let k = 1; k < x.length; k++) minGap = Math.min(minGap, x[k] - x[k - 1]); }
      if (bc === R && caught < 0) caught = play.repTime;
      for (const i of blockers) if (w.athletes[i].touching.some((k) => play!.team(k) === 0)) engaged.add(i);
      if (bc !== R) continue;
      // the safety's depth behind the coverage when its first man gets to the returner (within 8 m)
      const dR = (i: number) => Math.hypot(com(i)[0] - com(R)[0], com(i)[2] - com(R)[2]), first = Math.min(...cover.map(dR));
      if (Number.isNaN(safetyGap) && first < 8) safetyGap = dR(1) - first;
      cover.forEach((i, k) => {
        const b = play!.brains[i];
        if (lanes[k].role !== 'contain' || !(b instanceof CoverBrain) || b.released) return;
        if (Math.sign(lanes[k].x) * (com(i)[0] - com(R)[0]) > 0) outside++; else inside++;
      });
    }
    console.log(`kickoff 4 v 3+1: caught ${caught.toFixed(2)} s (the safety ${safetyGap.toFixed(1)} m behind the first man there), closest lanes ${minGap.toFixed(1)} m apart before the catch, contain outside ${outside} / inside ${inside} steps, blockers engaged ${[...engaged]}, ${play.ended} "${play.verdict}"`);
    expect(caught).toBeGreaterThan(0);
    expect(minGap).toBeGreaterThan(4); // the old coverage ran at the ball and bunched
    expect(safetyGap).toBeGreaterThan(5);
    expect(outside).toBeGreaterThan(0);
    expect(inside / (outside + inside)).toBeLessThan(0.1);
    expect(engaged.size).toBeGreaterThanOrEqual(2);
    expect(w.scene.stats().instabilities).toBe(0);
    play.destroy();
  }, 120_000);
});
