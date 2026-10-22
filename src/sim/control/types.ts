// The command vocabulary shared by human input and bot brains, and the motor-controller interface.
import type { BodyPlan } from '../anatomy/body';
import type { AthleteState } from '../physics/engine';
import type { MuscleSet, MuscleTargets } from '../muscles';
import type { Vec3 } from '../math';
import type { RootTarget, SupportState } from '../anim/types';
import type { Hurt } from '../injury';
import type { JumpTuning } from '../anim/jump';
import type { GrabTuning } from '../grab';

export type Gait = 'walk' | 'jog' | 'sprint';

/** Throw the ball held now so it arrives at `at` (world, m; y ≈ catch height); loft 0 = the flattest, fastest throw the
 *  arm allows (a bullet) .. 1 = a high touch lob. One-shot: set for the step(s) it is pressed; the world plays the
 *  throwing motion and releases once, and ignores more until the motion is over. */
/** `follow`: the point moves with the passer until the ball leaves (a human's reticle is aimed from where he is, and
 *  he runs on through the throwing motion); a bot's lead is a fixed point already. */
export interface PassCmd { at: Vec3; loft: number; follow?: boolean }

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
  /** With wrap: the bear hug (the human's wrap): elbows out wide, then the arms round his sides to his back and a squeeze,
   *  all in the animation's pose (the balance controller does not take the arms). */
  hug: boolean;
  shoot: boolean;
  sink: number;                    // hip sink depth 0..1
  thrustHips: boolean;
  /** Shoulder a hip thrust leads with (+1 left, −1 right; 0: the forward foot's). */
  shoulder: -1 | 0 | 1;
  driveLegs: number;               // 0..1
  chopFeet: boolean;
  lean: { fwd: number; side: number }; // −1..1 (side + = left)
  headTuck: boolean;
  plantCut: -1 | 0 | 1;            // −1 cut right, +1 cut left
  dive: boolean;
  /** Side shuffle: the dive keeps facing `face` and goes along `move` (back, side), the trunk tipping that way. */
  diveFacing: boolean;
  /** Jump straight up (or on along the run): one press is one jump, as for dive. */
  jump: boolean;
  /** Carry the ball: 0 no, 1 in the left arm, 2 in the right arm (tucked, hand gripping the ball). */
  carry: 0 | 1 | 2;
  /** Optional world point the arms should reach toward (bots, or a lock-on). */
  aim: Vec3 | null;
  /** Throw the ball held (one-shot, PassCmd); null: no throw. */
  pass: PassCmd | null;
  /** Eyes on a world point (a ball in the air): the head turns toward it, the trunk helping, as far as they go; null:
   *  ahead. */
  look: Vec3 | null;
}

export function neutralCommands(): Commands {
  return {
    move: { x: 0, z: 0 }, face: null, gait: 'jog', contactMode: false,
    armL: 0, armR: 0, gripL: false, gripR: false, wrap: false, hug: false, shoot: false, sink: 0, thrustHips: false, shoulder: 0,
    driveLegs: 0, chopFeet: false, lean: { fwd: 0, side: 0 }, headTuck: false, plantCut: 0, dive: false, diveFacing: false, jump: false, carry: 0, aim: null, pass: null, look: null,
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
  /** Support levels the world applies (active ragdoll, design §6.5); absent when the world runs without it. */
  support?: SupportState;
  /** Per hand [left, right]: holding another athlete, and the nearest point (world) of an opponent's body a raised
   *  hand could reach for (null: none near). Absent outside a World. */
  grips?: [boolean, boolean];
  reachTo?: (Vec3 | null)[];
  /** Broken limbs he plays on with (design §6.6); absent outside a World. */
  hurt?: Hurt;
  /** A throw the world is playing (World.throwing): time into the motion (s), where it goes and the throwing hand. */
  throwing?: { t: number; at: Vec3; hand: 0 | 1 };
  /** Jump tuning (the world's, the same for every athlete); absent = JUMP_DEFAULTS. */
  jump?: JumpTuning;
  /** Grab tuning (the world's; the animator's bear hug reads it); absent = GRAB_DEFAULTS. */
  grab?: GrabTuning;
}

/** Body state + commands in, muscle targets out, every physics step. A learned policy implements the same. */
export interface MotorController {
  compute(view: BodyView, cmd: Commands, out: MuscleTargets): void;
  /** Read-outs for overlays and tests (e.g. gait phase). */
  debug?(): Record<string, number | string>;
  /** Where the world's support should carry the body this step (active ragdoll); null = no support. */
  root?(): RootTarget | null;
  /** Set by the world on low presets (athlete level of detail): the athlete is far from play, so work whose output
   *  goes unused (a balance layer blended out) may rest. */
  lod?: boolean;
}
