// The Oklahoma drill: a lane between two lines of cones; a blocker and a defender face off a yard apart, the ball
// carrier five yards behind the blocker. The defender has to get off the block and tackle the carrier inside the
// lane; the offense wins when the ball crosses the finish line five yards past the line of scrimmage. Leaving the
// lane (out of bounds at the cones), a tackle or the clock is a win for the defense. The human picks his role.
import type { PropDesc } from '../physics/engine';
import { attackDir, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

export type OklahomaRole = 'defender' | 'blocker' | 'carrier';
/** Blocker and defender each this far off the line of scrimmage (m), the carrier this far behind it, the finish
 *  line past it, and the defence's own goal line behind the carrier (a scoop and score), all in m. */
const SET = 1, DEPTH = 5 * YD, FINISH = 5 * YD, BACK = 15 * YD;
/** Cones every CONE_STEP from CONE_FROM behind the line of scrimmage to the finish line (m): flat disc markers, static,
 *  so they cost the low-end budget next to nothing (14 dynamic cones cost as much as two more athletes). */
const CONE_STEP = 2 * YD, CONE_FROM = 6 * YD, CONE: [number, number, number] = [0.12, 0.025, 0.12];

export const OKLAHOMA: ModeDef = {
  id: 'oklahoma', title: 'Oklahoma Drill', preview: 'modes/oklahoma.jpg',
  pitch: 'Blocker against defender in a lane of cones, a runner behind. Shed the block and make the stop, or open the hole.',
  options: [
    { id: 'role', label: 'Your role', kind: 'choice', default: 'defender', choices: [
      { id: 'defender', label: 'Defender' }, { id: 'blocker', label: 'Blocker' }, { id: 'carrier', label: 'Ball carrier' }] },
    { id: 'width', label: 'Lane width', kind: 'range', min: 3, max: 10, step: 1, default: 5, unit: 'yd' },
    { id: 'outOfBounds', label: 'Leaving the lane ends the rep', kind: 'toggle', default: true },
  ],
  athletes: () => 3,
  setup(o, rng) {
    const role = o.role as OklahomaRole, O: 0 | 1 = role === 'defender' ? 1 : 0, D: 0 | 1 = O === 0 ? 1 : 0, s = attackDir(O);
    const hw = (+o.width * YD) / 2;
    const at = { blocker: { team: O, pos: [0, -s * SET] }, carrier: { team: O, pos: [rng.range(-0.5, 0.5), -s * DEPTH] }, defender: { team: D, pos: [0, s * SET] } } as Record<OklahomaRole, PlayerSpec>;
    const order: OklahomaRole[] = role === 'defender' ? ['defender', 'blocker', 'carrier'] : role === 'blocker' ? ['blocker', 'carrier', 'defender'] : ['carrier', 'blocker', 'defender'];
    const goal: [number, number] = O === 0 ? [FINISH, -BACK] : [BACK, -FINISH];
    const cones: PropDesc[] = [];
    for (let a = -CONE_FROM; a <= FINISH + 1e-6; a += CONE_STEP) for (const x of [-hw, hw])
      cones.push({ name: 'cone', shape: 'box', size: CONE, mass: 0, pos: [x, CONE[1], s * a], friction: 0.8, soft: true });
    return {
      players: order.map((r) => at[r]), ball: { holder: order.indexOf('carrier') }, props: cones,
      rules: { halfWidth: hw, goal, endLine: [goal[0] + 10 * YD, goal[1] - 10 * YD], outOfBounds: !!o.outOfBounds, timeLimit: 10, points: { touchdown: 1, safety: 1, fieldGoal: 0 } },
      // every rep is won by one side: the offense through the lane, the defense by anything else
      ended(play) {
        const through = play.ended === 'touchdown' && play.scorer === O;
        play.scorer = through ? O : D; play.points = 1;
        play.verdict = through ? 'Offense wins: through the lane'
          : play.ended === 'out' ? 'Defense wins: forced out of the lane'
          : play.ended === 'time' ? 'Defense wins: no way through'
          : play.ended === 'touchdown' ? 'Defense wins: scoop and score'
          : play.recoveredBy >= 0 && play.team(play.recoveredBy) === D ? 'Defense wins: fumble recovered' : 'Defense wins: carrier stopped';
      },
      status: () => `You are the ${role === 'carrier' ? 'ball carrier' : role}  ·  lane ${+o.width} yd`,
    };
  },
};
