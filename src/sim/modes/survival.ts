// Survival: carry the ball down the field through waves of tacklers. Each wave is a line across the field that wakes up
// when you get close (as in The Gauntlet), and each is bigger, reads faster and is built heavier, stronger and quicker than
// the one before. A wave is survived when the ball gets past its line; the run ends as in the NFL (touchdown, brought
// down, out of bounds). Score = waves survived. Tacklers differ only in body and in the bot's reaction/aim; the physics
// decides every tackle. Partners (the other team-0 positions) are blockers a second player can take: co-op.
import { BlockerBrain } from '../brains/blocker';
import { GateBrain } from '../brains/gate';
import { IdleBrain } from '../brains/idle';
import { TacklerBrain } from '../brains/tackler';
import { GOAL_LINE, NFL, nth, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

/** Tacklers in wave k (1-based): 1, 2, 2, 3, 3, 4. */
export const waveSize = (k: number) => 1 + Math.floor(k / 2);
/** Each wave over the first: bots read and aim this much faster (×), bodies this much heavier, stronger and quicker (×). */
const RAMP = { read: 0.85, mass: 0.06, strength: 0.05, speed: 0.03 };
/** The first wave this far (yd) ahead of the runner's start, the last this far short of the goal line; the wake-up
 *  distance (m) grows by WAKE_GROW per wave; the ball is past a wave's line when this far (m) beyond it. */
const LEAD = 14, RUNWAY = 8, WAKE = 11, WAKE_GROW = 1.5, PAST = 3;

export const SURVIVAL: ModeDef = {
  id: 'survival', title: 'Survival', preview: 'modes/gauntlet.jpg',
  pitch: 'Waves of tacklers, each bigger, faster and sharper than the last. Get the ball through as many as you can.',
  options: [
    { id: 'waves', label: 'Waves', kind: 'range', min: 2, max: 6, step: 1, default: 3 },
    { id: 'partners', label: 'Your blockers / partners', kind: 'range', min: 0, max: 2, step: 1, default: 0 },
    { id: 'outOfBounds', label: 'Out of bounds ends the run', kind: 'toggle', default: true },
  ],
  athletes: (o) => 1 + +o.partners + Array.from({ length: +o.waves }, (_, k) => waveSize(k + 1)).reduce((a, b) => a + b, 0),
  setup(o, rng, cfg) {
    const W = +o.waves, np = +o.partners, start = -GOAL_LINE + 3 * YD, first = start + LEAD * YD, last = GOAL_LINE - RUNWAY * YD;
    const line = (k: number) => (W > 1 ? first + ((k - 1) * (last - first)) / (W - 1) : first);
    const players: PlayerSpec[] = [{ team: 0, label: 'Runner', pos: [rng.range(-1, 1), start] }];
    for (let k = 0; k < np; k++) players.push({ team: 0, label: nth('Partner', k, np), pos: [(k % 2 ? -1 : 1) * 2 * Math.ceil((k + 1) / 2), start - 1] });
    const waveOf = new Map<number, number>();
    for (let k = 1; k <= W; k++) {
      const m = waveSize(k), g = k - 1, bot = cfg?.bot;
      for (let j = 0; j < m; j++) {
        waveOf.set(players.length, k);
        players.push({
          team: 1, label: `Wave ${k}${m > 1 ? ' · ' + (j + 1) : ''}`, pos: [(j - (m - 1) / 2) * 5 + rng.range(-1, 1), line(k)],
          // the setup is also read without a config (the lobby's position list), where there is no body to scale
          ...(bot && { params: { ...bot, mass: bot.mass * (1 + RAMP.mass * g), strength: bot.strength * (1 + RAMP.strength * g), speed: bot.speed * (1 + RAMP.speed * g) } }),
        });
      }
    }
    let cleared = 0;
    return {
      players, ball: { holder: 0 }, rules: { ...NFL, outOfBounds: !!o.outOfBounds, timeLimit: 90 },
      brain(play, i, r) {
        const h = play.world.ballCarrier;
        if (h < 0 || i === h || play.team(h) !== 0) return null;
        if (play.team(i) === 0) return new BlockerBrain(r, play.cfg.difficulty);
        const k = waveOf.get(i) ?? 1, d = play.cfg.defense ?? play.cfg.difficulty, s = RAMP.read ** (k - 1);
        return new GateBrain(new TacklerBrain(r, { ...d, reaction: d.reaction * s, noise: d.noise * s }), WAKE + WAKE_GROW * (k - 1), new IdleBrain(r, play.cfg.activeBots ? 3 : 0));
      },
      step(play) {
        const h = play.world.ballCarrier;
        if (h >= 0 && play.team(h) === 0) while (cleared < W && play.ballPos()[2] > line(cleared + 1) + PAST) cleared++;
        play.note = `Wave ${Math.min(cleared + 1, W)} of ${W}`;
      },
      ended(play) {
        const td = play.ended === 'touchdown' && play.scorer === 0;
        if (td) cleared = W;
        const by = play.ended === 'out' ? 'Out of bounds' : play.ended === 'time' ? 'Time' : 'Brought down';
        // the score is the waves survived (a safety or touchback is only how he went down); a tackler's own touchdown stands
        if (!td && !(play.ended === 'touchdown' && play.scorer === 1)) { play.points = cleared; play.scorer = cleared > 0 ? 0 : -1; }
        play.verdict = td ? `Survived all ${W} waves!` : `${by}: survived ${cleared} of ${W} wave${W > 1 ? 's' : ''}`;
      },
      status: (play) => `${play.note || `Wave 1 of ${W}`}  ·  each wave bigger and sharper than the last`,
    };
  },
};
