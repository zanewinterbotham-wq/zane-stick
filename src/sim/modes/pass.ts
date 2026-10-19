// QB 1-on-1 (owner request 2026-10-19, docs/passing.md): a quarterback, one receiver and one cornerback at a line of
// scrimmage. The play is the shared rules plus the forward pass (play.ts): one pass from behind the line, incomplete on
// the turf, a catch makes a runner (an interception the defender's). The human picks his role (that slot is athlete 0);
// the bots are passing.ts's: the quarterback reads and throws, the receiver runs the chosen route, the corner covers
// him man to man, pressed or off. As in the Oklahoma drill the human's side is team 0: a cornerback's offense attacks
// the other way.
import { CoverageBrain, PasserBrain, RouteBrain, ROUTE_NAMES, type Route } from '../brains/passing';
import type { Brain } from '../brains/types';
import { ownYard } from './kicks';
import { attackDir, NFL, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

export type PassRole = 'qb' | 'wr' | 'cb';
/** Alignment (m): the receiver's split from the ball (about the numbers), the quarterback's depth (shotgun, 5 yd), the
 *  receiver on the line, and the corner's depth and inside shade pressed (in his face) and off (7 yd cushion). */
const SPLIT = 11, QB_DEPTH = 5 * YD, ON_LINE = 0.5, PRESS = { depth: 1, shade: 0.5 }, OFF = { depth: 7 * YD, shade: 0.8 };

export const PASS_MODE: ModeDef = {
  id: 'pass', title: 'QB 1-on-1', preview: 'modes/pass.jpg',
  pitch: 'Quarterback, receiver and cornerback. Throw him open, win at the catch point, or blanket him and pick it off.',
  options: [
    { id: 'role', label: 'Your role', kind: 'choice', default: 'qb', choices: [
      { id: 'qb', label: 'Quarterback' }, { id: 'wr', label: 'Receiver' }, { id: 'cb', label: 'Cornerback' }] },
    { id: 'route', label: 'Receiver route (bot)', kind: 'choice', default: 'random', choices: [
      ...ROUTE_NAMES.map((r) => ({ id: r, label: r[0].toUpperCase() + r.slice(1) })), { id: 'random', label: 'Random' }] },
    { id: 'coverage', label: 'Coverage', kind: 'choice', default: 'off', choices: [{ id: 'off', label: 'Off (7 yd cushion)' }, { id: 'press', label: 'Press' }] },
    { id: 'los', label: 'Line of scrimmage (your yard line)', kind: 'range', min: 5, max: 95, step: 5, default: 25, unit: 'yd' },
    { id: 'timeLimit', label: 'Time limit', kind: 'range', min: 5, max: 30, step: 1, default: 12, unit: 's' },
  ],
  athletes: () => 3,
  setup(o, rng) {
    const role = o.role as PassRole, O: 0 | 1 = role === 'cb' ? 1 : 0, s = attackDir(O), z0 = ownYard(O, +o.los), side = rng.next() < 0.5 ? 1 : -1;
    const press = o.coverage === 'press', cov = press ? PRESS : OFF, x = side * SPLIT;
    const route: Route = o.route === 'random' ? rng.pick(ROUTE_NAMES) : (o.route as Route);
    const at: Record<PassRole, PlayerSpec> = {
      qb: { team: O, label: 'QB', group: 'Offense', pos: [0, z0 - s * QB_DEPTH] },
      wr: { team: O, label: 'WR', group: 'Offense', pos: [x, z0 - s * ON_LINE] },
      cb: { team: (1 - O) as 0 | 1, label: 'CB', group: 'Defense', pos: [x - side * cov.shade, z0 + s * cov.depth] },
    };
    const order: PassRole[] = role === 'qb' ? ['qb', 'wr', 'cb'] : role === 'wr' ? ['wr', 'qb', 'cb'] : ['cb', 'qb', 'wr'];
    const qb = order.indexOf('qb'), wr = order.indexOf('wr'), cb = order.indexOf('cb');
    // one brain per bot for the whole play until the ball is caught (a throw re-thinks every role: the route and the
    // coverage go on)
    const made: Brain[] = [];
    const gain = (z: number) => Math.round((z - z0) * s / YD);
    return {
      players: order.map((r) => at[r]), ball: { holder: qb }, rules: { ...NFL, timeLimit: +o.timeLimit }, los: z0,
      brain(play, i, r) {
        const bc = play.world.ballCarrier;
        if ((play.pass !== 'none' && play.pass !== 'air') || (bc >= 0 && bc !== qb)) return null;
        const d = play.cfg.difficulty;
        return made[i] ??= i === qb ? new PasserBrain(r, d, wr, cb, play.isBot(wr) ? route : null) : i === wr ? new RouteBrain(r, d, route) : new CoverageBrain(r, play.cfg.defense ?? d, wr, press);
      },
      verdict(play, T) {
        const off = T === O, yd = gain(play.ballPos()[2]), yards = yd < 0 ? `a loss of ${-yd} yd` : `${yd} yd`;
        switch (play.ended) {
          case 'incomplete': return 'Incomplete';
          case 'touchdown': return play.pass === 'intercepted' ? (off ? 'Pick six against you' : 'Pick six!') : play.scorer === T ? 'Touchdown!' : 'Touchdown against you';
          case 'down': case 'out':
            if (play.pass === 'complete') return off ? `Complete for ${yards}` : `Caught for ${yards}`;
            if (play.pass === 'intercepted') return off ? 'Intercepted!' : 'You picked it off';
            return yd < 0 && play.ended === 'down' ? 'Sacked' : `QB run for ${yards}`;
          case 'time': return play.pass === 'none' ? 'Time: the ball never came out' : '';
          default: return '';
        }
      },
      status: (play) => `${play.human >= 0 ? `You are the ${play.mode.players[play.human].label}  ·  ` : ''}route ${route}  ·  ${press ? 'press' : 'off'} coverage`,
    };
  },
};
