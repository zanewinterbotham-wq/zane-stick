// The open-field modes: tackle a bot ball carrier in space, or carry the ball past bot tacklers (with optional bot
// blockers). The owner's earlier rule holds by default: only a tackle or a score ends the rep (out of bounds is an
// option), and the padded wall beyond the lines keeps everyone on the field.
import { NFL, nth } from './rules';
import type { ModeDef, ModeOptions, PlayerSpec, Rules } from './types';

const rules = (o: ModeOptions): Rules => ({ ...NFL, outOfBounds: !!o.outOfBounds, timeLimit: +o.timeLimit });
const common = [
  { id: 'outOfBounds', label: 'Out of bounds ends the rep', kind: 'toggle', default: false },
  { id: 'timeLimit', label: 'Time limit', kind: 'range', min: 15, max: 120, step: 5, default: 60, unit: 's' },
] as const;

export const OPEN_FIELD_TACKLE: ModeDef = {
  id: 'tackle', title: 'Open Field Tackle', preview: 'modes/tackle.jpg',
  pitch: 'One on one in space: a bot ball carrier jukes and bursts for your end zone. Bring him down.',
  options: [...common],
  athletes: () => 2,
  setup(o, rng) {
    const hx = rng.range(-2, 2), cx = hx + rng.range(-3, 3), gap = rng.range(10, 14);
    return { players: [{ team: 0, label: 'Tackler', pos: [hx, 0] }, { team: 1, label: 'Ball carrier', pos: [cx, gap] }], ball: { holder: 1 }, rules: rules(o) };
  },
};

export const OPEN_FIELD_CARRY: ModeDef = {
  id: 'carry', title: 'Ball Carrier', preview: 'modes/carry.jpg',
  pitch: 'You have the ball: beat the tacklers to the far end zone. Bring blockers along if you want help.',
  options: [
    { id: 'tacklers', label: 'Tacklers', kind: 'range', min: 1, max: 5, step: 1, default: 1 },
    { id: 'blockers', label: 'Your blockers', kind: 'range', min: 0, max: 4, step: 1, default: 0 },
    ...common,
  ],
  athletes: (o) => 1 + +o.tacklers + +o.blockers,
  setup(o, rng) {
    const hx = rng.range(-2, 2), cx = hx + rng.range(-3, 3), gap = rng.range(10, 14);
    const players: PlayerSpec[] = [{ team: 0, label: 'Ball carrier', pos: [hx, 0] }], nt = +o.tacklers, nb = +o.blockers;
    // the first tackler where the 1-on-1 puts him; more fan out wider and deeper
    for (let k = 0; k < nt; k++) players.push({ team: 1, label: nth('Tackler', k, nt), pos: [cx + (k % 2 ? 1 : -1) * 6 * Math.ceil(k / 2), gap + 4 * Math.ceil(k / 2)] });
    // blockers either side of him, the third and fourth wider
    for (let k = 0; k < nb; k++) players.push({ team: 0, label: nth('Blocker', k, nb), pos: [hx + (k % 2 ? -1.5 : 1.5) * Math.ceil((k + 1) / 2), 3] });
    return { players, ball: { holder: 0 }, rules: rules(o) };
  },
};
