// The route tree as data (docs/passing.md "AI built for 11 on 11"): each route is a stem, a break and what follows it
// (run on, or settle), from any alignment, mirrored by the field side so "in" is always toward the middle of the field
// and "out" toward the sideline the receiver is on. Pure: the receiver brain turns a RouteAssign into a path on the
// turf (world points) and runs it; an option route's break is re-chosen at the break by the coverage (optionPath).
import { clamp, type Vec3 } from '../../math';
import { rel, toWorld } from './sense';
import type { PlayFrame, RouteAssign, RouteKind } from './types';

const YD = 0.9144;

/** Where a receiver lines up: split out, in the slot, next to the formation (tight) or behind the line (backfield). */
export type Alignment = 'wide' | 'slot' | 'tight' | 'backfield';

/** One route (yards, the way coaches draw and teach them): the stem's end (`stem`: depth downfield of the start,
 *  `lean`: sideways toward the middle at the break, the stem's sell: a little away from the way it breaks), then the
 *  break `angle` (degrees off straight downfield, + toward the middle, − toward the sideline, ±180 straight back) and
 *  the leg after it: `leg` yards and settle there (sit down facing the QB), or Infinity: run on. `null` angle: no
 *  break (settle at the stem's end: the screen). */
export interface RouteSpec { stem: number; lean: number; angle: number | null; leg: number }

/** NFL-typical depths, coaching convention (the numbered route tree as commonly taught: quick routes at 1–6 yd,
 *  intermediate 10–12, deep stems 12–15; the stem leans ~1 yd away from the break to sell it). Not measurements. */
export const ROUTES: Record<RouteKind, RouteSpec> = {
  go:       { stem: 6,  lean: -1,   angle: 0,    leg: Infinity }, // outside release, then vertical ("fade" room outside kept)
  seam:     { stem: 6,  lean: 0.5,  angle: 0,    leg: Infinity }, // inside release, vertical up the seam
  slant:    { stem: 2,  lean: -0.5, angle: 50,   leg: Infinity }, // 3-step slant: 1–3 yd, 45–60° inside
  out:      { stem: 10, lean: 0.5,  angle: -90,  leg: Infinity }, // square out at 10 yd (a speed out is 5)
  in:       { stem: 10, lean: -0.5, angle: 90,   leg: Infinity }, // square in at 10 yd
  dig:      { stem: 14, lean: -0.5, angle: 90,   leg: Infinity }, // the deep in: 12–15 yd
  curl:     { stem: 12, lean: -0.5, angle: 150,  leg: 2 },        // 12 yd, turn back inside to ~10
  comeback: { stem: 15, lean: 0.5,  angle: -135, leg: 3 },        // 15 yd, back to the sideline at 45° to ~13
  hitch:    { stem: 6,  lean: 0,    angle: 170,  leg: 1 },        // 5–6 yd, turn back to the QB
  post:     { stem: 12, lean: -0.5, angle: 45,   leg: Infinity }, // 10–12 yd, 45° to the goal post
  corner:   { stem: 12, lean: 0.5,  angle: -45,  leg: Infinity }, // 10–12 yd, 45° to the corner
  flat:     { stem: 1,  lean: -1,   angle: -80,  leg: Infinity }, // to the flat, a yard or two deep
  wheel:    { stem: 1,  lean: -4,   angle: 0,    leg: Infinity }, // out to the flat, then turn up the sideline
  screen:   { stem: -1, lean: -2,   angle: null, leg: 0 },        // back behind the line, outside, turn to the QB
};

/** Closest a route's points come to a sideline (m): two yards of room to make the catch inbounds (convention). */
export const SIDELINE = 2 * YD;
/** How far a running-on leg is drawn (m): beyond any throw. */
const RUN_ON = 40;

/** A route on the turf: world points from the start, the index of the break point, and whether it settles at the
 *  end (else it runs on along the last leg). `inX`: the world-x sign of "in" (toward the middle). */
export interface RoutePath { pts: Vec3[]; brk: number; settle: boolean; inX: 1 | -1 }

/** The alignment a start point implies (no formation needed): behind the line is the backfield; otherwise by the
 *  room to the sideline (split out wide with under 9 yd of it, a slot within 15, else tight). */
export function alignmentOf(f: PlayFrame, start: Vec3): Alignment {
  const r = rel(f, start), room = f.halfWidth - Math.abs(r.x);
  return r.depth < -1.5 ? 'backfield' : room < 9 * YD ? 'wide' : room < 15 * YD ? 'slot' : 'tight';
}

/** "In" for a receiver at world x: toward the middle (x = 0 counts as the left of a team attacking +Z). */
export const inSign = (x: number): 1 | -1 => (x > 0 ? -1 : 1);

/** The path of a route assignment run from `start`. `depth` (m) overrides the stem's depth. From the backfield the
 *  route first gets to the line outside the start (a back's release), except the backfield routes themselves (flat,
 *  wheel, screen), which are drawn from where he is. */
export function routePath(a: RouteAssign, start: Vec3, f: PlayFrame, align: Alignment = alignmentOf(f, start)): RoutePath {
  const s = ROUTES[a.route], r = rel(f, start), ix = inSign(r.x), room = f.halfWidth - SIDELINE;
  const at = (depth: number, x: number): Vec3 => toWorld(f, depth, clamp(x, -room, room));
  const pts: Vec3[] = [at(r.depth, r.x)];
  const back = align === 'backfield' && !['flat', 'wheel', 'screen'].includes(a.route);
  if (back) pts.push(at(0.5, r.x - ix * 2 * YD));
  const stem = a.depth ?? s.stem * YD, from = rel(f, pts[pts.length - 1]);
  // the backfield routes and the screen are drawn from where he stands; the rest from the line (or the release)
  const d0 = ['flat', 'wheel', 'screen'].includes(a.route) ? from.depth : Math.max(from.depth, 0);
  const bx = from.x + ix * s.lean * YD, bd = (a.route === 'screen' ? from.depth : d0) + stem;
  pts.push(at(bd, bx));
  const brk = pts.length - 1;
  if (s.angle === null) return { pts, brk, settle: true, inX: ix };
  const th = s.angle * Math.PI / 180, settle = Number.isFinite(s.leg), lx = ix * Math.sin(th), b = rel(f, pts[brk]);
  let L = settle ? s.leg * YD : RUN_ON;
  // a leg that runs on into the sideline's room stops there and turns up the sideline (the out, corner, flat)
  const toLine = lx > 1e-6 ? (room - b.x) / lx : lx < -1e-6 ? (-room - b.x) / lx : Infinity;
  const turnUp = !settle && toLine < L;
  if (turnUp) L = Math.max(0, toLine);
  pts.push(at(b.depth + Math.cos(th) * L, b.x + lx * L));
  if (turnUp) pts.push(at(b.depth + Math.cos(th) * L + RUN_ON, b.x + lx * L));
  return { pts, brk, settle, inX: ix };
}

/** Whether the path breaks toward the middle (+1), the sideline (−1) or not sideways (0). */
export function breakSide(p: RoutePath): -1 | 0 | 1 {
  const a = p.pts[p.brk], b = p.pts[p.brk + 1];
  if (!b) return 0;
  const lat = (b[0] - a[0]) * p.inX;
  return lat > 0.3 ? 1 : lat < -0.3 ? -1 : 0;
}

/** An option route at its break. Vs man: break away from the defender's leverage (he is inside: go out; outside: go
 *  in), the same leg mirrored about the break if it went his way. Vs zone: settle in the hole at the break's depth
 *  (world x `hole`). `halfWidth` keeps the mirrored leg off the sideline. */
export function optionPath(p: RoutePath, read: { man: true; leverage: 'inside' | 'outside' } | { man: false; hole: number }, halfWidth: number): RoutePath {
  const b = p.pts[p.brk], room = halfWidth - SIDELINE;
  if (!read.man) return { ...p, pts: [...p.pts.slice(0, p.brk + 1), [clamp(read.hole, -room, room), 0, b[2]]], settle: true };
  const want = read.leverage === 'inside' ? -1 : 1;
  if (breakSide(p) === want || breakSide(p) === 0) return p;
  const pts = p.pts.map((q, k): Vec3 => (k <= p.brk ? q : [clamp(2 * b[0] - q[0], -room, room), q[1], q[2]]));
  return { ...p, pts };
}
