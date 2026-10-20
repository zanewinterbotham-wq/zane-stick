// QB 1-on-1 (owner request 2026-10-19, docs/passing.md): a quarterback, one to three receivers and as many defensive
// backs at a line of scrimmage. The play is the shared rules plus the forward pass (play.ts): one pass from behind the
// line, incomplete on the turf, a catch makes a runner (an interception the defender's). The mode is one play call
// (brains/football/types.ts): the QB's progression, each receiver's route, each defender's man or zone job, and the
// bots are the football AI layer's brains playing it, the same objects for the whole play (they play after the catch
// themselves: a receiver carries, a defender tackles or runs an interception back). The human picks his role (that
// slot is athlete 0); as in the Oklahoma drill the human's side is team 0: a cornerback's offense attacks the other way.
import { DefensiveBackBrain } from '../brains/football/db';
import { QBBrain } from '../brains/football/qb';
import { ReceiverBrain } from '../brains/football/receiver';
import type { Assignment, PlayCall, PlayFrame, RouteAssign, RouteKind, ZoneKind } from '../brains/football/types';
import type { Brain } from '../brains/types';
import { ownYard } from './kicks';
import type { Play } from './play';
import { attackDir, NFL, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

export type PassRole = 'qb' | 'wr' | 'cb';
/** Alignment (m): the outside receivers' split from the ball (about the numbers), the slot's (between the hash and the
 *  numbers, a step off the line), the quarterback under centre, a receiver on the line, a corner's depth and shade
 *  pressed (in his face) and off (7 yd cushion), the safety's depth. */
const SPLIT = 11, SLOT = 5.5, QB_DEPTH = 1, ON_LINE = 0.5, OFF_LINE = 1.2, PRESS = { depth: 1, shade: 0.5 }, OFF = { depth: 7 * YD, shade: 0.8 }, SAFETY = 12 * YD;
/** The routes a bot receiver is given (and 'random' picks from). */
export const ROUTE_CHOICES: RouteKind[] = ['go', 'slant', 'out', 'in', 'dig', 'curl', 'comeback', 'hitch', 'post', 'corner', 'seam'];
/** The QB's drop by his first read's route: quick (3 steps), intermediate (5), deep (7). */
const QUICK = new Set<RouteKind>(['slant', 'hitch', 'flat', 'screen']), DEEP = new Set<RouteKind>(['go', 'seam', 'post', 'corner', 'dig', 'comeback']);
const routeClass = (r: RouteKind): 0 | 1 | 2 => (QUICK.has(r) ? 0 : DEEP.has(r) ? 2 : 1);
const DROP = [3, 5, 7] as const;
/** Each read's time (s after the snap) by drop, and the time added for each later read. */
const READ_BY = [2.2, 3, 3.8], READ_NEXT = 0.6;
/** shortcut: no scramble. The QB brain runs as soon as his progression is covered and a lane is open, and with no pass
 *  rush in this mode every lane is open: with it on he ran in most reps (measured 1 v 1: 4–7 of 8 per coverage, most
 *  for 75 yd touchdowns). Turn it on once the brain holds a read until its time or scrambles only under pressure. */
const SCRAMBLE = false;
/** Concepts: every receiver's route at once, WR1 wide, WR2 wide on the other side, WR3 the slot on WR1's side (the
 *  usual pass-game concepts, simplified to these alignments). */
export const CONCEPTS: Record<string, { label: string; routes: Omit<RouteAssign, 'kind'>[] }> = {
  smash: { label: 'Smash (hitches outside, slot corner)', routes: [{ route: 'hitch' }, { route: 'hitch' }, { route: 'corner' }] },
  flood: { label: 'Flood (go, slot out, backside dig)', routes: [{ route: 'go' }, { route: 'dig' }, { route: 'out' }] },
  mesh: { label: 'Mesh (two shallow crossers, slot seam)', routes: [{ route: 'in', depth: 5 * YD }, { route: 'in', depth: 3 * YD }, { route: 'seam' }] },
  verts: { label: 'Verticals (everyone deep)', routes: [{ route: 'go' }, { route: 'go' }, { route: 'seam' }] },
};
const COVERAGE = { off: 'man off', press: 'man press', zone: 'zone' } as const;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export const PASS_MODE: ModeDef = {
  id: 'pass', title: 'QB 1-on-1', preview: 'modes/pass.jpg',
  pitch: 'Quarterback, receivers and defensive backs, one to three a side. Throw them open, win at the catch point, or blanket them and pick it off.',
  options: [
    { id: 'role', label: 'Your role', kind: 'choice', default: 'qb', choices: [
      { id: 'qb', label: 'Quarterback' }, { id: 'wr', label: 'Receiver' }, { id: 'cb', label: 'Cornerback' }] },
    { id: 'receivers', label: 'Receivers (and defensive backs)', kind: 'range', min: 1, max: 3, step: 1, default: 1 },
    { id: 'concept', label: 'Pass concept (bots)', kind: 'choice', default: 'none', choices: [
      { id: 'none', label: 'None: the WR1 route below' }, ...Object.entries(CONCEPTS).map(([id, c]) => ({ id, label: c.label }))] },
    { id: 'route', label: 'WR1 route (bot; the others random)', kind: 'choice', default: 'random', choices: [
      ...ROUTE_CHOICES.map((r) => ({ id: r, label: cap(r) })), { id: 'random', label: 'Random' }] },
    { id: 'coverage', label: 'Coverage', kind: 'choice', default: 'off', choices: [
      { id: 'off', label: 'Man off (7 yd cushion)' }, { id: 'press', label: 'Man press' }, { id: 'zone', label: 'Zone (deep thirds / halves)' }] },
    { id: 'los', label: 'Line of scrimmage (your yard line)', kind: 'range', min: 5, max: 95, step: 5, default: 25, unit: 'yd' },
    { id: 'timeLimit', label: 'Time limit', kind: 'range', min: 5, max: 30, step: 1, default: 12, unit: 's' },
  ],
  athletes: (o) => 1 + 2 * +o.receivers,
  setup(o, rng) {
    const role = o.role as PassRole, n = +o.receivers, O: 0 | 1 = role === 'cb' ? 1 : 0, D = (1 - O) as 0 | 1, s = attackDir(O), z0 = ownYard(O, +o.los), side = rng.next() < 0.5 ? 1 : -1;
    const cov = o.coverage as keyof typeof COVERAGE, concept = CONCEPTS[o.concept as string];
    const routes: RouteAssign[] = Array.from({ length: n }, (_, k) => ({ kind: 'route', ...(concept ? concept.routes[k] : { route: k === 0 && o.route !== 'random' ? (o.route as RouteKind) : rng.pick(ROUTE_CHOICES) }) }));
    // receivers: WR1 wide on a random side, WR2 wide on the other, WR3 in the slot on WR1's side
    const wrX = [side * SPLIT, -side * SPLIT, side * SLOT].slice(0, n);
    const at = (x: number, depth: number): [number, number] => [x, z0 + s * depth];
    type Spot = { spec: PlayerSpec; job: (idx: (key: string) => number) => Assignment };
    const spots: Record<string, Spot> = {};
    // the QB: drop by his first read's route, the receivers read in order, the shortest route the hot / checkdown man
    const cls = routes.map((r) => routeClass(r.route)), drop = DROP[cls[0]];
    const short = cls.indexOf(Math.min(...cls) as 0 | 1 | 2);
    spots.qb = { spec: { team: O, label: 'QB', group: 'Offense', pos: at(0, -QB_DEPTH) }, job: (idx) => ({
      kind: 'pass', drop, scramble: SCRAMBLE, reads: routes.map((_, k) => ({ target: idx(`wr${k}`), by: READ_BY[cls[0]] + k * READ_NEXT })),
      checkdown: idx(`wr${short}`), ...(cls[short] === 0 && { hot: idx(`wr${short}`) }) }) };
    routes.forEach((r, k) => { spots[`wr${k}`] = { spec: { team: O, label: `WR${k + 1}`, group: 'Offense', pos: at(wrX[k], k < 2 ? -ON_LINE : -OFF_LINE) }, job: () => r }; });
    // defensive backs: one over each receiver (the third one the safety); man: inside leverage on the outside men,
    // outside on the slot; zone: deep thirds (three), halves (two) or the deep third over WR1 (one)
    wrX.forEach((x, k) => {
      const out = Math.sign(x), lev = k < 2 ? 'inside' : 'outside', label = k < 2 ? `CB${k + 1}` : 'S';
      let pos: [number, number], job: Spot['job'];
      if (cov === 'zone') {
        const safety = k === 2, zone: ZoneKind = n === 2 ? 'deep-half' : 'deep-third';
        pos = safety ? at(0, SAFETY) : at(x - out * OFF.shade, OFF.depth);
        job = () => ({ kind: 'zone', zone, side: safety ? 0 : (out * s) as 1 | -1 });
      } else {
        const c = cov === 'press' ? PRESS : OFF;
        pos = at(x + (lev === 'inside' ? -out : out) * c.shade, c.depth);
        job = (idx) => ({ kind: 'man', target: idx(`wr${k}`), press: cov === 'press', leverage: lev, help: 'none' });
      }
      spots[`cb${k}`] = { spec: { team: D, label, group: 'Defense', pos }, job };
    });
    const wrs = routes.map((_, k) => `wr${k}`), cbs = routes.map((_, k) => `cb${k}`);
    const order = role === 'qb' ? ['qb', ...wrs, ...cbs] : role === 'wr' ? ['wr0', 'qb', ...wrs.slice(1), ...cbs] : ['cb0', 'qb', ...wrs, ...cbs.slice(1)];
    const idx = (key: string) => order.indexOf(key), full = order.map((key) => spots[key].job(idx));
    // the play call: a player's slot has no assignment (null); a bot's is filled in as its brain is made. The snap is
    // the rep's start (after the pre-roll)
    let P: Play | null = null;
    const frame: PlayFrame = { los: z0, dir: s, halfWidth: NFL.halfWidth, get snapTime() { return P ? P.repStart : 0; } };
    const call: PlayCall = { frame, offense: O, assign: order.map(() => null) };
    const made: Brain[] = [];
    const gain = (z: number) => Math.round((z - z0) * s / YD);
    const what = concept ? (o.concept as string) : routes.map((r) => r.route).join(' / ');
    return {
      players: order.map((key) => spots[key].spec), ball: { holder: idx('qb') }, rules: { ...NFL, timeLimit: +o.timeLimit }, los: z0,
      // one brain per bot for the whole play: the football brains play the catch, the run after it and an interception
      brain(play, i, r) {
        P = play;
        if (!made[i]) {
          const a = full[i], d = play.cfg.difficulty;
          call.assign[i] = a;
          made[i] = a.kind === 'pass' ? new QBBrain(r, d, call, i) : a.kind === 'route' ? new ReceiverBrain(r, d, call, i) : new DefensiveBackBrain(r, play.cfg.defense ?? d, call, i);
        }
        return made[i];
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
          case 'time':
            if (play.pass === 'complete') return off ? `Time: complete for ${yards}` : `Time: caught for ${yards}`;
            if (play.pass === 'intercepted') return off ? 'Time: intercepted' : 'Time: you picked it off';
            return play.pass === 'none' ? 'Time: the ball never came out' : 'Time';
          default: return '';
        }
      },
      status: (play) => `${play.human >= 0 ? `You are the ${play.mode.players[play.human].label}  ·  ` : ''}${what}  ·  ${COVERAGE[cov]}`,
    };
  },
};
