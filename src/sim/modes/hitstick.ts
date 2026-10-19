// Big Hit Challenge: a runner comes straight at you; level him. The score is the closing speed of the hit in mph (the
// world's measured first contact) plus a bonus for putting him on the turf. Miss and he runs past you for nothing.
import { CarrierBrain } from '../brains/carrier';
import { ScriptBrain } from '../brains/script';
import type { Gait } from '../control/types';
import { NFL } from './rules';
import type { ModeDef } from './types';

const MPH = 2.236936, KNOCKDOWN = 5;
/** The runner is past you (no hit) once he is this far beyond the human's start line (m). */
const PAST = -5;
/** The rep is called this long after the hit (s): long enough to see whether it put him on the turf. */
const SETTLE = 2.5;

export const HIT_STICK: ModeDef = {
  id: 'hitstick', title: 'Big Hit Challenge', preview: 'modes/hitstick.jpg',
  pitch: 'A runner charges you down the field. Time it, meet him at speed and score by how hard the hit lands.',
  options: [
    { id: 'distance', label: 'Starting distance', kind: 'range', min: 8, max: 25, step: 1, default: 14, unit: 'm' },
    { id: 'pace', label: 'Runner pace', kind: 'choice', default: 'jog', choices: [{ id: 'jog', label: 'Jog' }, { id: 'sprint', label: 'Sprint' }] },
    { id: 'runner', label: 'Runner', kind: 'choice', default: 'straight', choices: [{ id: 'straight', label: 'Straight line' }, { id: 'jukes', label: 'Jukes' }] },
  ],
  athletes: () => 2,
  setup(o, rng) {
    return {
      players: [{ team: 0, pos: [0, 0] }, { team: 1, pos: [rng.range(-3, 3), +o.distance] }], ball: { holder: 1 },
      rules: { ...NFL, outOfBounds: false, timeLimit: 15 },
      brain: (play, i, r) => i !== 1 ? null
        : o.runner === 'jukes' ? new CarrierBrain(r, play.cfg.difficulty, o.pace as Gait)
        : new ScriptBrain((_t, _p, c) => { c.move = { x: 0, z: -1 }; c.gait = o.pace as Gait; }),
      step(play) {
        const w = play.world, t0 = w.impact.firstContactTime;
        if (t0 < 0 ? w.scene.athletes[1].state.com[2] < PAST : w.time - t0 > SETTLE) play.end('hit');
      },
      ended(play) {
        const w = play.world, hit = w.impact;
        if (hit.firstContactTime < 0) { play.verdict = 'Missed him'; return; }
        const mph = Math.round(hit.closingSpeed * MPH), down = play.ended === 'down' || w.athletes[1].downBy !== null;
        play.scorer = 0; play.points = mph + (down ? KNOCKDOWN : 0);
        play.verdict = `${mph} mph hit${down ? ', and he is down' : ''}`;
      },
      status: () => `Score = closing speed in mph, +${KNOCKDOWN} for the knockdown`,
    };
  },
};
