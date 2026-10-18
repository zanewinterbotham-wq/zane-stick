// Motor controller factory for drills. Humans and bots get the same factory (no special treatment).
import type { BodyPlan } from '../anatomy/body';
import { HandController, type Gains } from '../control/hand';
import type { MotorController } from '../control/types';
import type { MuscleSet } from '../muscles';

export type ControllerKind = 'tracking' | 'hand';

/** 'tracking' = active ragdoll (design §6.5); 'hand' = the hand-built balance controller alone. */
export function makeController(plan: BodyPlan, muscles: MuscleSet, kind: ControllerKind, gains: Partial<Gains> = {}): MotorController {
  // TRACKING_HOOK: for kind 'tracking' return new TrackingController(plan, muscles, new ProceduralAnimator(plan, muscles))
  // once src/sim/control/tracking.ts and src/sim/anim/procedural.ts exist; the tuned gains go to its inner HandController.
  void kind;
  const c = new HandController(plan, muscles);
  Object.assign(c.gains, gains);
  return c;
}
