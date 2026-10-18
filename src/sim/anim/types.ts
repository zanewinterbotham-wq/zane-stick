// Contract between the procedural animator, the tracking motor controller and the world's support.
// The body is always simulated ("active ragdoll"): muscles track an animation pose, and an invisible
// support carries the athlete along the animation's path while nobody touches him. On contact the support
// fades by how badly this athlete is knocked off balance, and physics takes over (design §6.5).
import type { Commands, BodyView } from '../control/types';
import type { Vec3 } from '../math';

/** Where the support should carry the pelvis/trunk. */
export interface RootTarget {
  vel: Vec3;        // desired COM velocity (world), m/s; y: a dive's take-off, else the pelvis target's vertical speed from posture changes
  height: number;   // desired pelvis height above the turf, m
  heading: number;  // desired pelvis yaw, rad, atan2(x, z) convention (0 = facing +Z)
  pitch: number;    // desired trunk forward lean, rad
  roll: number;     // desired trunk lean to the left, rad
  /** Dive stage: 'launch' = take-off push (the carry may push toward the full vel, y included, off contact);
   *  'flight' = ballistic, the support lets go entirely. */
  dive: 'none' | 'load' | 'launch' | 'flight';
  /** Hip-thrust level 0..1: the legs drive the body up, so the posture support leaves the weight to them. */
  thrust: number;
}

/** How much of its weight support the posture support may give (0..1): none through a dive or a hip thrust,
 *  which rise on the legs' own push. */
export const weightSupport = (r: RootTarget) => (r.dive === 'none' ? 1 - r.thrust : 0);

/** One frame of the procedural animation, per muscle dof (MuscleSet indices). */
export interface AnimFrame {
  q: Float64Array;      // target joint angle, rad
  qd: Float64Array;     // target joint velocity, rad/s
  gain: Float64Array;   // tracking stiffness multiplier 0..1 per dof (relaxed arms, loose when stunned)
  root: RootTarget;
  planted: [boolean, boolean]; // feet the animation has on the ground [left, right]
  phase: number;        // gait phase 0..1 (for overlays/tests)
  clip: string;         // 'idle' | 'walk' | 'run' | 'cut' | 'backpedal' | 'shuffle' | 'stance' | 'dive' | 'getup' | ...
}

/** Support state the world keeps per athlete and hands to the controller each step. */
export interface SupportState {
  posture: number;      // 0..1 upright/weight support level
  carry: number;        // 0..1 horizontal carry level (0 while in contact with another player)
  down: boolean;        // a non-hand, non-foot segment is on the turf
}

export interface Animator {
  /** Advance by view.dt and write the frame. Pure function of its inputs and its own phase state. */
  update(view: BodyView, cmd: Commands, support: SupportState, out: AnimFrame): void;
}

export const newFrame = (n: number): AnimFrame => ({
  q: new Float64Array(n), qd: new Float64Array(n), gain: new Float64Array(n).fill(1),
  root: { vel: [0, 0, 0], height: 1, heading: 0, pitch: 0, roll: 0, dive: 'none', thrust: 0 },
  planted: [true, true], phase: 0, clip: 'idle',
});

/** World support tuning (tuning panel). WorldSetup.support absent = old balance assist only (realism suite). */
export interface SupportSettings {
  strength: number;     // 0..1 overall multiplier
  carryAccel: number;   // largest horizontal acceleration the carry may give, m/s²
  weightShare: number;  // fraction of body weight the posture support carries when fully upright
  tiltStart: number;    // trunk tilt (rad) where posture support starts to fade
  tiltEnd: number;      // trunk tilt (rad) where it reaches zero
  bigHit: number;       // impulse received within 0.2 s (N·s) that removes posture support entirely
  tracking: number;     // muscle tracking stiffness multiplier
}
export const DEFAULT_SUPPORT: SupportSettings = {
  strength: 1, carryAccel: 8, weightShare: 0.6, tiltStart: 0.45, tiltEnd: 0.8, bigHit: 100, tracking: 1,
};
