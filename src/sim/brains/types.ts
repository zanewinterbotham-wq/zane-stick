import type { Commands } from '../control/types';
import type { Vec3 } from '../math';

/** What an athlete can perceive about one athlete (itself or another). */
export interface AthleteView {
  com: Vec3; comVel: Vec3;
  pelvis: Vec3; head: Vec3;
  heading: number;          // rad, 0 = facing +Z
  down: boolean;
  hasBall: boolean;
  team: 0 | 1;
}
export interface Perception {
  time: number;
  self: number;
  athletes: AthleteView[];
  field: { halfWidth: number; goalZ: number; dirZ: 1 | -1 }; // goal the ball carrier runs toward
  /** The ball (a prop named 'ball'), wherever it is: in a hand or loose; absent when the drill has none. */
  ball?: { pos: Vec3; vel: Vec3 };
}

/** Decides what to do; outputs the same Commands a human produces. Swappable (hand-written or learned). */
export interface Brain {
  think(p: Perception, dt: number): Commands;
}
