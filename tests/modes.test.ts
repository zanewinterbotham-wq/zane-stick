// The game-mode framework and the shared NFL-style rules: the registry is well formed, options validate, and the
// rules end plays as the NFL would (no penalties): the ball breaking the plane scores, out of bounds, safeties,
// touchbacks, down by contact. Headless plays use small test modes written with the same API as the real ones.
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BALL } from '../src/sim/anatomy/equipment';
import { ScriptBrain } from '../src/sim/brains/script';
import type { Brain } from '../src/sim/brains/types';
import type { Commands } from '../src/sim/control/types';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { Play } from '../src/sim/modes/play';
import { MODES, resolveOptions } from '../src/sim/modes/registry';
import { deadBall, END_LINE, GOAL_LINE, HALF_WIDTH, inOwnEndZone, NFL, outside, scores } from '../src/sim/modes/rules';
import type { BallStart, ModeDef, PlayerSpec } from '../src/sim/modes/types';
import type { Vec3 } from '../src/sim/math';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { Rng } from '../src/sim/rng';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier };

describe('registry', () => {
  it('every mode has a unique id, a preview picture, valid defaults and the human on team 0', () => {
    expect(new Set(MODES.map((m) => m.id)).size).toBe(MODES.length);
    for (const m of MODES) {
      expect(existsSync(`public/${m.preview}`), m.preview).toBe(true);
      const o = resolveOptions(m);
      for (const d of m.options) expect(o[d.id]).toBe(d.default);
      const s = m.setup(o, new Rng(1), CFG);
      expect(s.players.length).toBe(m.athletes(o));
      expect(s.players[0].team).toBe(0);
      if ('holder' in s.ball) expect(s.ball.holder).toBeLessThan(s.players.length);
    }
  });

  it('stored options are validated: out of range clamps to the step, wrong types and unknown choices fall back', () => {
    const carry = MODES.find((m) => m.id === 'carry')!, ok = MODES.find((m) => m.id === 'oklahoma')!;
    expect(resolveOptions(carry, { tacklers: 9, blockers: 1.4, outOfBounds: 'yes', timeLimit: 33 })).toEqual({ tacklers: 3, blockers: 1, outOfBounds: false, timeLimit: 35 });
    expect(resolveOptions(ok, { role: 'quarterback', width: -2 })).toEqual({ role: 'defender', width: 3, outOfBounds: true });
  });
});

describe('rules (pure)', () => {
  it('the ball breaking the plane scores; the end zone a team defends is the one its opponents score in', () => {
    expect(scores(NFL, 0, GOAL_LINE + 0.01)).toBe(true);
    expect(scores(NFL, 0, GOAL_LINE - 0.01)).toBe(false);
    expect(scores(NFL, 1, -GOAL_LINE - 0.01)).toBe(true);
    expect(inOwnEndZone(NFL, 0, -GOAL_LINE - 1)).toBe(true);
    expect(inOwnEndZone(NFL, 1, -GOAL_LINE - 1)).toBe(false);
    expect(outside(NFL, HALF_WIDTH, 0)).toBe(true);
    expect(outside(NFL, 0, -END_LINE)).toBe(true);
    expect(outside(NFL, HALF_WIDTH - 0.01, END_LINE - 0.01)).toBe(false);
  });

  it('dead in his own end zone: touchback when the opponents put it there, else safety; elsewhere down or out', () => {
    expect(deadBall(NFL, 0, -50, true, 'down')).toEqual({ end: 'touchback', scorer: -1 });
    expect(deadBall(NFL, 0, -50, false, 'down')).toEqual({ end: 'safety', scorer: 1 });
    expect(deadBall(NFL, 1, 50, false, 'out')).toEqual({ end: 'safety', scorer: 0 });
    expect(deadBall(NFL, 0, 10, false, 'down')).toEqual({ end: 'down', scorer: -1 });
    // a loose ball the offense put out of the opponents' end zone is a touchback for them
    expect(deadBall(NFL, 0, 56, false, 'out')).toEqual({ end: 'touchback', scorer: -1 });
  });
});

type Script = (t: number, c: Commands, p: Parameters<Brain['think']>[0]) => void;
const script = (fn: Script) => new ScriptBrain((t, p, c) => fn(t, c, p));
/** A one-off mode: the given players and ball on a regulation field (out of bounds on), bots driven by `bots`. */
const testMode = (players: PlayerSpec[], ball: BallStart, bots: Brain[] = []): ModeDef => ({
  id: 'test', title: 'Test', pitch: '', preview: '', options: [], athletes: () => players.length,
  setup: () => ({ players, ball, rules: { ...NFL, timeLimit: 15 }, brain: (_p, i) => bots[i - 1] ?? script(() => {}) }),
});
async function play(def: ModeDef, human: Brain) { return Play.create(mujocoEngine, CFG, def, {}, human, 0); }
function run(p: Play, seconds: number, each?: () => void) { while (!p.ended && p.repTime < seconds) { p.step(); each?.(); } }
/** Far away and still: an opponent so the field has two teams. */
const FAR: PlayerSpec = { team: 1, pos: [-15, 0] };

describe('rules (headless)', () => {
  it('a touchdown counts when the ball breaks the plane, while the runner\'s body is still short of it', async () => {
    const p = await play(testMode([{ team: 0, pos: [0, GOAL_LINE - 3] }, FAR], { holder: 0 }), script((_t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'jog'; }));
    run(p, 10);
    const ball = p.ballPos()[2], body = p.world.scene.athletes[0].state.com[2];
    console.log('touchdown: ended', p.ended, 'at', p.repTime.toFixed(2), 's, ball z', ball.toFixed(3), 'body z', body.toFixed(3), 'goal', GOAL_LINE.toFixed(3));
    expect(p.ended).toBe('touchdown');
    expect([p.scorer, p.points]).toEqual([0, 6]);
    expect(ball).toBeGreaterThan(GOAL_LINE);
    expect(body).toBeLessThan(GOAL_LINE);
    p.destroy();
  });

  it('a runner who steps on or over the sideline is out of bounds; the play ends there', async () => {
    let maxX = 0;
    const p = await play(testMode([{ team: 0, pos: [HALF_WIDTH - 3, 0], yaw: Math.PI / 2 }, FAR], { holder: 0 }), script((_t, c) => { c.move = { x: 1, z: 0 }; c.gait = 'jog'; }));
    run(p, 10, () => { maxX = Math.max(maxX, p.world.scene.athletes[0].state.com[0]); });
    console.log('sideline: ended', p.ended, 'at', p.repTime.toFixed(2), 's, body x', maxX.toFixed(2), 'sideline', HALF_WIDTH.toFixed(2));
    expect(p.ended).toBe('out');
    expect(p.scorer).toBe(-1);
    expect(maxX).toBeGreaterThan(HALF_WIDTH - 1);
    expect(maxX).toBeLessThan(HALF_WIDTH + 0.6);
    p.destroy();
  });

  it('a runner who leaves his own end zone out the back gives up a safety', async () => {
    const p = await play(testMode([{ team: 0, pos: [0, -GOAL_LINE - 4], yaw: Math.PI }, FAR], { holder: 0 }), script((_t, c) => { c.move = { x: 0, z: -1 }; c.gait = 'jog'; }));
    run(p, 10);
    console.log('own end line: ended', p.ended, 'at', p.repTime.toFixed(2), 's, body z', p.world.scene.athletes[0].state.com[2].toFixed(2));
    expect(p.ended).toBe('safety');
    expect([p.scorer, p.points]).toEqual([1, 2]);
    p.destroy();
  });

  /** The ball lies loose in the human's own end zone; his raised hand takes it (it is put at his palm, as in the
   *  drill's pickup test), then he runs on out the back. */
  async function pickupInEndZone(impetus: 0 | 1) {
    let mine = false;
    const human = script((_t, c) => { if (mine) { c.move = { x: 0, z: -1 }; c.gait = 'jog'; } else { c.armR = 1; c.gripR = true; } });
    const p = await play(testMode([{ team: 0, pos: [0, -GOAL_LINE - 2], yaw: Math.PI }, FAR], { at: [3, BALL.diameter / 2 + 0.01, -GOAL_LINE - 2], impetus }), human);
    run(p, 0.6); // the arm comes up
    const w = p.world, s = w.scene.athletes[0].state, h = w.athletes[0].handSegs[1];
    w.scene.placeProp(p.ball, [s.segPos[3 * h], s.segPos[3 * h + 1] + 0.12, s.segPos[3 * h + 2]], [0, 0, 0, 1]);
    let held = -1;
    run(p, 8, () => { if (held < 0 && w.ballCarrier === 0) { held = p.repTime; mine = true; } });
    console.log(`pickup in own end zone, impetus ${impetus}: picked up at`, held.toFixed(2), 's, ended', p.ended, 'at', p.repTime.toFixed(2), 's, fumbles', p.fumbles);
    expect(held).toBeGreaterThan(0);
    expect(p.fumbles).toBe(0);
    p.destroy();
    return p;
  }

  it('a kick the returner picks up in his end zone and takes out the back is a touchback; his own fumble there a safety', async () => {
    const kick = await pickupInEndZone(1);
    expect(kick.ended).toBe('touchback');
    expect(kick.points).toBe(0);
    const own = await pickupInEndZone(0);
    expect(own.ended).toBe('safety');
    expect(own.scorer).toBe(1);
  }, 60_000);

  it('a loose ball out of bounds is dead: out the back after a kick a touchback, after an own fumble a safety', async () => {
    const cases: [Vec3, 0 | 1, string][] = [[[0, 0.09, -END_LINE - 1], 1, 'touchback'], [[0, 0.09, -END_LINE - 1], 0, 'safety'], [[HALF_WIDTH + 1, 0.09, 0], 0, 'out']];
    for (const [at, impetus, end] of cases) {
      const p = await play(testMode([{ team: 0, pos: [0, -30] }, FAR], { at, impetus }), script(() => {}));
      run(p, 1);
      expect(p.ended, `${at} impetus ${impetus}`).toBe(end);
      p.destroy();
    }
  });

  it('a runner who lands on the turf against an opponent is down by contact', async () => {
    let t0 = -1;
    // he dives (untouched before) at the opponent's feet, 2.5 m in front of him
    const diver = script((t, c) => { if (t0 < 0) t0 = t; if (t > t0 + 0.3) { c.move = { x: 0, z: -1 }; c.gait = 'jog'; c.dive = t < t0 + 0.4; } c.carry = 2; });
    const p = await play(testMode([{ team: 0, pos: [0, 0] }, { team: 1, pos: [0, 2.6] }], { holder: 1 }, [diver]), script(() => {}));
    let touched = false;
    run(p, 6, () => { touched ||= p.world.athletes[1].touching.includes(0); });
    console.log('dive into an opponent: ended', p.ended, 'at', p.repTime.toFixed(2), 's, touched', touched, ', on the turf by', p.world.athletes[1].downBy);
    expect(touched).toBe(true);
    expect(p.ended).toBe('down');
    expect(p.world.scene.stats().instabilities).toBe(0);
    p.destroy();
  });
});
