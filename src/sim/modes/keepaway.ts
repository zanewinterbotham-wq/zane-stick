// Keep Away: hold the ball inside a small walled-off patch of turf until the clock runs out. Chasers hunt you from
// the corners; your blockers screen them. There is no goal: caught (down by contact), out of bounds or a stripped
// ball hands the bots the point; surviving the clock is yours.
import type { PropDesc } from '../physics/engine';
import { NFL, nth, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

export const KEEP_AWAY: ModeDef = {
  id: 'keepaway', title: 'Keep Away', preview: 'modes/keepaway.jpg',
  pitch: 'Survive in a small arena with the ball while chasers close in. No end zone: just stay up and in until time runs out.',
  options: [
    { id: 'chasers', label: 'Chasers', kind: 'range', min: 1, max: 5, step: 1, default: 2 },
    { id: 'blockers', label: 'Your blockers', kind: 'range', min: 0, max: 4, step: 1, default: 1 },
    { id: 'size', label: 'Arena size', kind: 'range', min: 14, max: 30, step: 2, default: 22, unit: 'yd' },
    { id: 'duration', label: 'Survive for', kind: 'range', min: 10, max: 60, step: 5, default: 25, unit: 's' },
  ],
  athletes: (o) => 1 + +o.chasers + +o.blockers,
  setup(o, rng) {
    const h = (+o.size * YD) / 2, players: PlayerSpec[] = [{ team: 0, label: 'Runner', pos: [0, 0] }], nb = +o.blockers;
    for (let k = 0; k < nb; k++) players.push({ team: 0, label: nth('Blocker', k, nb), pos: [(k % 2 ? -1 : 1) * 1.8 * Math.ceil((k + 1) / 2), -1.2] });
    // chasers start spread across the far side (within ±0.9 h), facing him
    const n = +o.chasers, f = Math.min(1, 2 / Math.max(1, n - 1));
    for (let k = 0; k < n; k++) players.push({ team: 1, label: nth('Chaser', k, n), pos: [(k - (n - 1) / 2) * 0.9 * h * f + rng.range(-1.5, 1.5), 0.7 * h + rng.range(-1, 1)] });
    // a square arena whose goal lines are out of reach: only down, out or time end the play
    // flat static boundary lines (they cost the low-end budget next to nothing)
    const line = (name: string, pos: [number, number, number], size: number[]): PropDesc => ({ name, shape: 'box', size, mass: 0, pos, friction: 0.8, soft: true });
    const edges = [line('arena', [0, 0.012, h], [h, 0.012, 0.08]), line('arena', [0, 0.012, -h], [h, 0.012, 0.08]), line('arena', [h, 0.012, 0], [0.08, 0.012, h]), line('arena', [-h, 0.012, 0], [0.08, 0.012, h])];
    return {
      players, props: edges, ball: { holder: 0 },
      rules: { ...NFL, halfWidth: h, goal: [1e4, -1e4], endLine: [h, -h], outOfBounds: true, timeLimit: +o.duration },
      // a runner who loses the ball to a chaser ends it; a teammate who picks it up carries on
      step(play) {
        const b = play.world.ballCarrier;
        if (b >= 0 && play.team(b) === 1) play.end('stripped', 1, 1);
      },
      ended(play) {
        const held = play.world.ballCarrier;
        if (play.ended === 'time') { play.scorer = 0; play.points = 1; play.verdict = `Survived ${+o.duration} s`; return; }
        play.scorer = 1; play.points = 1;
        play.verdict = play.ended === 'stripped' ? 'The ball was taken' : play.ended === 'out' ? 'Stepped out of the arena' : held === 0 ? 'Caught' : 'Your runner was caught';
      },
      status: (play) => `Hold the ball for ${Math.max(0, +o.duration - play.repTime).toFixed(0)} s more  ·  ${+o.chasers} chaser${+o.chasers > 1 ? 's' : ''}`,
    };
  },
};
