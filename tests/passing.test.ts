// QB throw schemes (docs/passing.md): simulated input frames → the PassCmd each scheme produces; switching; the flight
// helpers they aim with.
import { describe, expect, it } from 'vitest';
import type { InputFrame } from '../src/game/input/input';
import { turfAim } from '../src/game/passing/context';
import { CATCH_Y, MAX_RANGE, Passer, type PassCtx, type Receiver } from '../src/game/passing/schemes';
import type { Vec3 } from '../src/sim/math';
import { ARM_SPEED, leadPoint, throwVelocity } from '../src/sim/throw';

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
    expect(at[0]).toBeCloseTo(rx.vel[0] * t, 3); expect(at[2]).toBeCloseTo(15 + rx.vel[2] * t, 3);
  });
});

describe('throw schemes', () => {
  it('1 aim & charge: the hold sets the distance along the camera, its elevation the loft', () => {
    const p = new Passer(); p.select('charge');
    const pass = hold(p, 0.5, { pitch: 0.4 })!;
    expect(pass.loft).toBeCloseTo(0.5);
    expect(pass.at[0]).toBeCloseTo(0, 6); expect(pass.at[2]).toBeCloseTo(30, 0); // 5 m + half of the 50 m span
    expect(hold(p, 3)!.at[2]).toBeCloseTo(MAX_RANGE, 6); // full charge: the farthest throw
    expect(hold(p, 0.5, { yaw: Math.PI / 2 })!.at[0]).toBeCloseTo(30, 0); // turned to +X: thrown there
  });
  it('2 target lock: a tap is a led bullet, a long hold full touch with more lead', () => {
    const p = new Passer(); p.select('lock');
    const bullet = hold(p, 0.1)!, touch = hold(p, 1)!;
    expect([bullet.loft, touch.loft]).toEqual([0, 1]);
    expect(bullet.at[2]).toBeGreaterThan(20); expect(touch.at[2]).toBeGreaterThan(bullet.at[2] + 3);
    expect(bullet.at[0]).toBeCloseTo(0, 6);
    expect(p.aid(ctx(0)).icon).toEqual([0, CATCH_Y, 20]);
  });
  it('2 target lock: the target key cycles the receivers', () => {
    const p = new Passer(); p.select('lock');
    const rs = [wr(20), { ...wr(10, 3, 8), index: 2 }];
    p.update(frame([], ['target']), ctx(0, { receivers: rs }));
    expect(hold(p, 0.1, { receivers: rs })!.at[0]).toBeCloseTo(8, 6);
    p.update(frame([], ['target']), ctx(0, { receivers: rs }));
    expect(hold(p, 0.1, { receivers: rs })!.at[0]).toBeCloseTo(0, 6); // wrapped round
  });
  it('3 placement reticle: lands on the turf aim point; the hold time is the loft', () => {
    const p = new Passer(); p.select('reticle');
    expect(hold(p, 0.3)).toEqual({ at: [3, CATCH_Y, 25], loft: 0.5 });
    expect(p.aid(ctx(0)).reticle).toEqual([3, CATCH_Y, 25]);
  });
  it('4 bullet / lob buttons: one press each, both led at the locked receiver', () => {
    const p = new Passer(); p.select('buttons');
    const b = p.update(frame(['throw'], ['throw']), ctx(0))!, l = p.update(frame(['lob'], ['lob']), ctx(0))!;
    expect([b.loft, l.loft]).toEqual([0, 0.85]);
    expect(b.at[2]).toBeGreaterThan(20); expect(l.at[2]).toBeGreaterThan(b.at[2]);
    expect(p.update(frame(['throw']), ctx(0))).toBeNull(); // held, not pressed again
  });
  it('5 flick: a fast flick right throws far right; a slow one shorter; none throws nothing', () => {
    const p = new Passer(); p.select('flick');
    const fast = hold(p, 0.3, {}, () => ({ x: 0.06, y: 0 }))!;
    expect(fast.at[0]).toBeLessThan(-40); expect(Math.abs(fast.at[2])).toBeLessThan(1); // +X is the athlete's left
    const slow = hold(p, 0.3, {}, () => ({ x: 0, y: -0.015 }))!; // up the screen: straight ahead
    expect(slow.at[2]).toBeGreaterThan(MAX_RANGE * 0.2); expect(slow.at[2]).toBeLessThan(MAX_RANGE * 0.6);
    expect(hold(p, 0.3)).toBeNull();
    expect(p.holdsLook(frame(['throw']))).toBe(true);
    p.select('lock'); expect(p.holdsLook(frame(['throw']))).toBe(false);
  });
  it('6 auto QB: throws to the open man; a bullet when he is open, touch over tight coverage', () => {
    const p = new Passer(); p.select('auto');
    const open = { ...wr(25, 9, -6), index: 2 }, covered = wr(15, 1);
    const pass = p.update(frame(['throw'], ['throw']), ctx(0, { receivers: [covered, open] }))!;
    expect(pass.at[0]).toBeCloseTo(-6, 6); expect(pass.loft).toBeCloseTo(0.1);
    expect(p.update(frame(['throw'], ['throw']), ctx(0, { receivers: [covered] }))!.loft).toBeGreaterThan(0.6);
  });
});

describe('switching', () => {
  it('select by id or index, cycle wraps, the label counts from 1, and a switch drops a half-done hold', () => {
    const p = new Passer();
    expect(p.scheme.id).toBe('lock');
    expect(p.select('reticle')).toBe(true); expect(p.select('reticle')).toBe(false); expect(p.select('nope')).toBe(false);
    expect(p.label).toBe('Throw scheme 3/6: Placement reticle');
    p.select(5); p.cycle(); expect(p.scheme.id).toBe('charge');
    p.update(frame(['throw'], ['throw']), ctx(0)); // charging
    p.select('charge'); expect(p.aid(ctx(0.2)).meter).toBeCloseTo(0.2);
    p.cycle(); p.select('charge');
    expect(p.aid(ctx(0.2)).meter).toBeUndefined();
  });
  it('every scheme has a name and a controls hint naming its keys', () => {
    for (const s of new Passer().schemes) expect(s.hint((a) => `<${a}>`)).toContain('<');
  });
});

it('turf aim: the camera ray meets the turf, no farther than the longest throw', () => {
  const n = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  expect(turfAim([0, 3, 0], n([0, -0.1, 1]), [0, 1.8, 0])[2]).toBeCloseTo(30, 6);
  expect(turfAim([0, 3, 0], n([0, -0.01, 1]), [0, 1.8, 0])[2]).toBeCloseTo(MAX_RANGE, 6);
  expect(turfAim([0, 3, 0], n([1, 0.2, 0]), [0, 1.8, 0])).toEqual([MAX_RANGE, CATCH_Y, 0]);
});
