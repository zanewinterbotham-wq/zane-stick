// The route tree (src/sim/brains/football/routes.ts): each route's geometry from its alignment and field side, in a
// frame attacking either way, the sideline room kept, and the option route's break by the coverage. Pure, no physics.
import { describe, expect, it } from 'vitest';
import { alignmentOf, breakSide, optionPath, ROUTES, routePath, SIDELINE } from '../src/sim/brains/football/routes';
import type { PlayFrame, RouteKind } from '../src/sim/brains/football/types';
import type { Vec3 } from '../src/sim/math';

const YD = 0.9144, HW = 24.38;
const F: PlayFrame = { los: -20, dir: 1, halfWidth: HW, snapTime: 0 };
const B: PlayFrame = { los: 10, dir: -1, halfWidth: HW, snapTime: 0 };
const ALL = Object.keys(ROUTES) as RouteKind[];
const at = (f: PlayFrame, x: number, depth = 0): Vec3 => [x, 0, f.los + f.dir * depth];
/** Break point (depth, x) and the leg's heading off straight downfield toward the middle (deg). */
function shape(f: PlayFrame, x: number, r: RouteKind) {
  const p = routePath({ kind: 'route', route: r }, at(f, x), f), b = p.pts[p.brk], n = p.pts[p.brk + 1];
  const depth = (b[2] - f.los) * f.dir, ang = n ? Math.atan2((n[0] - b[0]) * p.inX, (n[2] - b[2]) * f.dir) * 180 / Math.PI : null;
  return { p, depth, x: b[0], ang };
}

describe('route tree', () => {
  it('every route breaks at its depth and angle, toward the middle for "in" breaks on either side of the field', () => {
    for (const r of ALL) {
      const s = ROUTES[r], L = shape(F, 15, r), R = shape(F, -15, r);
      expect(L.depth).toBeCloseTo(s.stem * YD, 6); // from the line (he starts on it)
      // the stem's sell: `lean` yards toward the middle (left of the field: −x)
      expect(L.x).toBeCloseTo(15 - s.lean * YD, 6);
      expect(R.x).toBeCloseTo(-15 + s.lean * YD, 6);
      if (s.angle === null) { expect(L.ang).toBeNull(); expect(L.p.settle).toBe(true); continue; }
      // an out-breaking leg into the sideline's room is cut short there; the angle is still the drawn one
      expect(L.ang!).toBeCloseTo(s.angle, 4);
      expect(R.ang!).toBeCloseTo(s.angle, 4);
      expect(L.p.settle).toBe(Number.isFinite(s.leg));
    }
    console.log('break (depth m, angle deg toward the middle):', ALL.map((r) => `${r} ${shape(F, 15, r).depth.toFixed(1)}/${shape(F, 15, r).ang?.toFixed(0) ?? '-'}`).join(', '));
  });

  it('is the same route attacking the other way (depth downfield, in toward the middle)', () => {
    for (const r of ALL) {
      const a = shape(F, 12, r), b = shape(B, -12, r);
      expect(b.depth).toBeCloseTo(a.depth, 6);
      expect(b.ang ?? 0).toBeCloseTo(a.ang ?? 0, 4);
      expect(b.x).toBeCloseTo(-a.x, 6);
    }
  });

  it('keeps two yards of room to the sideline: a run-on leg into it turns up the sideline', () => {
    const room = HW - SIDELINE;
    for (const r of ALL) for (const x of [22, -22, 23.5]) for (const p of [routePath({ kind: 'route', route: r }, at(F, x), F)])
      for (const q of p.pts.slice(1)) expect(Math.abs(q[0])).toBeLessThanOrEqual(room + 1e-9);
    const out = routePath({ kind: 'route', route: 'out' }, at(F, -15), F), n = out.pts.length;
    expect(n).toBe(4);                                   // stem, break, the sideline, up it
    expect(out.pts[2][0]).toBeCloseTo(-room, 6);
    expect(out.pts[3][0]).toBeCloseTo(-room, 6);
    expect(out.pts[3][2]).toBeGreaterThan(out.pts[2][2] + 30);
  });

  it('the depth override sets the stem; the backfield releases to the line first; alignment by position', () => {
    const p = routePath({ kind: 'route', route: 'out', depth: 4.5 }, at(F, 15), F);
    expect((p.pts[p.brk][2] - F.los)).toBeCloseTo(4.5, 6);
    const back = routePath({ kind: 'route', route: 'slant' }, at(F, -3, -5), F);
    expect(alignmentOf(F, at(F, -3, -5))).toBe('backfield');
    expect(back.pts[1][2]).toBeCloseTo(F.los + 0.5, 6);         // to the line ...
    expect(back.pts[1][0]).toBeLessThan(-3);                     // ... outside him
    expect((back.pts[back.brk][2] - F.los)).toBeCloseTo(0.5 + 2 * YD, 6);
    // the backfield's own routes start from where he stands
    const flat = routePath({ kind: 'route', route: 'flat' }, at(F, -3, -5), F);
    expect(flat.pts[flat.brk][2] - F.los).toBeCloseTo(-5 + YD, 6);
    expect(alignmentOf(F, at(F, 18))).toBe('wide');
    expect(alignmentOf(F, at(F, 12))).toBe('slot');
    expect(alignmentOf(F, at(F, 4))).toBe('tight');
  });

  it('option routes: vs man break away from his leverage, vs zone settle in the hole', () => {
    const inR = routePath({ kind: 'route', route: 'in', option: true }, at(F, 15), F);
    expect(breakSide(inR)).toBe(1);
    expect(breakSide(optionPath(inR, { man: true, leverage: 'outside' }, HW))).toBe(1);   // he is outside: in it is
    const flip = optionPath(inR, { man: true, leverage: 'inside' }, HW);
    expect(breakSide(flip)).toBe(-1);                                                       // inside: break out
    expect(flip.pts[flip.brk]).toEqual(inR.pts[flip.brk]);
    const z = optionPath(inR, { man: false, hole: 11 }, HW);
    expect(z.settle).toBe(true);
    expect(z.pts[z.pts.length - 1][0]).toBe(11);
    expect(z.pts[z.pts.length - 1][2]).toBeCloseTo(inR.pts[inR.brk][2], 9);
  });
});
