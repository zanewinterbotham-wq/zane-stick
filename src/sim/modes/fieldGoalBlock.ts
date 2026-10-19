// Field goal block: the bots try a field goal, you rush with your teammates against their protection. The ball is
// kicked off the spot (7 yd behind the line, NFL) after the snap-to-kick time, on a low trajectory over the line,
// unless a rusher is on it by then. It is good (3 points) if it passes through the plane of the end line between the
// uprights and above the crossbar, before it touches the turf. A kick that hits a rusher, or never gets away, is
// blocked: a loose ball, live for both teams.
import { BlockerBrain } from '../brains/blocker';
import type { Rng } from '../rng';
import { BALL_REST_Y, ballTouches, goalposts, hold, KICK_RULES, kick, near, POST, rethink, row, SMOTHER, spotVerdict } from './kicks';
import { END_LINE, YD } from './rules';
import type { ModeDef, ModeOptions, PlayerSpec, PlaySetup } from './types';

const G = 9.81;
/** The hold behind the line (yd), launch elevation (rad, a low kick), the height it is aimed to pass the posts at
 *  (m), and the kick's spread: direction (rad) and speed (fraction), 1 sd (about 85 % good from 50 yd unblocked). */
const HOLD_YD = 7, ELEVATION = 0.49, OVER = POST.crossbar + 2, AIM_SD = 0.044, SPEED_SD = 0.02;

/** One field goal try. `aim` (rad) replaces the random direction error (tests). */
export function fieldGoal(o: ModeOptions, rng: Rng, aim?: number): PlaySetup {
  const K = 1, spot = -END_LINE + +o.distance * YD, los = spot - HOLD_YD * YD, D = spot + END_LINE, kickAt = Math.round(+o.kickTime * 10) / 10;
  const e = aim ?? AIM_SD * rng.gauss(), sp = 1 + SPEED_SD * rng.gauss();
  const c = Math.cos(ELEVATION), v = sp * Math.sqrt(G * D * D / (2 * c * c * (D * Math.tan(ELEVATION) - (OVER - BALL_REST_Y))));
  const vel: [number, number, number] = [-Math.sin(e) * v * c, v * Math.sin(ELEVATION), -Math.cos(e) * v * c];
  // you and your rushers on the line, the protection across from you, the kicker behind the spot
  const kicker = 1 + +o.rush;
  const players: PlayerSpec[] = [...row(0, 1 + +o.rush, los - 1, 2.5, rng.range(-0.5, 0.5), 'Rusher', 'Rush'), { team: K, label: 'Kicker', group: 'Kicking team', pos: [-1, spot + 2.2] },
    ...row(K, +o.protect, los + 0.6, 2, 0, 'Protector', 'Kicking team')];
  let kicked = false, flight = false, kickedAt = 0, blocked = false, prevZ = spot;
  return {
    players, ball: { at: [0, BALL_REST_Y, spot], impetus: K }, rules: KICK_RULES, props: goalposts(),
    // until the kick is up, the kicker waits and the protection guards the ball; after it the ball is everyone's
    brain(play, i, rng) {
      if (kicked && !flight || play.team(i) !== K) return null;
      return i === kicker ? hold(rng) : new BlockerBrain(rng, play.cfg.difficulty);
    },
    step(play) {
      const w = play.world, b = play.ballPos();
      if (!kicked) {
        if (play.repTime < kickAt) return;
        kicked = true;
        // a rusher on the ball (or holding it): no kick, it is live where it lies
        if (w.ballCarrier >= 0 || near(play, 0, b, SMOTHER)) { blocked = true; play.note = 'BLOCKED'; return rethink(play); }
        flight = true; kickedAt = play.repTime; prevZ = b[2];
        return kick(play, K, vel, [-10, 0, 0]);
      }
      // through the plane of the end line, in the air: good between the uprights above the crossbar
      if (w.ballCarrier < 0 && (prevZ + END_LINE) * (b[2] + END_LINE) <= 0 && prevZ !== b[2] && b[1] > 0.3) {
        return Math.abs(b[0]) < POST.halfGap && b[1] > POST.crossbar ? play.end('fieldgoal', K, play.rules.points.fieldGoal) : play.end('nogood');
      }
      prevZ = b[2];
      if (!flight || play.repTime - kickedAt <= 0.1) return;
      const t = ballTouches(play), bc = w.ballCarrier;
      if (t.teams[0] || (bc >= 0 && play.team(bc) === 0)) { blocked = true; play.note = 'BLOCKED'; flight = false; if (bc < 0) rethink(play); }
      else if (t.turf || t.teams[1] || bc >= 0) { flight = false; play.end('nogood'); }
    },
    ended(play) {
      const spot = spotVerdict(play);
      play.verdict = play.ended === 'fieldgoal' ? `Field goal is good${blocked ? ', off the block' : ''}` : play.ended === 'nogood' ? `No good${blocked ? ', blocked' : ''}`
        : blocked ? `Blocked!${spot ? ` ${spot}` : ''}` : spot;
    },
    status: (play) => `Block the field goal  ·  ${+o.distance} yd try  ·  ${kickAt.toFixed(1)} s snap to kick${play.note ? `  ·  ${play.note}` : ''}`, // the note reaches guests
  };
}

export const FIELD_GOAL_BLOCK: ModeDef = {
  id: 'fieldGoalBlock', title: 'Field Goal Block', preview: 'modes/fieldGoalBlock.jpg',
  pitch: 'They line up for three. Get penetration, get your hands up in the kick\'s path, and the ball is anyone\'s.',
  options: [
    { id: 'rush', label: 'Your teammates', kind: 'range', min: 0, max: 8, step: 1, default: 1 },
    { id: 'protect', label: 'Their protectors', kind: 'range', min: 0, max: 8, step: 1, default: 1 },
    { id: 'distance', label: 'Field goal', kind: 'range', min: 20, max: 55, step: 5, default: 35, unit: 'yd' },
    { id: 'kickTime', label: 'Snap to kick', kind: 'range', min: 1.0, max: 1.8, step: 0.1, default: 1.3, unit: 's' },
  ],
  athletes: (o) => 2 + +o.rush + +o.protect,
  setup: (o, rng) => fieldGoal(o, rng),
};
