import type { Commands } from '../control/types';
import type { Vec3 } from '../math';
import type { Rules } from '../modes/types';

/** What an athlete can perceive about one athlete (itself or another). */
export interface AthleteView {
  com: Vec3; comVel: Vec3;
  pelvis: Vec3; head: Vec3;
  heading: number;          // rad, 0 = facing +Z
  down: boolean;
  hasBall: boolean;
  team: 0 | 1;
  /** Playing on a broken leg (he hobbles, injury.ts HOBBLE). */
  lame?: boolean;
}
export interface Perception {
  time: number;
  self: number;
  athletes: AthleteView[];
  /** goalZ/dirZ: the goal the ball carrier runs toward; `rules`: the mode's (a game mode's play sets them), for where a
   *  ball is still in play (steer.ts ballInPlay). */
  field: { halfWidth: number; goalZ: number; dirZ: 1 | -1; rules?: Rules };
  /** The ball (a prop named 'ball'), wherever it is: in a hand or loose; absent when the drill has none. */
  ball?: { pos: Vec3; vel: Vec3 };
  /** False once the play is over (the whistle): the ball is dead. Absent = live. */
  ballLive?: boolean;
}

/** The near shoulder to strike `o` with (+1 left, −1 right), so the head goes past him on the far side; 0 when he
 *  is dead ahead (within 3 cm) or absent. */
export function leadShoulder(me: AthleteView, o: AthleteView | undefined): -1 | 0 | 1 {
  if (!o) return 0;
  const left = (o.com[0] - me.com[0]) * Math.cos(me.heading) - (o.com[2] - me.com[2]) * Math.sin(me.heading);
  return left > 0.03 ? 1 : left < -0.03 ? -1 : 0;
}

/** Decides what to do; outputs the same Commands a human produces. Swappable (hand-written or learned). */
export interface Brain {
  think(p: Perception, dt: number): Commands;
}
