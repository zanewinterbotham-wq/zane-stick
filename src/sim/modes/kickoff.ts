// Kickoff, you on the coverage team: the ball is kicked off a tee at your own 35 (NFL), you and your teammates run
// it down, a bot returner fields it behind his blockers and runs it back. Bring him down as far up the field as
// you can. kickoffPlay builds either side of the kick (kickoffReturn.ts is the other).
import type { Rng } from '../rng';
import { BALL_REST_Y, lob, ownYard, returnPlay, row } from './kicks';
import { attackDir, END_LINE, YD } from './rules';
import type { ModeDef, PlayerSpec, PlaySetup } from './types';

/** NFL kickoff: from the kicking team's 35, hang time (s) for a kick of d yd (4 s for a 60 yd kick), the run-up behind
 *  the tee (m), the receivers' front line (their own yd line) and the returner this far deeper than the landing (m). */
const TEE = 35, hang = (d: number) => 2.4 + 0.027 * d, RUN_UP = 4, FRONT = 30, DEEP = 3;
/** Kick spread: direction (rad) and distance (fraction), 1 sd. */
const AIM_SD = 0.05, DIST_SD = 0.04;
/** The coverage lines up across the field, its outside men this wide (m, about the numbers), and nobody on the tee
 *  (at least this far beside it). Each man runs down in the lane he lines up in. */
const LANE_W = 13, TEE_CLEAR = 2.5;

/** A kickoff by team K: on the kicking team the kicker (behind the tee) and `cover` − 1 more men, plus the human when
 *  he kicks off (K = 0); on the other side a returner (the human when K = 1) and `block` blockers. */
export function kickoffPlay(K: 0 | 1, cover: number, block: number, yards: number, rng: Rng): PlaySetup {
  const R = K === 0 ? 1 : 0, s = attackDir(K), tee = ownYard(K, TEE);
  const d = yards * (1 + DIST_SD * rng.gauss()), e = AIM_SD * rng.gauss();
  const land = tee + s * d * YD, rz = s * Math.min(END_LINE - 1, s * land + DEEP);
  const returner: PlayerSpec = { team: R, pos: [rng.range(-3, 3), rz] };
  const kicker: PlayerSpec = { team: K, pos: [0, tee - s * RUN_UP] };
  // the coverage line spread across the field (on your kickoff you are its middle man), blockers across their front
  const n = K === 0 ? cover : cover - 1, xs = Array.from({ length: n }, (_, k) => (n > 1 ? LANE_W * (2 * k / (n - 1) - 1) : 0))
    .sort((a, b) => Math.abs(a) - Math.abs(b)).map((x) => (Math.abs(x) < TEE_CLEAR ? TEE_CLEAR : x));
  const line: PlayerSpec[] = xs.map((x) => ({ team: K, pos: [x, tee - s] })), blockers = row(R, block, ownYard(R, FRONT), 6, 3);
  const players = K === 1 ? [returner, ...blockers, kicker, ...line] : [line[0], kicker, ...line.slice(1), returner, ...blockers];
  const from: [number, number, number] = [0, BALL_REST_Y, tee];
  return returnPlay({
    kind: 'kickoff', kicking: K, players, returner: K === 1 ? 0 : 1 + cover, safety: K === 1 ? 1 + block : 1, from,
    vel: lob(Math.abs(land - tee), hang(yards), BALL_REST_Y, [Math.sin(e), s * Math.cos(e)]), spin: [-10, 0, 0],
    status: K === 1 ? `Kick returner  ·  ${yards} yd kick  ·  field it and take it back` : `Kick coverage  ·  ${yards} yd kick  ·  get down the field and make the stop`,
  });
}

export const kickDistance = { id: 'distance', label: 'Kick distance', kind: 'range', min: 40, max: 75, step: 5, default: 60, unit: 'yd' } as const;

export const KICKOFF: ModeDef = {
  id: 'kickoff', title: 'Kickoff Coverage', preview: 'modes/kickoff.jpg',
  pitch: 'You are on the kickoff team. Sprint down the field, beat the blockers and bring the returner down.',
  options: [
    { id: 'cover', label: 'Your team (the kicker too)', kind: 'range', min: 1, max: 4, step: 1, default: 1 },
    { id: 'block', label: 'Their blockers', kind: 'range', min: 0, max: 4, step: 1, default: 1 },
    kickDistance,
  ],
  athletes: (o) => 2 + +o.cover + +o.block,
  setup: (o, rng) => kickoffPlay(0, +o.cover, +o.block, +o.distance, rng),
};
