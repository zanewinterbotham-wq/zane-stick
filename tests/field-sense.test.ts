// Bots understand the field: a ball in the stands (or dead by the mode's rules) is not chased, nobody runs into the
// barrier, and after the whistle every bot pulls up. Unit checks of ballInPlay / keepOffWall, then headless plays.
import { beforeAll, describe, expect, it } from 'vitest';
import { ballInPlay, keepOffWall } from '../src/sim/brains/steer';
import type { AthleteView, Perception } from '../src/sim/brains/types';
import { neutralCommands } from '../src/sim/control/types';
import type { Vec3 } from '../src/sim/math';
import { Play } from '../src/sim/modes/play';
import { BARRIER, NFL } from '../src/sim/modes/rules';
import type { ModeDef, Rules } from '../src/sim/modes/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { CFG } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());

const view = (x: number, z = 0): AthleteView => ({ com: [x, 1, z], comVel: [0, 0, 0], pelvis: [x, 1, z], head: [x, 1.8, z], heading: 0, down: false, hasBall: false, team: 1 });
const sees = (pos: Vec3, vel: Vec3, rules: Rules, ballLive = true): Perception =>
  ({ time: 0, self: 0, athletes: [view(0)], field: { halfWidth: rules.halfWidth, goalZ: 45, dirZ: 1, rules }, ball: { pos, vel }, ballLive });
const OPEN: Rules = { ...NFL, outOfBounds: false };

describe('ballInPlay', () => {
  it('in bounds and live: yes; dead (the whistle), beyond a line the rules make dead, or in the stands: no', () => {
    expect(ballInPlay(sees([20, 0.1, 0], [0, 0, 0], NFL))).toBe(true);
    expect(ballInPlay(sees([20, 0.1, 0], [0, 0, 0], NFL, false))).toBe(false);
    expect(ballInPlay(sees([25, 0.1, 0], [0, 0, 0], NFL))).toBe(false); // out of bounds, NFL rules
    expect(ballInPlay(sees([0, 0.1, 56], [0, 0, 0], NFL))).toBe(false); // behind the end line
    expect(ballInPlay(sees([27, 0.1, 0], [0, 0, 0], OPEN))).toBe(true); // out of bounds is live in an open-field drill
    expect(ballInPlay(sees([BARRIER.halfWidth + 3, 0.1, 0], [0, 0, 0], OPEN))).toBe(false); // in the stands
  });
  it('a ball flying over the wall is lost from the kick; one that hits the wall comes back and stays in play', () => {
    expect(ballInPlay(sees([18, 1, 0], [10, 14, 0], OPEN))).toBe(false);
    expect(ballInPlay(sees([0, 1, 30], [0, 18, 20], OPEN))).toBe(false); // a punt over the end wall
    expect(ballInPlay(sees([25, 1, 0], [10, 1, 0], OPEN))).toBe(true);
    expect(ballInPlay(sees([0, 1, 0], [0, 15, 15], OPEN))).toBe(true); // a punt that comes down on the field
  });
});

describe('keepOffWall', () => {
  it('caps a run at the barrier so he stops short of it; along it, away from it and far from it the command stands', () => {
    const near = view(BARRIER.halfWidth - 0.5), c = neutralCommands();
    c.gait = 'sprint'; c.move = { x: 1, z: 0.3 };
    keepOffWall(near, c);
    expect(c.move.x).toBe(0); expect(c.move.z).toBe(0.3);
    const away = neutralCommands(); away.move = { x: -1, z: 0 };
    keepOffWall(near, away);
    expect(away.move.x).toBe(-1);
    const far = neutralCommands(), m = { x: 1, z: 0 }; far.move = m; far.gait = 'sprint';
    keepOffWall(view(0), far);
    expect(far.move).toBe(m);
    // 5 m off the wall a sprint toward it is held to what stops 0.6 m short at 4 m/s² (~6 m/s)
    const mid = neutralCommands(); mid.gait = 'sprint'; mid.move = { x: 1, z: 0 };
    keepOffWall(view(BARRIER.halfWidth - 5), mid);
    expect(mid.move.x * 10.5).toBeCloseTo(Math.sqrt(2 * 4 * 4.4), 5);
  });
});

/** Bot tacklers (team 1) at `at`, a team-0 bot standing at the origin, the ball loose at `ball`; no human. */
async function loose(at: [number, number][], ball: Vec3, rules: Rules) {
  const def: ModeDef = {
    id: 'field-sense', title: '', pitch: '', preview: '', options: [], athletes: () => at.length + 1,
    setup: () => ({ players: [{ team: 0, label: 'Passer', pos: [0, -8] }, ...at.map((pos, k) => ({ team: 1 as const, label: `T${k}`, pos }))], ball: { at: ball, impetus: 0 }, rules: { ...rules, timeLimit: 30 } }),
  };
  return Play.create(mujocoEngine, CFG, def, {}, null, 0, { human: -1 });
}
/** Launch the loose ball from `from` at `vel` (a kick or a throw). */
function launch(play: Play, from: Vec3, vel: Vec3) {
  play.world.scene.placeProp(play.ball, from, [0, 0, 0, 1]);
  play.world.scene.launchProp(play.ball, vel, [0, 0, 0]);
}
const flat = (v: ArrayLike<number>) => Math.hypot(v[0], v[2]);
/** Smallest distance (m) from any athlete's COM to the barrier's inner faces. */
const wallGap = (play: Play) => Math.min(...play.world.scene.athletes.map(({ state: { com } }) => Math.min(BARRIER.halfWidth - Math.abs(com[0]), BARRIER.halfLength - Math.abs(com[2]))));

describe('headless: bots and a dead or lost ball', () => {
  it('a ball punted into the stands is not chased: no bot ends within 1 m of the wall, and they pull up', async () => {
    const play = await loose([[18, -4], [18, 4], [14, 0], [23, 0]], [18, 0.11, 0], OPEN), w = play.world;
    launch(play, [18, 1, 0], [10, 14, 0]); play.ballLoose(0);
    let gap = Infinity;
    while (w.time - play.repStart < 6) { play.step(); gap = Math.min(gap, wallGap(play)); }
    const b = play.ballPos(), speeds = w.scene.athletes.map((a) => flat(a.state.comVel));
    console.log(`stands: ball at (${b[0].toFixed(1)}, ${b[2].toFixed(1)}), nearest athlete to the wall ${gap.toFixed(2)} m, end speeds ${speeds.map((s) => s.toFixed(2)).join(' ')} m/s, instabilities ${w.scene.stats().instabilities}`);
    expect(b[0]).toBeGreaterThan(BARRIER.halfWidth); // it did go into the stands
    expect(play.ended).toBeNull(); // out of bounds is live here: only the ball being lost stops them
    expect(gap).toBeGreaterThan(1);
    for (const s of speeds) expect(s).toBeLessThan(1);
    expect(w.scene.stats().instabilities).toBe(0);
    play.destroy();
  }, 120_000);

  it('the same kick short of the wall is still chased down', async () => {
    const play = await loose([[18, -4], [18, 4], [14, 0], [23, 0]], [18, 0.11, 0], OPEN), w = play.world;
    launch(play, [18, 1, 0], [4, 8, 0]); play.ballLoose(0);
    let near = Infinity;
    while (w.time - play.repStart < 5 && w.ballCarrier < 0) {
      play.step();
      const b = play.ballPos();
      near = Math.min(near, ...w.scene.athletes.map(({ state: { com } }) => Math.hypot(com[0] - b[0], com[2] - b[2])));
    }
    console.log(`in play: nearest athlete to the ball ${near.toFixed(2)} m, holder ${w.ballCarrier}, nearest to the wall ${wallGap(play).toFixed(2)} m`);
    expect(w.ballCarrier >= 0 || near < 1.5).toBe(true);
    expect(wallGap(play)).toBeGreaterThan(0.3);
    play.destroy();
  }, 120_000);

  it('after an incomplete pass (the whistle) the bots stop chasing', async () => {
    const play = await loose([[-6, 5], [6, 5], [-6, 15], [6, 15]], [0, 0.11, 10], NFL), w = play.world;
    launch(play, [0, 2, 0], [0, 4, 8.3]); play.passer = 0; play.pass = 'air';
    while (!play.ended && w.time - play.repStart < 4) play.step();
    expect(play.ended).toBe('incomplete');
    const atWhistle = Math.max(...w.scene.athletes.slice(1).map((a) => flat(a.state.comVel)));
    while (w.time - play.endTime < 2) play.step();
    const before = w.scene.athletes.map((a) => [...a.state.com]);
    while (w.time - play.endTime < 3) play.step();
    const moved = w.scene.athletes.map((a, i) => Math.hypot(a.state.com[0] - before[i][0], a.state.com[2] - before[i][2]));
    const speeds = w.scene.athletes.map((a) => flat(a.state.comVel));
    console.log(`whistle: fastest bot at the whistle ${atWhistle.toFixed(1)} m/s; 2-3 s on moved ${moved.map((m) => m.toFixed(2)).join(' ')} m, speeds ${speeds.map((s) => s.toFixed(2)).join(' ')} m/s`);
    expect(atWhistle).toBeGreaterThan(2); // they were going for it
    for (const m of moved) expect(m).toBeLessThan(0.6);
    for (const s of speeds) expect(s).toBeLessThan(0.6);
    play.destroy();
  }, 120_000);
});
