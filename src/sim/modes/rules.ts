// Shared NFL-style rules (no penalties): the field, the scoring planes and how a dead ball counts. Pure functions of
// positions, so Play and the tests use the same ones.
import type { PropDesc } from '../physics/engine';
import type { Vec3 } from '../math';
import type { Rules } from './types';

export const YD = 0.9144;
/** Sidelines (m), goal lines at ±50 yd and end lines at ±60 yd. */
export const HALF_WIDTH = (160 / 3) * YD / 2; // 24.38 m
export const GOAL_LINE = 50 * YD;
export const END_LINE = 60 * YD;

/** A regulation field: out of bounds ends the play, TD 6, safety 2, field goal 3. */
export const NFL: Rules = {
  halfWidth: HALF_WIDTH, goal: [GOAL_LINE, -GOAL_LINE], endLine: [END_LINE, -END_LINE], outOfBounds: true, timeLimit: 60,
  points: { touchdown: 6, safety: 2, fieldGoal: 3 },
};

/** Padded wall round the playing area (end zones included), `gap` m beyond the sidelines and end lines: static
 *  boxes of the physics scene, so athletes and the ball meet it like any other body. The stadium art draws it. */
export const BARRIER = { gap: 5, halfWidth: HALF_WIDTH + 5, halfLength: END_LINE + 5, height: 4, thickness: 1 };
export function barrierProps(): PropDesc[] {
  const { halfWidth: hw, halfLength: hl, height: h, thickness: t } = BARRIER, hh = h / 2, ht = t / 2;
  // each wall's inner face sits on the line; the end walls span the corners too
  const wall = (name: string, pos: Vec3, size: number[]): PropDesc => ({ name, shape: 'box', size, mass: 0, pos, friction: 0.3, soft: true, hidden: true });
  return [
    wall('wall+x', [hw + ht, hh, 0], [ht, hh, hl + t]), wall('wall-x', [-hw - ht, hh, 0], [ht, hh, hl + t]),
    wall('wall+z', [0, hh, hl + ht], [hw + t, hh, ht]), wall('wall-z', [0, hh, -hl - ht], [hw + t, hh, ht]),
  ];
}

/** The way a team attacks along Z. */
export const attackDir = (team: 0 | 1): 1 | -1 => (team === 0 ? 1 : -1);
/** The goal line a team attacks. */
export const goalOf = (r: Rules, team: 0 | 1) => r.goal[team];
/** A ball at z has broken the plane of the goal line `team` attacks (it is in the end zone it scores in). */
export const scores = (r: Rules, team: 0 | 1, z: number) => (team === 0 ? z > r.goal[0] : z < r.goal[1]);
/** A ball at z is in the end zone `team` defends. */
export const inOwnEndZone = (r: Rules, team: 0 | 1, z: number) => scores(r, team === 0 ? 1 : 0, z);
/** A point on or beyond a sideline or an end line. */
export const outside = (r: Rules, x: number, z: number) => Math.abs(x) >= r.halfWidth || z >= r.endLine[0] || z <= r.endLine[1];

export type DeadEnd = 'down' | 'out' | 'safety' | 'touchback';
/** A play that ends with the ball dead at z: held by a runner of `team` who went down or out, or loose and out of
 *  bounds after `team` last had it (or kicked it). Dead in the end zone `team` defends it is a touchback when the
 *  opponents put it there (a kick, their fumble: `touchbackOk`), else a safety; elsewhere `elsewhere`. Behind the
 *  end zone the opponents defend, a loose ball out of bounds is a touchback for them. */
export function deadBall(r: Rules, team: 0 | 1, z: number, touchbackOk: boolean, elsewhere: 'down' | 'out'): { end: DeadEnd; scorer: -1 | 0 | 1 } {
  const other = team === 0 ? 1 : 0;
  if (inOwnEndZone(r, team, z)) return touchbackOk ? { end: 'touchback', scorer: -1 } : { end: 'safety', scorer: other };
  if (elsewhere === 'out' && scores(r, team, z)) return { end: 'touchback', scorer: -1 };
  return { end: elsewhere, scorer: -1 };
}
