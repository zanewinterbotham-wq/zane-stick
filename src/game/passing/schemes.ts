// QB throw schemes (docs/passing.md, owner request 2026-10-19): six ways to turn the player's input into a pass, switchable
// while playing (1–6 pick one, V cycles). Each scheme only chooses where the ball should arrive and how much loft: the
// sim's World throws it through the athlete's arm. No three.js here: an Aid says what to draw (render/passAim.ts).
import type { PassCmd } from '../../sim/control/types';
import { clamp, type Vec3 } from '../../sim/math';
import { leadPoint } from '../../sim/throw';
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
  /** While Throw is held the mouse / right stick drives the throw, not the camera. */
  holdsLook?: boolean;
  update(f: InputFrame, c: PassCtx): PassCmd | null;
  aid(c: PassCtx): Aid;
  reset(): void;
}

/** Height a pass is aimed at (m): a running receiver's chest. */
export const CATCH_Y = 1.3;
/** Farthest manual throw (m, ~60 yd) and the shortest one; power 0..1 spans them. */
export const MAX_RANGE = 55, MIN_RANGE = 5;
/** Hold times (s): a tap shorter than TAP is a bullet; holding TOUCH longer reaches full touch. Charge time to full power. */
const TAP = 0.15, TOUCH = 0.6, CHARGE = 1;
/** Aim elevation that is a full lob (rad, ~45°; level is a bullet). */
const LOFT_PITCH = 0.8;
/** The lob button's loft. */
const LOB = 0.85;
/** Flick: the window its speed is measured over (s), the slowest flick that throws and the speed of full power (rad/s
 *  of camera turn: mouse counts × the mouse sensitivity, or the right stick, whose full tilt turns 3 rad/s). */
const FLICK = { window: 0.12, min: 0.4, full: 3 };

const pitchLoft = (pitch: number) => clamp(pitch / LOFT_PITCH, 0, 1);
const power = (p: number) => MIN_RANGE + clamp(p, 0, 1) * (MAX_RANGE - MIN_RANGE);
/** A point `d` m from the passer along heading `yaw`, at catch height. */
const along = (c: PassCtx, yaw: number, d: number): Vec3 => [c.from[0] + Math.sin(yaw) * d, CATCH_Y, c.from[2] + Math.cos(yaw) * d];
/** The locked receiver; with nobody to throw to, a still target where the camera aims. */
const locked = (c: PassCtx) => c.receivers[c.target] ?? { pos: c.turf, vel: [0, 0, 0] as Vec3 };

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

/** 1. Fully manual: hold to charge power, release to throw along the camera; the camera's elevation is the loft. */
function aimCharge(): Scheme {
  const h = new Hold(), charge = (c: PassCtx) => clamp(h.held(c) / CHARGE, 0, 1);
  return {
    id: 'charge', name: 'Aim & charge',
    hint: (k) => `Hold ${k('throw')} to charge, release to throw where you look\nLook up for more loft`,
    update(f, c) {
      if (h.step(f, c) !== 'up') return null;
      const p = charge(c); h.t0 = -1;
      return { at: along(c, c.yaw, power(p)), loft: pitchLoft(c.pitch) };
    },
    aid: (c) => (h.t0 >= 0 ? { meter: charge(c) } : {}),
    reset() { h.t0 = -1; },
  };
}

/** 2. Target lock: an icon over the receiver; a tap is a bullet, a longer hold more touch; the lead is automatic. */
function targetLock(): Scheme {
  const h = new Hold(), touch = (c: PassCtx) => clamp((h.held(c) - TAP) / TOUCH, 0, 1);
  return {
    id: 'lock', name: 'Target lock',
    hint: (k) => `Tap ${k('throw')}: bullet  ·  hold: more touch\n${k('target')}: next receiver`,
    update(f, c) {
      if (h.step(f, c) !== 'up') return null;
      const loft = touch(c); h.t0 = -1;
      return { at: leadPoint(c.from, locked(c), loft), loft };
    },
    aid(c) {
      const loft = touch(c), t = locked(c);
      return { icon: t.pos, arc: { at: leadPoint(c.from, t, loft), loft }, ...(h.t0 >= 0 && { meter: loft }) };
    },
    reset() { h.t0 = -1; },
  };
}

/** 3. Placement: a ring on the turf where the camera aims; Throw lands the ball there, the hold time sets the loft. */
function reticle(): Scheme {
  const h = new Hold(), loft = (c: PassCtx) => clamp(h.held(c) / TOUCH, 0, 1);
  return {
    id: 'reticle', name: 'Placement reticle',
    hint: (k) => `Aim the ring with the camera, ${k('throw')} lands it there\nHold ${k('throw')} longer for more loft`,
    update(f, c) {
      if (h.step(f, c) !== 'up') return null;
      const l = loft(c); h.t0 = -1;
      return { at: [c.turf[0], c.turf[1], c.turf[2]], loft: l };
    },
    aid: (c) => ({ reticle: c.turf, arc: { at: c.turf, loft: loft(c) }, ...(h.t0 >= 0 && { meter: loft(c) }) }),
    reset() { h.t0 = -1; },
  };
}

/** 4. Two buttons at the locked receiver, both with the lead: a bullet and a lob. */
function buttons(): Scheme {
  return {
    id: 'buttons', name: 'Bullet / lob buttons',
    hint: (k) => `${k('throw')}: bullet  ·  ${k('lob')}: lob (both lead the receiver)\n${k('target')}: next receiver`,
    update(f, c) {
      const loft = f.pressed.has('throw') ? 0 : f.pressed.has('lob') ? LOB : -1;
      return loft < 0 ? null : { at: leadPoint(c.from, locked(c), loft), loft };
    },
    aid(c) { const t = locked(c); return { icon: t.pos, arc: { at: leadPoint(c.from, t, 0), loft: 0 } }; },
    reset() {},
  };
}

/** 5. Flick: hold Throw and flick the mouse (a touchpad, or the right stick): the flick's direction off the camera's
 *  and its speed (the fastest stretch of the hold) set where and how far; release throws, the camera's elevation is the
 *  loft. A hold with no flick throws nothing. */
function flick(): Scheme {
  const h = new Hold();
  let recent: { t: number; x: number; y: number }[] = [], peak = { x: 0, y: 0, speed: 0 };
  const point = (c: PassCtx): Vec3 | null => peak.speed < FLICK.min ? null
    : along(c, c.yaw - Math.atan2(peak.x, peak.y), power((peak.speed - FLICK.min) / (FLICK.full - FLICK.min)));
  const reset = () => { h.t0 = -1; recent = []; peak = { x: 0, y: 0, speed: 0 }; };
  return {
    id: 'flick', name: 'Flick', holdsLook: true,
    hint: (k) => `Hold ${k('throw')} and flick the mouse (or right stick) the way to throw\nFaster flick = longer throw; release to let go`,
    update(f, c) {
      const s = h.step(f, c);
      if (!s) return null;
      if (f.pressed.has('throw')) { recent = []; peak = { x: 0, y: 0, speed: 0 }; }
      // look.x > 0 turns right, look.y < 0 looks up: a flick up the screen is a throw straight ahead
      recent.push({ t: c.time, x: f.look.x, y: -f.look.y });
      recent = recent.filter((r) => c.time - r.t < FLICK.window);
      const x = recent.reduce((a, r) => a + r.x, 0), y = recent.reduce((a, r) => a + r.y, 0), speed = Math.hypot(x, y) / FLICK.window;
      if (speed > peak.speed) peak = { x, y, speed };
      if (s === 'down') return null;
      const at = point(c), loft = pitchLoft(c.pitch);
      reset();
      return at && { at, loft };
    },
    aid(c) {
      if (h.t0 < 0) return {};
      const at = point(c), m = clamp((peak.speed - FLICK.min) / (FLICK.full - FLICK.min), 0, 1);
      return at ? { meter: m, reticle: at, arc: { at, loft: pitchLoft(c.pitch) } } : { meter: 0 };
    },
    reset,
  };
}

/** 6. Auto QB (a testing assist): Throw picks the most open receiver, the lead and the loft: a bullet to an open man,
 *  touch over tight coverage. */
function autoQb(): Scheme {
  const pick = (c: PassCtx) => c.receivers.reduce<Receiver | null>((b, r) => (!b || r.open > b.open ? r : b), null);
  const loftFor = (r: Receiver | null) => (r ? clamp(0.8 - 0.12 * r.open, 0.1, 0.8) : 0.3);
  const plan = (c: PassCtx) => { const r = pick(c), loft = loftFor(r); return { r, loft, at: leadPoint(c.from, r ?? locked(c), loft) }; };
  return {
    id: 'auto', name: 'Auto QB',
    hint: (k) => `${k('throw')}: throw to the open man (lead and loft picked for you)`,
    update(f, c) {
      if (!f.pressed.has('throw')) return null;
      const { at, loft } = plan(c);
      return { at, loft };
    },
    aid(c) { const { r, at, loft } = plan(c); return { icon: (r ?? locked(c)).pos, arc: { at, loft } }; },
    reset() {},
  };
}

export const makeSchemes = (): Scheme[] => [aimCharge(), targetLock(), reticle(), buttons(), flick(), autoQb()];
export const SCHEME_IDS = ['charge', 'lock', 'reticle', 'buttons', 'flick', 'auto'];

/** The player's QB: the active scheme, switching (1–6, V) and the locked receiver (cycled by the target key). */
export class Passer {
  readonly schemes = makeSchemes();
  private i = 1;
  /** The locked receiver (an index into the frame's receivers). */
  target = 0;
  get scheme() { return this.schemes[this.i]; }
  get index() { return this.i; }
  /** Pick a scheme by id or index (0-based); returns whether it changed. An unknown id keeps the current one. */
  select(s: string | number): boolean {
    const i = typeof s === 'number' ? s : this.schemes.findIndex((x) => x.id === s);
    if (i < 0 || i >= this.schemes.length || i === this.i) return false;
    this.scheme.reset();
    this.i = i;
    return true;
  }
  cycle() { this.select((this.i + 1) % this.schemes.length); }
  /** The HUD's flash on a change: 'Throw scheme 3/6: Placement reticle'. */
  get label() { return `Throw scheme ${this.i + 1}/${this.schemes.length}: ${this.scheme.name}`; }
  /** Whether the camera should ignore this frame's look (the flick uses it). */
  holdsLook(f: InputFrame) { return !!this.scheme.holdsLook && f.held.has('throw'); }
  /** This frame's pass, if the input triggers one; the target key cycles the locked receiver first. */
  update(f: InputFrame, c: PassCtx): PassCmd | null {
    const n = c.receivers.length;
    if (f.pressed.has('target') && n) this.target = (this.target + 1) % n;
    c.target = n ? this.target % n : 0;
    return this.scheme.update(f, c);
  }
  aid(c: PassCtx): Aid { c.target = c.receivers.length ? this.target % c.receivers.length : 0; return this.scheme.aid(c); }
  /** Not passing (no ball, a new rep): forget half-done holds. */
  reset() { this.scheme.reset(); }
}
