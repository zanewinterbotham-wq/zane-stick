// Shared by the party modes with a small square arena (Hot Potato, Infection): flat static boundary lines, like Keep
// Away's, and rules whose goal lines are out of reach, so only the mode's own logic (and time) end the play.
import type { PropDesc } from '../physics/engine';
import { NFL, YD } from './rules';
import type { Rules } from './types';

/** Half the arena's side (m) from its side in yards. */
export const arenaHalf = (yd: number) => (yd * YD) / 2;

export function arenaProps(h: number): PropDesc[] {
  const line = (pos: [number, number, number], size: number[]): PropDesc => ({ name: 'arena', shape: 'box', size, mass: 0, pos, friction: 0.8, soft: true });
  return [line([0, 0.012, h], [h, 0.012, 0.08]), line([0, 0.012, -h], [h, 0.012, 0.08]), line([h, 0.012, 0], [0.08, 0.012, h]), line([-h, 0.012, 0], [0.08, 0.012, h])];
}

export const arenaRules = (h: number, outOfBounds: boolean, timeLimit: number): Rules => ({ ...NFL, halfWidth: h, goal: [1e4, -1e4], endLine: [h, -h], outOfBounds, timeLimit });
