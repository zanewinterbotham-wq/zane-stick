// Contract between the procedural animator, the tracking motor controller and the world's support.
// The body is always simulated ("active ragdoll"): muscles track an animation pose, and an invisible
// support carries the athlete along the animation's path while nobody touches him. On contact the support
// fades by how badly this athlete is knocked off balance, and physics takes over (design §6.5).
import type { Commands, BodyView } from '../control/types';
import type { Vec3 } from '../math';

/** Where the support should carry the pelvis/trunk. */
export interface RootTarget {
  vel: Vec3;        // desired horizontal COM velocity (world; y ignored), m/s
  height: number;   // desired pelvis height above the turf, m
  heading: number;  // desired pelvis yaw, rad, atan2(x, z) convention (0 = facing +Z)
  pitch: number;    // desired trunk forward lean, rad
  roll: number;     // desired trunk lean to the left, rad
}

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
  root: { vel: [0, 0, 0], height: 1, heading: 0, pitch: 0, roll: 0 },
  planted: [true, true], phase: 0, clip: 'idle',
});
