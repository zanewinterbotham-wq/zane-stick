// Jump tuning (owner request 2026-10-19): the Advanced settings' jump knobs, the same for every athlete (PlayConfig.jump
// → WorldSetup.jump → BodyView.jump for the animator, and the world's launch). Defaults are the realism-calibrated jump
// (docs/realism-sources.md S4); every knob changes the commanded motion or the launch's cap, never adds a force in
// contact with another player.
import { tuned } from '../tuning';

export interface JumpTuning {
  /** Standing take-off strength, × the default launch cap (the COM rise grows with it; 1 ≈ a 0.55–0.6 m vertical). */
  height: number;
  /** Running (one-foot) take-off strength, × the default launch cap. */
  runHeight: number;
  /** Counter-movement: how far the hips dip before a standing take-off (m) and how long the dip takes (s). */
  dip: number;
  load: number;
  /** Longest standing push (s): the take-off ends sooner once the feet leave the turf. */
  push: number;
  /** Hold to charge (s to a full jump); 0 = off, a tap is a full jump. With a charge the jump goes on the release (or
   *  once full), stronger the longer it was held. */
  charge: number;
  /** A charged jump's strength on a quick tap, × a full one. */
  chargeMin: number;
  /** Share of the run's horizontal speed a running take-off keeps (above 1 it drives on along the run). */
  carry: number;
  /** Air control: largest horizontal acceleration toward the move direction in flight (m/s², off contact only;
   *  0 = ballistic, pure physics). */
  air: number;
  /** Landing: how soft the legs are as they meet the turf (0 = stiff, 0.9 = very soft) and how long they take to firm up (s). */
  soft: number;
  recover: number;
  /** Time after a landing before the next jump (s), and how long a press waits for a foot on the turf (s). */
  cooldown: number;
  buffer: number;
  /** Arm swing and knee tuck in the air, × the default motion. */
  arms: number;
  tuck: number;
}

export const JUMP_DEFAULTS: JumpTuning = {
  height: 1, runHeight: 1, dip: 0.3, load: 0.2, push: 0.15, charge: 0, chargeMin: 0.5, carry: 0.95, air: 0,
  soft: 0.75, recover: 0.3, cooldown: 0.2, buffer: 0.25, arms: 1, tuck: 1,
};

/** [min, max, step] per knob (the settings sliders use the same). */
export const JUMP_RANGES: Record<keyof JumpTuning, [number, number, number]> = {
  height: [0.3, 2, 0.05], runHeight: [0, 2, 0.05], dip: [0.03, 0.4, 0.01], load: [0.05, 0.5, 0.01], push: [0.1, 0.4, 0.01],
  charge: [0, 1.5, 0.05], chargeMin: [0.1, 1, 0.05], carry: [0.5, 1.2, 0.05], air: [0, 8, 0.5],
  soft: [0, 0.9, 0.05], recover: [0.05, 1, 0.05], cooldown: [0, 1.5, 0.05], buffer: [0, 0.5, 0.05], arms: [0, 1.5, 0.05], tuck: [0, 1.5, 0.05],
};

/** Defaults with `p`'s valid knobs on top: unknown keys and non-numbers are dropped, numbers clamped to their range
 *  (saved settings and a host's start message are trust boundaries). */
export const jumpTuning = (p: Partial<JumpTuning> | undefined | null): JumpTuning => tuned(JUMP_DEFAULTS, JUMP_RANGES, p);

/** A running take-off (faster than `from`, m/s: no counter-movement, off the next foot down) pushes for `stance` s from
 *  that foot's touchdown, while a foot is on the turf or was a moment ago. A one-foot take-off's contact lasts ~0.1 s
 *  (sprint stance ~0.09–0.11 s; a long jump's take-off ~0.11–0.13 s) [S4], but this sim's sprinting foot touches the turf
 *  for ~0.03 s a stride, so counting only the touch the launch had a third of a real stance to push through (a 0.1 m
 *  rise off a sprint). */
export const RUN_TAKEOFF = { from: 3, stance: 0.1 } as const;