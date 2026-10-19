// The Gauntlet: you carry the ball from deep in your own territory through a line of tacklers spread down the field.
// Each one waits (GateBrain: in a ready stance at his spot, or with active bots sliding with you and coming up into his
// zone) until you come within the wake-up distance, then chases like any tackler. The
// run ends as in the NFL: the ball breaks the plane (touchdown), or you are down by contact or out of bounds.
import { BlockerBrain } from '../brains/blocker';
import { GateBrain } from '../brains/gate';
import { IdleBrain } from '../brains/idle';
import { TacklerBrain } from '../brains/tackler';
import { GOAL_LINE, NFL, nth, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

/** First tackler this far ahead of the runner, the last this far short of the goal line (yd). */
const LEAD = 12, RUNWAY = 10;
/** With active bots a waiting tackler comes up this far (m) toward the runner, mirroring him across the field. */
const ZONE = 3;

export const GAUNTLET: ModeDef = {
  id: 'gauntlet', title: 'The Gauntlet', preview: 'modes/gauntlet.jpg',
  pitch: 'A line of tacklers down the field, each waiting until you get close. Beat them one after another and score.',
  options: [
    { id: 'tacklers', label: 'Tacklers', kind: 'range', min: 2, max: 4, step: 1, default: 3 },
    { id: 'spacing', label: 'Gap between tacklers', kind: 'range', min: 10, max: 20, step: 1, default: 15, unit: 'yd' },
    { id: 'wake', label: 'Wake-up distance', kind: 'range', min: 6, max: 20, step: 1, default: 12, unit: 'm' },
    { id: 'blockers', label: 'Your blockers', kind: 'range', min: 0, max: 4, step: 1, default: 0 },
    { id: 'outOfBounds', label: 'Out of bounds ends the run', kind: 'toggle', default: true },
  ],
  athletes: (o) => 1 + +o.tacklers + +o.blockers,
  setup(o, rng, cfg) {
    const n = +o.tacklers, gap = +o.spacing, start = Math.max(-GOAL_LINE + 3 * YD, GOAL_LINE - (LEAD + (n - 1) * gap + RUNWAY) * YD);
    const players: PlayerSpec[] = [{ team: 0, label: 'Runner', pos: [rng.range(-1, 1), start] }], nb = +o.blockers;
    for (let k = 0; k < n; k++) players.push({ team: 1, label: nth('Tackler', k, n), pos: [(k % 2 ? 1 : -1) * rng.range(1.5, 6), start + (LEAD + k * gap) * YD] });
    for (let k = 0; k < nb; k++) players.push({ team: 0, label: nth('Blocker', k, nb), pos: [(k % 2 ? -1 : 1) * 2 * Math.ceil((k + 1) / 2), start - 1] });
    return {
      players, ball: { holder: 0 }, rules: { ...NFL, outOfBounds: !!o.outOfBounds, timeLimit: 60 },
      // the tackler waits for the human's run; after a turnover everyone plays the default roles
      brain(play, i, r) {
        const h = play.world.ballCarrier;
        if (h !== 0 || i === 0) return null;
        if (play.team(i) === 1) return new GateBrain(new TacklerBrain(r, play.cfg.defense ?? play.cfg.difficulty), +o.wake, new IdleBrain(r, play.cfg.activeBots ? ZONE : 0));
        return new BlockerBrain(r, play.cfg.difficulty);
      },
      ended(play) {
        if (play.ended === 'touchdown') return;
        if (play.world.ballCarrier !== 0) return;
        const yd = Math.max(0, Math.round((play.ballPos()[2] - start) / YD)), by = play.ended === 'out' ? 'Out of bounds' : play.ended === 'down' ? 'Brought down' : 'Time';
        play.verdict = `${by} after ${yd} yd of ${Math.round((GOAL_LINE - start) / YD)}`;
      },
      verdict: (play, T) => play.ended === 'touchdown' && play.scorer === 0 ? (T === 0 ? 'Through the gauntlet!' : 'He got through') : '',
      status: () => `${n} tackler${n > 1 ? 's' : ''}, ${gap} yd apart  ·  they wake up ${+o.wake} m from you`,
    };
  },
};
