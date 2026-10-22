// Grabbing tuning (owner request 2026-10-21: the "tiny things" in the Tuning panel). Grips stay physics: a hand lets go
// when the averaged pull passes its strength (World.updateGrips). The defaults are today's constants (world.ts GRIP_ECC,
// REACH and HELD, the animator's HUG), the same for every athlete.
import { tuned } from './tuning';

export interface GrabTuning {
  /** × a hand's grip strength (on jersey, limbs and the ball). */
  grip: number;
  /** × the force a fistful of jersey holds before it tears free. */
  tear: number;
  /** Seconds a grip's pull is averaged over before it can break (the ball's own window is the fumble tuning's). */
  window: number;
  /** Seconds before a hand torn loose may grab again. */
  cooldown: number;
  /** Gap (m) between a raised hand and a body under which the hand closes on it. */
  reach: number;
  /** Distance (m) from the shoulder within which a reaching arm aims at the nearest part of an opponent. */
  aim: number;
  /** Bear hug: how far out to each side of him the arms reach (m). */
  hugSide: number;
  /** Bear hug: how far past him, round his back, the arms reach (m). */
  hugPast: number;
  /** Bear hug: the elbow bend of the squeeze (rad). */
  hugBend: number;
  /** Bear hug: how much further out the elbows go in the squeeze (rad). */
  hugWide: number;
  /** Seconds a hold lasts before it starts taking the held athlete's balance, and the further seconds to all of it. */
  holdStart: number; holdFull: number;
  /** The share of that one arm takes (two arms take all of it). */
  oneArm: number;
}
export const GRAB_DEFAULTS: GrabTuning = { grip: 1, tear: 1, window: 0.02, cooldown: 0.25, reach: 0.07, aim: 0.9, hugSide: 0.45, hugPast: 0.15, hugBend: 1.9, hugWide: 0.4, holdStart: 0.3, holdFull: 0.9, oneArm: 0.6 };
export const GRAB_RANGES: Record<keyof GrabTuning, [number, number, number]> = {
  grip: [0.25, 4, 0.05], tear: [0.25, 4, 0.05], window: [0.005, 0.2, 0.005], cooldown: [0, 2, 0.05], reach: [0, 0.3, 0.01], aim: [0.4, 1.5, 0.05],
  hugSide: [0, 1, 0.01], hugPast: [0, 0.6, 0.01], hugBend: [0.5, 2.5, 0.05], hugWide: [0, 1, 0.05], holdStart: [0, 2, 0.05], holdFull: [0.1, 3, 0.05], oneArm: [0, 1, 0.05],
};
export const grabTuning = (o: unknown): GrabTuning => tuned(GRAB_DEFAULTS, GRAB_RANGES, o);
