// Special-teams modes: each kick play runs headlessly to an outcome with the solver stable, and the kick rules score
// as the NFL would: a kick that comes down in the receivers' end zone is a touchback, the kicking team downs a punt it
// gets to first, a return can score, a kick that hits a rusher is blocked and stays live, a field goal is good only
// through the uprights above the crossbar.
import { beforeAll, describe, expect, it } from 'vitest';
import { ScriptBrain } from '../src/sim/brains/script';
import type { Brain } from '../src/sim/brains/types';
import { neutralCommands, type Commands } from '../src/sim/control/types';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { FIELD_GOAL_BLOCK, fieldGoal } from '../src/sim/modes/fieldGoalBlock';
import { lob, ownYard, POST, yardLine } from '../src/sim/modes/kicks';
import { Play } from '../src/sim/modes/play';
import { modeById, resolveOptions } from '../src/sim/modes/registry';
import { END_LINE, GOAL_LINE, YD } from '../src/sim/modes/rules';
import type { ModeDef, ModeOptions } from '../src/sim/modes/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier };
const SPECIAL = ['kickoffReturn', 'kickoff', 'puntReturn', 'puntBlock', 'fieldGoalBlock'];

/** The human's role played by the bot brain the play would give him (as the preview pictures do), swapped when the
 *  role changes. */
function autoHuman(get: () => Play | null): Brain {
  let cur: Brain | null = null, at = -1;
  return { think(p, dt) {
    const play = get();
    if (!play) return neutralCommands(); // the pre-roll, before the play exists
    if (!cur || p.time - at > 0.25) { const b = play.roleBrain(0); if (!cur || b.constructor !== cur.constructor) cur = b; at = p.time; }
    return cur.think(p, dt);
  } };
}
const script = (fn: (c: Commands) => void) => new ScriptBrain((_t, _p, c) => fn(c));
/** Jogs off toward the sideline, out of the kick's way. */
const aside = () => script((c) => { c.move = { x: 1, z: 0 }; c.gait = 'jog'; });

async function run(def: ModeDef, opts: ModeOptions = {}, human?: Brain, rep = 0) {
  let play: Play | null = null;
  play = await Play.create(mujocoEngine, CFG, def, { ...resolveOptions(def), ...opts }, human ?? autoHuman(() => play), rep);
  const events: string[] = [];
  let bc = play.world.ballCarrier;
  while (!play.ended) {
    play.step();
    if (play.world.ballCarrier !== bc) { bc = play.world.ballCarrier; events.push(`${play.repTime.toFixed(2)} s ${bc < 0 ? 'loose' : `held by ${bc}`} at ${yardLine(play.ballPos()[2])}`); }
  }
  console.log(`${def.id} ${JSON.stringify(opts)}: ${play.ended} at ${play.repTime.toFixed(2)} s, "${play.verdict}", ${play.points} points to ${play.scorer}, ball at ${yardLine(play.ballPos()[2])} | ${events.join(' | ')}`);
  expect(play.world.scene.stats().instabilities, def.id).toBe(0);
  return play;
}

describe('special teams (pure)', () => {
  it('yard lines from your side, own yard lines per team, and a lob lands where and when it should', () => {
    expect(ownYard(0, 35)).toBeCloseTo(-15 * YD);
    expect(ownYard(1, 35)).toBeCloseTo(15 * YD);
    expect([yardLine(ownYard(0, 27)), yardLine(0), yardLine(ownYard(1, 40)), yardLine(-GOAL_LINE - 1)]).toEqual(['your 27', 'the 50', 'their 40', 'your end zone']);
    const v = lob(50, 4, 0.1, [0, -1]), T = 4;
    expect(v[2] * T).toBeCloseTo(-50);
    expect(0.1 + v[1] * T - 9.81 * T * T / 2).toBeCloseTo(0);
  });
});

describe('special teams (headless)', () => {
  it('every kick mode plays to an outcome with its default options', async () => {
    for (const id of SPECIAL) {
      const p = await run(modeById(id));
      expect(p.ended, id).not.toBe('time');
      p.destroy();
    }
  }, 300_000);

  it('a kickoff through the end zone, or a punt that comes down in it, is a touchback', async () => {
    const ko = await run(modeById('kickoffReturn'), { distance: 75 }, aside());
    expect(ko.ended).toBe('touchback');
    expect(ko.points).toBe(0);
    ko.destroy();
    const punt = await run(modeById('puntReturn'), { los: 50, distance: 60 }, aside());
    expect(punt.ended).toBe('touchback');
    punt.destroy();
  }, 120_000);

  it('a punt nobody fields is downed where the kicking team takes it (it may not advance it)', async () => {
    const p = await run(modeById('puntReturn'), {}, aside());
    expect(p.ended).toBe('downed');
    expect(p.team(p.world.ballCarrier)).toBe(1);
    expect(p.scorer).toBe(-1);
    p.destroy();
  }, 120_000);

  it('a return the coverage cannot stop is a touchdown: six points to the returning team', async () => {
    // the kicker alone against four blockers (a long return is chaotic: two blockers break it only sometimes)
    const p = await run(modeById('kickoffReturn'), { block: 4, cover: 1 });
    expect(p.ended).toBe('touchdown');
    expect([p.scorer, p.points]).toEqual([0, 6]);
    expect(p.ballPos()[2]).toBeGreaterThan(GOAL_LINE);
    p.destroy();
  }, 120_000);

  it('a punt that gets off untouched is away; one a rusher gets to is blocked and stays a live ball', async () => {
    const away = await run(modeById('puntBlock'), {}, script(() => {}));
    expect(away.ended).toBe('punt');
    away.destroy();
    // nobody protects the punter and he is slow to kick: the rushers get to the ball
    const blocked = await run(modeById('puntBlock'), { protect: 0, kickTime: 3 });
    expect(blocked.verdict).toMatch(/^Blocked!/);
    expect(blocked.ended).not.toBe('punt');
    expect(blocked.team(blocked.recoveredBy)).toBe(0); // live: a rusher picked it up
    blocked.destroy();
  }, 120_000);

  it('a field goal is good through the uprights above the crossbar, no good wide of them, and live when blocked', async () => {
    const aimed = (aim: number): ModeDef => ({ ...FIELD_GOAL_BLOCK, setup: (o, rng) => fieldGoal(o, rng, aim) });
    const good = await run(aimed(0), {}, script(() => {}));
    const at = good.ballPos(); // the play ends on the step the ball crosses the end line's plane
    expect(good.ended).toBe('fieldgoal');
    expect([good.scorer, good.points]).toEqual([1, 3]);
    expect(at[2]).toBeLessThanOrEqual(-END_LINE);
    expect(Math.abs(at[0])).toBeLessThan(POST.halfGap);
    expect(at[1]).toBeGreaterThan(POST.crossbar);
    good.destroy();
    const wide = await run(aimed(0.15), {}, script(() => {}));
    expect(wide.ended).toBe('nogood');
    expect(wide.points).toBe(0);
    wide.destroy();
    const blocked = await run(FIELD_GOAL_BLOCK, { protect: 0 });
    expect(blocked.verdict).toMatch(/^Blocked!/);
    expect(['fieldgoal', 'nogood']).not.toContain(blocked.ended);
    blocked.destroy();
  }, 120_000);
});
