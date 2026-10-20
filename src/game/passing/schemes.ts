// The QB throw control (docs/passing.md): the placement reticle, the owner's pick (2026-10-19) of the six schemes tried;
// the other five are vaulted in ./vault. It only chooses where the ball should arrive and how much loft: the sim's
// World throws it through the athlete's arm. No three.js here: an Aid says what to draw (render/passAim.ts).
import type { PassCmd } from '../../sim/control/types';
import { clamp, type Vec3 } from '../../sim/math';
import type { InputFrame } from '../input/input';

/** A team mate the QB may throw to: athlete index, position at catch height and velocity (m, m/s), and how open he is:
 *  the distance to the nearest defender (m). */
export interface Receiver { index: number; pos: Vec3; vel: Vec3; open: number }

/** What a scheme sees this frame. */
export interface PassCtx {
  /** Wall-clock time (s): hold and charge times. */
  time: number;
  /** The ball in the passer's hand. */
  from: Vec3;
  receivers: Receiver[];
  /** The locked receiver (an index into receivers; the Passer sets it). */
  target: number;
  /** The camera's heading (rad, 0 = +Z) and its aim's elevation above level (rad). */
  yaw: number; pitch: number;
  /** Where the camera's aim meets the turf, at catch height, no farther than MAX_RANGE from the passer. */
  turf: Vec3;
}

/** The aim aids to draw: a power / touch meter (0..1), an icon over a receiver, a ring on the turf, an arc preview. */
export interface Aid { meter?: number; icon?: Vec3; reticle?: Vec3; arc?: { at: Vec3; loft: number } }

export interface Scheme {
  id: string;
  name: string;
  /** One or two lines of controls for the HUD; `k` names an action's keys. */
  hint(k: (action: string) => string): string;
  update(f: InputFrame, c: PassCtx): PassCmd | null;
  /** `always`: the aid shows while he only holds the ball (the QB); else only while Throw is held and the throw runs. */
  aid(c: PassCtx, always?: boolean): Aid;
  reset(): void;
}

/** Height a pass is aimed at (m): a running receiver's chest. */
export const CATCH_Y = 1.3;
/** Farthest manual throw (m, ~60 yd) and the shortest one; power 0..1 spans them. */
export const MAX_RANGE = 55, MIN_RANGE = 5;
/** Hold time (s) that reaches full loft. */
const TOUCH = 0.6;

/** Press-and-hold timing shared by the hold schemes: when Throw went down (−1: not held). */
class Hold {
  t0 = -1;
  /** This frame: 'down' while held, 'up' on the frame it is released (or tapped within one frame), else null. */
  step(f: InputFrame, c: PassCtx, action = 'throw'): 'down' | 'up' | null {
    if (f.pressed.has(action)) this.t0 = c.time;
    if (this.t0 < 0) return null;
    return f.held.has(action) ? 'down' : 'up';
  }
  held(c: PassCtx) { return this.t0 < 0 ? 0 : c.time - this.t0; }
}

/** Placement: a ring on the turf where the camera aims; Throw lands the ball there, the hold time sets the loft. The
 *  point follows the passer while the arm throws (THROW.release: he runs on, and the ring with him), and after the
 *  release the ring and the arc stay on the throw made (the live hold, back to none, drew a flat arc for that moment). */
function reticle(): Scheme {
  const h = new Hold(), loft = (c: PassCtx) => clamp(h.held(c) / TOUCH, 0, 1);
  let thrown: { cmd: PassCmd; from: Vec3 } | null = null;
  return {
    id: 'reticle', name: 'Placement reticle',
    hint: (k) => `Aim the ring with the camera, ${k('throw')} lands it there
Hold ${k('throw')} longer for more loft`,
    update(f, c) {
      if (f.pressed.has('throw')) thrown = null;
      if (h.step(f, c) !== 'up') return null;
      const cmd: PassCmd = { at: [c.turf[0], c.turf[1], c.turf[2]], loft: loft(c), follow: true };
      thrown = { cmd, from: [c.from[0], c.from[1], c.from[2]] }; h.t0 = -1;
      return cmd;
    },
    aid(c, always = true) {
      if (!thrown && !always && h.t0 < 0) return {};
      if (!thrown) return { reticle: c.turf, arc: { at: c.turf, loft: loft(c) }, ...(h.t0 >= 0 && { meter: loft(c) }) };
      const a = thrown.cmd.at, at: Vec3 = [a[0] + c.from[0] - thrown.from[0], a[1], a[2] + c.from[2] - thrown.from[2]]; // as the World moves it
      return { reticle: at, arc: { at, loft: thrown.cmd.loft } };
    },
    reset() { h.t0 = -1; thrown = null; },
  };
}

/** The player's QB throw control. */
export class Passer {
  readonly scheme: Scheme = reticle();
  /** This frame's pass, if the input triggers one. */
  update(f: InputFrame, c: PassCtx): PassCmd | null { return this.scheme.update(f, c); }
  aid(c: PassCtx, always = true): Aid { return this.scheme.aid(c, always); }
  /** Not passing (no ball, a new rep): forget half-done holds and the throw shown. */
  reset() { this.scheme.reset(); }
}
