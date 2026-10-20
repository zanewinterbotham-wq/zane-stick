// The QB throw control (docs/passing.md: the placement reticle; the other schemes are vaulted): simulated input frames →
// the PassCmd it produces and its aim aid; the flight helpers it aims with.
import { describe, expect, it } from 'vitest';
import type { InputFrame } from '../src/game/input/input';
import { turfAim } from '../src/game/passing/context';
import { CATCH_Y, MAX_RANGE, Passer, type PassCtx, type Receiver } from '../src/game/passing/schemes';
import type { Vec3 } from '../src/sim/math';
import { leadPoint, THROW, throwVelocity } from '../src/sim/throw';
const ARM_SPEED = THROW.vmax;

const frame = (held: string[] = [], pressed: string[] = [], look = { x: 0, y: 0 }): InputFrame =>
  ({ move: { x: 0, y: 0 }, look, torso: 0, shiftLock: false, sprint: 0, armL: 0, armR: 0, held: new Set(held), pressed: new Set(pressed), device: 'keyboard' });
const wr = (z: number, open = 5, x = 0): Receiver => ({ index: 1, pos: [x, CATCH_Y, z], vel: [0, 0, 6], open });
const ctx = (time: number, o: Partial<PassCtx> = {}): PassCtx =>
  ({ time, from: [0, 1.8, 0], receivers: [wr(20)], target: 0, yaw: 0, pitch: 0, turf: [3, CATCH_Y, 25], ...o });
/** Hold `action` from t = 0 to `t1` (60 Hz frames), then release; the pass it made (null: none). */
function hold(p: Passer, t1: number, o: Partial<PassCtx> = {}, look?: (t: number) => { x: number; y: number }, action = 'throw') {
  let out = p.update(frame([action], [action], look?.(0)), ctx(0, o));
  for (let t = 1 / 60; t < t1 - 1e-9 && !out; t += 1 / 60) out = p.update(frame([action], [], look?.(t)), ctx(t, o));
  return out ?? p.update(frame(), ctx(t1, o));
}
/** Where a ball launched from `from` with `vel` is after `t` s. */
const flight = (from: Vec3, vel: Vec3, t: number) => [from[0] + vel[0] * t, from[1] + vel[1] * t - 4.905 * t * t, from[2] + vel[2] * t];

describe('throw flight', () => {
  it('lands on the point, no faster than the arm; more loft is a slower, higher throw', () => {
    const from: Vec3 = [0, 1.8, 0], at: Vec3 = [5, 1.3, 30];
    for (const loft of [0, 0.5, 1]) {
      const { vel, time } = throwVelocity(from, at, loft), end = flight(from, vel, time);
      end.forEach((x, k) => expect(x).toBeCloseTo(at[k], 6));
      expect(Math.hypot(...vel)).toBeLessThanOrEqual(ARM_SPEED + 1e-9);
    }
    expect(throwVelocity(from, at, 1).time).toBeGreaterThan(throwVelocity(from, at, 0).time * 1.8);
    const far = throwVelocity(from, [0, 1.3, 120], 0); // out of the arm's range: its farthest throw, short
    expect(Math.hypot(...far.vel)).toBeCloseTo(ARM_SPEED, 6);
    expect(far.vel[2] * far.time).toBeLessThan(120);
  });
  it('leads a running receiver so he meets the ball', () => {
    const from: Vec3 = [0, 1.8, 0], rx = { pos: [0, 1.3, 15] as Vec3, vel: [2, 0, 7] as Vec3 };
    const at = leadPoint(from, rx, 0.4), t = throwVelocity(from, at, 0.4).time;
    // he runs on through the throwing motion (THROW.release) and the flight
    const T = THROW.release + t;
    expect(at[0]).toBeCloseTo(rx.vel[0] * T, 2); expect(at[2]).toBeCloseTo(15 + rx.vel[2] * T, 2);
  });
});

describe('placement reticle (the QB throw control)', () => {
  it('lands on the turf aim point; the hold time is the loft; the point follows the passer', () => {
    const p = new Passer();
    expect(hold(p, 0.3)).toEqual({ at: [3, CATCH_Y, 25], loft: 0.5, follow: true });
    expect(p.aid(ctx(0)).reticle).toEqual([3, CATCH_Y, 25]);
    expect(p.scheme.hint((a) => `<${a}>`)).toContain('<throw>');
  });
  it('after the release the arc keeps the throw made (it went flat for a moment) and moves with the passer', () => {
    const p = new Passer();
    p.update(frame(['throw'], ['throw']), ctx(0));
    expect(p.aid(ctx(0.6)).meter).toBeCloseTo(1);
    const pass = p.update(frame(), ctx(0.6))!;                 // let go: full loft
    expect(pass.loft).toBeCloseTo(1);
    // the arm is still throwing: the camera's aim moves on and he runs 3 m to the right
    const a = p.aid(ctx(0.7, { turf: [9, CATCH_Y, 40], from: [3, 1.8, 0] }));
    expect(a.arc).toEqual({ at: [6, CATCH_Y, 25], loft: 1 }); // not loft 0, and not the new aim point
    expect(a.reticle).toEqual([6, CATCH_Y, 25]);
    expect(a.meter).toBeUndefined();
    p.reset();                                                 // the ball is out: back to the live aim
    expect(p.aid(ctx(0.8, { turf: [9, CATCH_Y, 40] })).arc).toEqual({ at: [9, CATCH_Y, 40], loft: 0 });
  });
});

it('turf aim: the camera ray meets the turf, no farther than the longest throw', () => {
  const n = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  expect(turfAim([0, 3, 0], n([0, -0.1, 1]), [0, 1.8, 0])[2]).toBeCloseTo(30, 6);
  expect(turfAim([0, 3, 0], n([0, -0.01, 1]), [0, 1.8, 0])[2]).toBeCloseTo(MAX_RANGE, 6);
  expect(turfAim([0, 3, 0], n([1, 0.2, 0]), [0, 1.8, 0])).toEqual([MAX_RANGE, CATCH_Y, 0]);
});
