// Motor controller factory for drills. Humans and bots get the same factory (no special treatment).
import type { BodyPlan } from '../anatomy/body';
import { HandController, type Gains } from '../control/hand';
import { TrackingController } from '../control/tracking';
import type { MotorController } from '../control/types';
import type { MuscleSet } from '../muscles';

export type ControllerKind = 'tracking' | 'hand';

/** 'tracking' = active ragdoll (design §6.5); 'hand' = the hand-built balance controller alone.
 *  The tuned gains go to the hand-built balance layer either way. */
export function makeController(plan: BodyPlan, muscles: MuscleSet, kind: ControllerKind, gains: Partial<Gains> = {}): MotorController {
  if (kind === 'tracking') {
    const c = new TrackingController(plan, muscles);
    Object.assign(c.hand.gains, gains);
    return c;
  }
  const c = new HandController(plan, muscles);
  Object.assign(c.gains, gains);
  return c;
}
