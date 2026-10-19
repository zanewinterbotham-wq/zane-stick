// The Gauntlet: you carry the ball from deep in your own territory through a line of tacklers spread down the field.
// Each one stands waiting (GateBrain) until you come within the wake-up distance, then chases like any tackler. The
// run ends as in the NFL: the ball breaks the plane (touchdown), or you are down by contact or out of bounds.
import { BlockerBrain } from '../brains/blocker';
import { GateBrain } from '../brains/gate';
import { TacklerBrain } from '../brains/tackler';
import { GOAL_LINE, NFL, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

/** First tackler this far ahead of the runner, the last this far short of the goal line (yd). */
const LEAD = 12, RUNWAY = 10;

export const GAUNTLET: ModeDef = {
  id: 'gauntlet', title: 'The Gauntlet', preview: 'modes/gauntlet.jpg',
  pitch: 'A line of tacklers down the field, each waiting until you get close. Beat them one after another and score.',
  options: [
    { id: 'tacklers', label: 'Tacklers', kind: 'range', min: 2, max: 4, step: 1, default: 3 },
    { id: 'spacing', label: 'Gap between tacklers', kind: 'range', min: 10, max: 20, step: 1, default: 15, unit: 'yd' },
    { id: 'wake', label: 'Wake-up distance', kind: 'range', min: 6, max: 20, step: 1, default: 12, unit: 'm' },
    { id: 'blockers', label: 'Your blockers', kind: 'range', min: 0, max: 2, step: 1, default: 0 },
    { id: 'outOfBounds', label: 'Out of bounds ends the run', kind: 'toggle', default: true },
  ],
  athletes: (o) => 1 + +o.tacklers + +o.blockers,
  setup(o, rng, cfg) {
    const n = +o.tacklers, gap = +o.spacing, start = Math.max(-GOAL_LINE + 3 * YD, GOAL_LINE - (LEAD + (n - 1) * gap + RUNWAY) * YD);
    const players: PlayerSpec[] = [{ team: 0, pos: [rng.range(-1, 1), start] }];
    for (let k = 0; k < n; k++) players.push({ team: 1, pos: [(k % 2 ? 1 : -1) * rng.range(1.5, 6), start + (LEAD + k * gap) * YD] });
    for (let k = 0; k < +o.blockers; k++) players.push({ team: 0, pos: [(k % 2 ? -1 : 1) * 2, start - 1] });
    return {
      players, ball: { holder: 0 }, rules: { ...NFL, outOfBounds: !!o.outOfBounds, timeLimit: 60 },
      // the tackler waits for the human's run; after a turnover everyone plays the default roles
      brain(play, i, r) {
        const h = play.world.ballCarrier;
        if (h !== 0 || i === 0) return null;
        if (play.team(i) === 1) return new GateBrain(new TacklerBrain(r, play.cfg.defense ?? play.cfg.difficulty), +o.wake);
        return new BlockerBrain(r, play.cfg.difficulty);
      },
      ended(play) {
        if (play.ended === 'touchdown') { if (play.scorer === 0) play.verdict = 'Through the gauntlet!'; return; }
        if (play.world.ballCarrier !== 0) return;
        const yd = Math.max(0, Math.round((play.ballPos()[2] - start) / YD)), by = play.ended === 'out' ? 'Out of bounds' : play.ended === 'down' ? 'Brought down' : 'Time';
        play.verdict = `${by} after ${yd} yd of ${Math.round((GOAL_LINE - start) / YD)}`;
      },
      status: () => `${n} tackler${n > 1 ? 's' : ''}, ${gap} yd apart  ·  they wake up ${+o.wake} m from you`,
    };
  },
};
