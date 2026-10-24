// A play from scrimmage of any size (Drive, Pass Rush, 11 on 11): one play call (brains/football/types.ts) for a
// lineup of quarterback, linemen, receivers (wide outs, a tight end, a running back), and a defense of linemen,
// linebackers, corners and safeties. The bots are the football brains playing it (as in QB 1-on-1, pass.ts): the QB
// his progression, each receiver his route, each defender his man or zone. Linemen have no football brain yet: they
// play the default roles (a blocker protects the ball holder, a rusher tackles him), so a pass rush is physics. A run
// play is a direct snap to the running back (there is no handoff): he runs, everyone else on offense blocks.
import { qbSkill, qbTuning } from '../brains/football/qbTuning';
import { DefensiveBackBrain } from '../brains/football/db';
import { QBBrain } from '../brains/football/qb';
import { ReceiverBrain } from '../brains/football/receiver';
import type { Assignment, PlayCall, PlayFrame, RouteKind, ZoneKind } from '../brains/football/types';
import type { Brain } from '../brains/types';
import type { Rng } from '../rng';
import { DROP, READ_BY, READ_NEXT, ROUTE_CHOICES, routeClass, SLOT, SPLIT } from './pass';
import type { Play } from './play';
import { attackDir, NFL, nth, YD } from './rules';
import type { PlayerSpec, PlaySetup } from './types';

export interface Lineup {
  /** The team on offense, the line of scrimmage (world z, m), and the side WR1 lines up on (world x sign). */
  O: 0 | 1; los: number; side: 1 | -1;
  ol: number; wr: number; te: boolean; rb: boolean;
  dl: number; lb: number; cb: number; s: number;
  coverage: 'man' | 'zone';
  /** Direct snap to the running back (needs rb). */
  run: boolean;
  /** The bot QB may scramble (pass.ts SCRAMBLE: only with a pass rush). */
  scramble: boolean;
  /** The human's spot ('qb', 'wr0', 'ol1', 'dl0', 'cb1', 's0'…): athlete 0. Absent: 'qb'. A defensive spot needs dl. */
  human?: string;
}

/** Alignment (m, depth downfield of the LOS): linemen half a metre off it, spaced OL_W / DL_W; the QB in the shotgun
 *  (5 yd) behind a line, under centre (QB_ALONE) without one; the back beside him RB_X to one side; the tight end next
 *  to the tackle; linebackers LB_DEPTH off, LB_W apart; corners 7 yd off shaded inside (man) or outside (zone); the
 *  free safety 12 yd deep, the strong safety 6 yd (man, over his man) or 8 yd (zone). */
const LINE = 0.5, OL_W = 1.5, DL_W = 1.8, DL_DEPTH = 0.8, SHOTGUN = 5 * YD, QB_ALONE = 1, RB_X = 1.5;
/** Shotgun drops by the first read's route (quick, intermediate, deep): none, 3 and 5 steps (from 5 yd deep these
 *  set where an under-centre 3, 5 and 7 step drop would). No hot route behind a line: the QB brain counts a rusher by
 *  his distance and closing speed, not by whether a man is blocking him, so a defensive lineman a few yards away at
 *  the snap would set off the hot throw on every play; he reads his progression and reacts to the rusher who comes
 *  free (sense.nearestRush: a blocked one stops closing). */
const SHOTGUN_DROP = [0, 3, 5] as const;
const LB_DEPTH = 4.5 * YD, LB_W = 3.5, CB_DEPTH = 7 * YD, CB_SHADE = 0.8, FS_DEPTH = 12 * YD, SS_DEPTH = [6 * YD, 8 * YD];
/** Underneath zones in Cover 3, in the order the extra defenders take them (side in world-x sign before the turn to
 *  the offense's view). */
const UNDER: [ZoneKind, 1 | -1 | 0][] = [['curl', 1], ['curl', -1], ['hook', 1], ['hook', -1], ['middle', 0], ['flat', 1], ['flat', -1]];
const TE_ROUTES: RouteKind[] = ['seam', 'out', 'curl', 'in'];

/** One play from scrimmage: players (the human first), the ball, the shared rules with this LOS, and the brains.
 *  `rng` places nothing at random but the routes. */
export function scrimmage(L: Lineup, rng: Rng): PlaySetup & { order: string[]; jobs: Assignment[] } {
  const { O, los: z0, side } = L, D = (1 - O) as 0 | 1, s = attackDir(O);
  const at = (x: number, depth: number): [number, number] => [x, z0 + s * depth];
  const spec: Record<string, PlayerSpec> = {}, job: Record<string, (idx: (k: string) => number) => Assignment> = {};
  const add = (key: string, team: 0 | 1, label: string, pos: [number, number], j: (idx: (k: string) => number) => Assignment) => {
    spec[key] = { team, label, group: team === O ? 'Offense' : 'Defense', pos }; job[key] = j;
  };
  // offense: receivers (WR1 wide on `side`, WR2 wide on the other, WR3 the slot on WR1's side; TE beside the tackle
  // on WR2's side; RB offset to WR2's side) and their routes
  const wrX = [side * SPLIT, -side * SPLIT, side * SLOT];
  const eligible: string[] = [], routes: Record<string, RouteKind> = {};
  for (let k = 0; k < L.wr; k++) { eligible.push(`wr${k}`); routes[`wr${k}`] = rng.pick(ROUTE_CHOICES); }
  if (L.te) { eligible.push('te'); routes.te = rng.pick(TE_ROUTES); }
  if (L.rb) { eligible.push('rb'); routes.rb = 'flat'; }
  const run = L.run && L.rb;
  for (let k = 0; k < L.ol; k++) add(`ol${k}`, O, nth('Lineman', k, L.ol), at((k - (L.ol - 1) / 2) * OL_W, -LINE), () => ({ kind: 'block' }));
  for (let k = 0; k < L.wr; k++) add(`wr${k}`, O, `WR${k + 1}`, at(wrX[k], k < 2 ? -LINE : -1.2), () => (run ? { kind: 'block' } : { kind: 'route', route: routes[`wr${k}`] }));
  if (L.te) add('te', O, 'TE', at(-side * ((L.ol - 1) / 2 * OL_W + OL_W), -LINE), () => (run ? { kind: 'block' } : { kind: 'route', route: routes.te }));
  const qbDepth = L.ol ? SHOTGUN : QB_ALONE;
  if (L.rb) add('rb', O, 'RB', at(-side * RB_X, -Math.max(qbDepth, 2)), () => (run ? { kind: 'run' } : { kind: 'route', route: 'flat' }));
  // the QB: drop by his first read's route, reads in order, the shortest route the checkdown (hot when quick and no line)
  const cls = eligible.map((k) => routeClass(routes[k])), first = cls[0] ?? 1, short = cls.indexOf(Math.min(...cls) as 0 | 1 | 2);
  add('qb', O, 'QB', at(0, -qbDepth), (idx) => (run ? { kind: 'block' } : {
    kind: 'pass', drop: (L.ol ? SHOTGUN_DROP : DROP)[first], scramble: L.scramble, reads: eligible.map((k, n) => ({ target: idx(k), by: READ_BY[first] + n * READ_NEXT })),
    ...(eligible.length && { checkdown: idx(eligible[short]) }), ...(cls[short] === 0 && !L.ol && { hot: idx(eligible[short]) }) }));
  // defense: the line rushes; man (Cover 1): the free safety deep middle, corners, the strong safety and the
  // linebackers take the receivers in order, anyone left over a hook; zone (Cover 3): corners and the free safety the
  // deep thirds, everyone else the underneath zones
  for (let k = 0; k < L.dl; k++) add(`dl${k}`, D, nth('DL', k, L.dl), at((k - (L.dl - 1) / 2) * DL_W, DL_DEPTH), () => ({ kind: 'rush' }));
  const deep = (out: number): Assignment => ({ kind: 'zone', zone: 'deep-third', side: (out * s) as 1 | 0 | -1 });
  const cover = L.coverage === 'man' ? eligible.slice() : [];
  let under = 0;
  const rest = (): ((idx: (k: string) => number) => Assignment) => {
    const t = cover.shift();
    if (t) return (idx) => ({ kind: 'man', target: idx(t), press: false, leverage: t === 'wr2' ? 'outside' : 'inside', help: 'none' });
    const [zone, out] = UNDER[under++ % UNDER.length];
    return () => ({ kind: 'zone', zone: L.coverage === 'man' ? 'hook' : zone, side: (out * side * s) as 1 | 0 | -1 });
  };
  for (let k = 0; k < L.cb; k++) {
    const x = k < 2 ? wrX[k] : side * SLOT, out = Math.sign(x);
    if (L.coverage === 'zone') add(`cb${k}`, D, nth('CB', k, L.cb), at(x - out * CB_SHADE, CB_DEPTH), () => deep(out));
    else add(`cb${k}`, D, nth('CB', k, L.cb), at(x + (k < L.wr ? -out : out) * CB_SHADE, CB_DEPTH), rest());
  }
  for (let k = 0; k < L.s; k++) {
    const label = L.s === 1 ? 'S' : k === 0 ? 'FS' : 'SS';
    if (k === 0) { add('s0', D, label, at(0, FS_DEPTH), () => deep(0)); continue; }
    const t = cover[0], x = t?.startsWith('wr') ? wrX[+t.slice(2)] : side * 6;
    add(`s${k}`, D, nth(label, k - 1, L.s - 1), at(x, SS_DEPTH[t ? 0 : 1]), rest());
  }
  for (let k = 0; k < L.lb; k++) add(`lb${k}`, D, nth('LB', k, L.lb), at((k - (L.lb - 1) / 2) * LB_W, LB_DEPTH), rest());
  // athlete order: the human first, then offense and defense in a fixed order
  // a spot this lineup lacks (WR3 of two) falls back to the first of its kind, else the QB or the first lineman
  const keys = Object.keys(spec), kind = (k: string) => k.replace(/\d+$/, ''), want = L.human ?? 'qb';
  const me = spec[want] ? want : keys.find((k) => kind(k) === kind(want)) ?? (/^(dl|lb|cb|s)$/.test(kind(want)) ? 'dl0' : 'qb');
  const order = [me, ...['qb', 'ol', 'wr', 'te', 'rb', 'dl', 'lb', 'cb', 's'].flatMap((p) => keys.filter((k) => kind(k) === p && k !== me))];
  const idx = (k: string) => order.indexOf(k), jobs = order.map((k) => job[k](idx));
  // the play call: a human receiver's slot stays empty (the brains read a player's route from his run, and he counts
  // as eligible); every other slot carries its job (a lineman's keeps the coverage off him)
  let P: Play | null = null;
  const frame: PlayFrame = { los: z0, dir: s, halfWidth: NFL.halfWidth, get snapTime() { return P ? P.repStart : 0; } };
  const call: PlayCall = { frame, offense: O, assign: jobs.map((a, i) => (i === 0 && a.kind === 'route' ? null : a)) };
  const made: Brain[] = [];
  return {
    order, jobs, players: order.map((k) => spec[k]), ball: { holder: idx(run ? 'rb' : 'qb') }, rules: { ...NFL }, los: z0,
    // one football brain per bot for the whole play; linemen and a running back on a run play: the default roles
    brain(play, i, r) {
      P = play;
      const a = jobs[i], d = play.cfg.difficulty;
      if (a.kind === 'block' || a.kind === 'rush' || a.kind === 'run') return null;
      return made[i] ??= a.kind === 'pass' ? new QBBrain(r, qbSkill(qbTuning(play.cfg.qb).skill), call, i, play.cfg.qb)
        : a.kind === 'route' ? new ReceiverBrain(r, d, call, i) : new DefensiveBackBrain(r, play.cfg.defense ?? d, call, i);
    },
  };
}

/** Yards gained from the LOS z0 by the team attacking `s` with the ball at z (whole yards). */
export const gained = (z: number, z0: number, s: 1 | -1) => Math.round((z - z0) * s / YD);

/** What the play came to, from the offense's side (`off`) or the defense's (O: the offense, qb: his QB's athlete): a
 *  pass play's words as QB 1-on-1's, a run's, a sack, a lost fumble. '' when the shared words fit. */
export function playWords(play: Play, off: boolean, yd: number, O: 0 | 1, qb: number): string {
  const yards = yd < 0 ? `a loss of ${-yd} yd` : `${yd} yd`, bc = play.world.ballCarrier;
  switch (play.ended) {
    case 'incomplete': return 'Incomplete';
    case 'touchdown': return play.pass === 'intercepted' ? (off ? 'Pick six against you' : 'Pick six!') : '';
    case 'safety': return off ? 'Safety against you' : 'Safety!';
    case 'down': case 'out': case 'time':
      if (play.pass === 'intercepted') return off ? 'Intercepted' : 'You picked it off';
      if (bc >= 0 && play.team(bc) !== O) return off ? 'Fumble lost' : 'Fumble recovered!';
      if (bc < 0) return play.ended === 'time' ? 'Time: the ball is loose' : 'Ball out of bounds';
      if (play.pass === 'complete') return off ? `Complete for ${yards}` : `Caught for ${yards}`;
      if (bc === qb && play.pass === 'none' && yd < 0 && play.ended === 'down') return off ? `Sacked for ${-yd} yd` : `Sack! ${-yd} yd`;
      return off ? `Run for ${yards}` : `Stopped after ${yards}`;
    default: return '';
  }
}
