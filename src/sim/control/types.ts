// The command vocabulary shared by human input and bot brains, and the motor-controller interface.
import type { BodyPlan } from '../anatomy/body';
import type { AthleteState } from '../physics/engine';
import type { MuscleSet, MuscleTargets } from '../muscles';
import type { Vec3 } from '../math';

export type Gait = 'walk' | 'jog' | 'sprint';

export interface Commands {
  /** Desired ground velocity direction (world x, z), magnitude 0..1 of the gait's speed. */
  move: { x: number; z: number };
  /** Desired facing direction (world x, z) or null to face the move direction. */
  face: { x: number; z: number } | null;
  gait: Gait;
  contactMode: boolean;
  armL: number; armR: number;      // reach 0..1
  gripL: boolean; gripR: boolean;
  wrap: boolean;
  shoot: boolean;
  sink: number;                    // hip sink depth 0..1
  thrustHips: boolean;
  driveLegs: number;               // 0..1
  chopFeet: boolean;
  lean: { fwd: number; side: number }; // −1..1 (side + = left)
  headTuck: boolean;
  plantCut: -1 | 0 | 1;            // −1 cut right, +1 cut left
  dive: boolean;
  /** Optional world point the arms should reach toward (bots, or a lock-on). */
  aim: Vec3 | null;
}

export function neutralCommands(): Commands {
  return {
    move: { x: 0, z: 0 }, face: null, gait: 'jog', contactMode: false,
    armL: 0, armR: 0, gripL: false, gripR: false, wrap: false, shoot: false, sink: 0, thrustHips: false,
    driveLegs: 0, chopFeet: false, lean: { fwd: 0, side: 0 }, headTuck: false, plantCut: 0, dive: false, aim: null,
  };
}

/** Per-foot ground contact summary computed by the world each step. */
export interface FootContact { force: number; cop: Vec3; touching: boolean }

/** Everything a motor controller may read: its own body and what it touches. */
export interface BodyView {
  plan: BodyPlan;
  muscles: MuscleSet;
  state: AthleteState;
  dt: number;
  time: number;
  feet: [FootContact, FootContact];     // [left, right]
  /** True while this athlete is in contact with another athlete. */
  playerContact: boolean;
}

/** Body state + commands in, muscle targets out, every physics step. A learned policy implements the same. */
export interface MotorController {
  compute(view: BodyView, cmd: Commands, out: MuscleTargets): void;
  /** Read-outs for overlays and tests (e.g. gait phase). */
  debug?(): Record<string, number | string>;
}
