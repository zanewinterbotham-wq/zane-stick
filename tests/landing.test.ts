import { describe, expect, it } from 'vitest';
import { landing, ringRadius, RING } from '../src/game/render/landing';

describe('landing marker', () => {
  it('predicts a vacuum parabola: a kick up and forward lands at the range formula', () => {
    const v = 25, el = Math.PI / 4, vy = v * Math.sin(el), vz = v * Math.cos(el);
    const L = landing([0, 0.085, 10], [1, vy, vz])!;
    expect(L.t).toBeCloseTo(2 * vy / 9.81, 3); // launched from rest height: back at it after 2 vy / g
    expect(L.z).toBeCloseTo(10 + vz * L.t, 6);
    expect(L.x).toBeCloseTo(L.t, 6);
  });
  it('a dropped ball lands under itself after sqrt(2h/g)', () => {
    const L = landing([3, 2.085, -4], [0, 0, 0])!;
    expect(L.t).toBeCloseTo(Math.sqrt(2 * 2 / 9.81), 6);
    expect([L.x, L.z]).toEqual([3, -4]);
  });
  it('a ball already at or below rest height has no landing', () => expect(landing([0, 0.05, 0], [0, -1, 0])).toBeNull());
  it('the ring is large at 3 s or more, small on arrival and shrinks smoothly', () => {
    expect(ringRadius(5)).toBe(RING.far);
    expect(ringRadius(0)).toBe(RING.near);
    expect(ringRadius(-1)).toBe(RING.near);
    expect(ringRadius(1.5)).toBeCloseTo((RING.near + RING.far) / 2, 6);
    expect(ringRadius(1)).toBeLessThan(ringRadius(2));
  });
});
