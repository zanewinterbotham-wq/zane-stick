// Goal-Line Stand: you defend your own goal line. The offense has the ball a few yards out with blockers in front of
// the runner; your side wins the rep by stopping him (down, out of bounds, a fumble you recover, or the clock); the
// offense scores only when the ball breaks the plane.
import { GOAL_LINE, NFL, nth, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

/** The runner stands this far behind the line of scrimmage, the blockers this far in front of him (yd); defenders this far off it. */
const BACKFIELD = 2, BLOCK_AT = 0.8, DEF_AT = 1.2;

export const GOAL_LINE_STAND: ModeDef = {
  id: 'goalline', title: 'Goal-Line Stand', preview: 'modes/goalline.jpg',
  pitch: 'Fourth and goal, and you are the defense. Shed the blocks and stop the runner short of your goal line.',
  options: [
    { id: 'togo', label: 'Yards to the goal line', kind: 'range', min: 1, max: 10, step: 1, default: 3, unit: 'yd' },
    { id: 'mates', label: 'Your teammates', kind: 'range', min: 0, max: 5, step: 1, default: 1 },
    { id: 'blockers', label: 'Their blockers', kind: 'range', min: 0, max: 5, step: 1, default: 1 },
    { id: 'timeLimit', label: 'Time limit', kind: 'range', min: 5, max: 30, step: 1, default: 12, unit: 's' },
  ],
  athletes: (o) => 2 + +o.mates + +o.blockers,
  setup(o) {
    // team 0 attacks +Z, so it defends the goal line at -GOAL_LINE; team 1 runs toward it
    const ls = -GOAL_LINE + +o.togo * YD, m = +o.mates, b = +o.blockers, players: PlayerSpec[] = [];
    const xs = (k: number, n: number, w: number) => (k - (n - 1) / 2) * w;
    for (let k = 0; k <= m; k++) players.push({ team: 0, label: nth('Defender', k, m + 1), group: 'Defense', pos: [xs(k, m + 1, 2), ls - DEF_AT * YD] });
    const carrier = players.length;
    players.push({ team: 1, label: 'Ball carrier', group: 'Offense', pos: [0, ls + BACKFIELD * YD] });
    for (let k = 0; k < b; k++) players.push({ team: 1, label: nth('Blocker', k, b), group: 'Offense', pos: [xs(k, b, 2), ls + BLOCK_AT * YD] });
    return {
      players, ball: { holder: carrier }, rules: { ...NFL, outOfBounds: true, timeLimit: +o.timeLimit },
      ended(play) {
        // the defense (you) wins every rep that is not a touchdown against it
        if (play.ended === 'touchdown') return;
        play.scorer = 0; play.points = 1;
      },
      verdict(play, T) {
        if (play.ended === 'touchdown') return play.scorer !== 1 ? '' : T === 1 ? 'Touchdown! You got in' : 'Touchdown: they got in';
        const how = play.ended === 'time' ? 'Time ran out' : play.recoveredBy >= 0 && play.team(play.recoveredBy) === 0 ? (T === 0 ? 'Your ball' : 'They have the ball')
          : play.ended === 'out' ? 'Forced out' : 'Stopped short';
        return T === 0 ? `Goal-line stand! ${how}` : `They held: ${how.toLowerCase()}`;
      },
      lines: () => ({ scrimmage: ls }),
      status: () => `Defend your goal line  ·  they start ${+o.togo} yd out`,
    };
  },
};
