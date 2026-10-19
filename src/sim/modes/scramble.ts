// Fumble Scramble: a football is dropped between the two sides and bounces loose; everybody dives for it. Whoever
// recovers it carries on under the NFL rules (his team blocks, the other tackles), or, with "play it out" off, the
// scramble itself is the point.
import { NFL, nth } from './rules';
import type { ModeDef, PlayerSpec } from './types';

export const SCRAMBLE: ModeDef = {
  id: 'scramble', title: 'Fumble Scramble', preview: 'modes/scramble.jpg',
  pitch: 'A loose ball between two sides and nobody holding it. Dive, scoop, or knock it away, then get it home.',
  options: [
    { id: 'perSide', label: 'Players per side', kind: 'range', min: 1, max: 6, step: 1, default: 2 },
    { id: 'gap', label: 'Distance to the ball', kind: 'range', min: 5, max: 14, step: 1, default: 8, unit: 'm' },
    { id: 'playOut', label: 'Play it out after the recovery', kind: 'toggle', default: true },
  ],
  athletes: (o) => 2 * +o.perSide,
  setup(o, rng) {
    const n = +o.perSide, g = +o.gap, players: PlayerSpec[] = [];
    for (const team of [0, 1] as const) for (let k = 0; k < n; k++) players.push({ team, label: nth('Player', k, n), pos: [(k - (n - 1) / 2) * 3 + rng.range(-0.5, 0.5), (team === 0 ? -1 : 1) * g] });
    return {
      players, rules: { ...NFL, outOfBounds: false, timeLimit: o.playOut ? 40 : 15 },
      // dropped from 1.5 m with a random sideways offset: the ellipsoid bounces where physics sends it
      ball: { at: [rng.range(-1.5, 1.5), 1.5, rng.range(-2.5, 2.5)], impetus: 0 },
      step(play) { if (!o.playOut && play.recoveredBy >= 0) play.end('recovered', play.team(play.recoveredBy), 1); },
      ended(play) {
        if (play.ended === 'recovered') play.verdict = play.scorer === 0 ? 'You won the scramble' : 'The bots won the scramble';
        else if (play.ended === 'time' && play.recoveredBy < 0) play.verdict = 'Time: nobody got the ball';
      },
      status: () => `${n} v ${n}  ·  ${o.playOut ? 'recover it, then score' : 'first to recover wins'}`,
    };
  },
};
