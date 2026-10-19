// Punt return: the bots punt from their own side of the field, higher and shorter than a kickoff, with gunners
// racing down outside. Field it and return it; a punt that touches your end zone is a touchback (NFL), and one the
// gunners get to first is downed where they take it.
import { lob, ownYard, returnPlay } from './kicks';
import { attackDir, END_LINE, nth, side, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

/** The punter's depth behind the line of scrimmage (yd), the drop (m: in front of him, off the foot), hang time (s)
 *  for a punt of d yd from the line (4.25 s for 45 yd), and the returner this far deeper than the landing (m). */
const DEPTH = 14, FOOT: [number, number] = [0.7, 0.5], hang = (d: number) => 2 + 0.05 * d, DEEP = 2;
/** Punt spread: direction (rad) and distance (fraction), 1 sd; spiral spin (rad/s about the long axis). */
const AIM_SD = 0.07, DIST_SD = 0.06, SPIRAL = 40;
/** Gunners line up this wide, jammers just across the line from them. */
const WIDE = 15;

export const PUNT_RETURN: ModeDef = {
  id: 'puntReturn', title: 'Punt Return', preview: 'modes/puntReturn.jpg',
  pitch: 'A high punt hangs over you while the gunners close in. Make the catch, make one miss and find the sideline.',
  options: [
    { id: 'block', label: 'Your blockers', kind: 'range', min: 0, max: 8, step: 1, default: 1 },
    { id: 'cover', label: 'Their gunners', kind: 'range', min: 1, max: 4, step: 1, default: 1 },
    { id: 'distance', label: 'Punt distance', kind: 'range', min: 30, max: 60, step: 5, default: 45, unit: 'yd' },
    { id: 'los', label: 'Punting from their own', kind: 'range', min: 15, max: 50, step: 5, default: 30, unit: 'yd line' },
  ],
  athletes: (o) => 2 + +o.block + +o.cover,
  setup(o, rng) {
    const K = 1, s = attackDir(K), los = ownYard(K, +o.los), yards = +o.distance;
    const pz = ownYard(K, +o.los - DEPTH), from: [number, number, number] = [0, FOOT[1], pz + s * FOOT[0]];
    const d = yards * (1 + DIST_SD * rng.gauss()), e = AIM_SD * rng.gauss(), land = los + s * d * YD;
    const returner = { team: 0 as const, label: 'Returner', pos: [rng.range(-2, 2), s * Math.min(END_LINE - 1, s * land + DEEP)] as [number, number] };
    // gunners split wide, a jammer across from each (more blockers fill in inside)
    const gx = (k: number) => (k % 2 ? -1 : 1) * WIDE * (1 + 0.3 * Math.floor(k / 2));
    // gunners and jammers named by side (Gunner L, Gunner R, then Gunner L2...), the inside blockers numbered
    const wide = (k: number) => `${side(K, gx(k))}${k > 1 ? Math.floor(k / 2) + 1 : ''}`, nc = +o.cover, nb = +o.block;
    const gunners: PlayerSpec[] = Array.from({ length: nc }, (_, k) => ({ team: K, label: `Gunner ${wide(k)}`, pos: [gx(k), los - s * 0.5] }));
    const jammers: PlayerSpec[] = Array.from({ length: nb }, (_, k) => ({ team: 0, label: k < nc ? `Jammer ${wide(k)}` : nth('Blocker', k - nc, nb - nc), pos: [k < nc ? 0.9 * gx(k) : (k % 2 ? -1 : 1) * (4 + 4 * Math.floor(k / 2)), los + s * 1.5] }));
    const players = [returner, ...jammers, { team: K, label: 'Punter', pos: [0, pz] } as PlayerSpec, ...gunners];
    return returnPlay({
      kind: 'punt', kicking: K, players, returner: 0, punter: 1 + +o.block, safety: 1 + +o.block, from,
      vel: lob(Math.abs(land - from[2]), hang(yards), FOOT[1], [Math.sin(e), s * Math.cos(e)]), spin: [0, 0, SPIRAL],
      status: `Punt returner  ·  ${yards} yd punt from their ${+o.los}`,
    });
  },
};
