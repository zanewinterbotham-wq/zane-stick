// Drive: your offense has to score. Four downs to gain ten yards, a first down resets them; a touchdown, a turnover
// (an interception, a lost fumble), a safety or a turnover on downs ends the drive, and the next rep starts a new
// one. One play per rep (scrimmage.ts: QB, linemen and receivers against a rush and man or zone coverage, picked per
// play); the down, the distance and the spot carry from rep to rep.
import type { Play } from './play';
import { ownYard, yardLine } from './kicks';
import { GOAL_LINE, YD } from './rules';
import { gained, playWords, scrimmage } from './scrimmage';
import type { FieldLines, ModeDef, ModeOptions } from './types';

/** A drive between plays: the down (1–4), the ball's spot and the line to gain (own yard lines, 100 = the goal line),
 *  and why it is over ('' while it goes on). */
export interface DriveState { down: number; spot: number; line: number; over: '' | 'td' | 'safety' | 'turnover' | 'downs' }
/** How a play ended for the drive: a new spot, an incompletion, or an end of the drive. */
export type DriveResult = { spot: number } | 'incomplete' | 'td' | 'safety' | 'turnover';

export const freshDrive = (spot: number): DriveState => ({ down: 1, spot, line: Math.min(100, spot + 10), over: '' });

/** The drive after one play (NFL, no penalties): gaining the line is a first down; else the next down, and after the
 *  fourth the ball goes over. */
export function nextDown(d: DriveState, r: DriveResult): DriveState {
  if (typeof r === 'string' && r !== 'incomplete') return { ...d, over: r };
  const spot = r === 'incomplete' ? d.spot : r.spot;
  if (spot >= d.line) return freshDrive(spot);
  return d.down >= 4 ? { ...d, spot, over: 'downs' } : { ...d, down: d.down + 1, spot };
}

/** The drive in play.note (snapshots carry it to a guest and from the physics Worker): "D down,spot,line,over". */
export const encodeDrive = (d: DriveState) => `D ${d.down},${d.spot},${d.line},${d.over}`;
export function decodeDrive(note: string): DriveState | null {
  const m = /^D (\d),(\d+),(\d+),(\w*)$/.exec(note);
  return m ? { down: +m[1], spot: +m[2], line: +m[3], over: m[4] as DriveState['over'] } : null;
}

// shortcut: the drive lives in module state, one copy per JS realm (the page, the physics Worker, each guest), each
// kept in step from play.note when a play ends there; a game-level "previous rep's result" input would replace it.
let drive: { key: string; d: DriveState } | null = null;
/** Forget the drive in progress (tests). */
export function resetDrive() { drive = null; }
const keyOf = (o: ModeOptions) => JSON.stringify(o);
/** The drive for the next play with these options: the one in progress, else a new one from the start yard line. */
export const currentDrive = (o: ModeOptions): DriveState => (drive && drive.key === keyOf(o) && !drive.d.over ? drive.d : freshDrive(+o.start));
function remember(play: Play, o: ModeOptions) {
  const d = play.ended ? decodeDrive(play.note) : null;
  if (d) drive = { key: keyOf(o), d };
}

/** The blue and yellow lines for a drive; goal to go (the line to gain at the goal line) has no first-down line. */
export const driveLines = (d: DriveState): FieldLines => ({ scrimmage: ownYard(0, d.spot), ...(d.line < 100 ? { firstDown: ownYard(0, d.line) } : {}) });

const ORD = ['', '1st', '2nd', '3rd', '4th'];
/** "3rd & 4 at their 37", "1st & goal at their 6". */
export const downText = (d: DriveState) => `${ORD[d.down]} & ${d.line >= 100 ? 'goal' : d.line - d.spot} at ${yardLine(ownYard(0, d.spot))}`;
const OVER = { td: 'Touchdown! Drive complete', safety: 'Safety: drive over', turnover: 'Turnover: drive over', downs: 'Turnover on downs' };

const SIZES = { '3v3': { ol: 1, wr: 1, dl: 1, cb: 1 }, '5v5': { ol: 2, wr: 2, dl: 2, cb: 2 } } as const;

export const DRIVE: ModeDef = {
  id: 'drive', title: 'Drive', preview: 'modes/drive.jpg',
  pitch: 'Four downs to gain ten yards, a first down resets them. Move the chains play by play and punch it in before a turnover ends the drive.',
  options: [
    { id: 'size', label: 'Team size', kind: 'choice', default: '3v3', choices: [{ id: '3v3', label: '3 v 3' }, { id: '5v5', label: '5 v 5' }] },
    { id: 'role', label: 'Your role', kind: 'choice', default: 'qb', choices: [{ id: 'qb', label: 'Quarterback' }, { id: 'wr0', label: 'Receiver' }] },
    { id: 'start', label: 'Start (your yard line)', kind: 'range', min: 5, max: 80, step: 5, default: 25, unit: 'yd' },
    { id: 'timeLimit', label: 'Time limit per play', kind: 'range', min: 8, max: 30, step: 1, default: 15, unit: 's' },
  ],
  athletes: (o) => 2 * (o.size === '5v5' ? 5 : 3),
  setup(o, rng) {
    const d = currentDrive(o), z0 = ownYard(0, d.spot), n = SIZES[o.size as keyof typeof SIZES] ?? SIZES['3v3'];
    const side = rng.next() < 0.5 ? 1 : -1, coverage = rng.next() < 0.5 ? 'man' : 'zone';
    const ps = scrimmage({ O: 0, los: z0, side, ...n, te: false, rb: false, lb: 0, s: 1, coverage, run: false, scramble: false, human: o.role as string }, rng);
    const qb = ps.order.indexOf('qb');
    const routes = ps.jobs.flatMap((a, i) => (a.kind === 'route' && i !== 0 ? [`${ps.players[i].label} ${a.route}`] : [])).join(', ');
    return {
      ...ps, rules: { ...ps.rules, timeLimit: +o.timeLimit }, lines: () => driveLines(d),
      // the drive after this play, into play.note for every screen
      ended(play) {
        const bc = play.world.ballCarrier, has = bc >= 0 ? play.team(bc) : play.impetus;
        const r: DriveResult = play.ended === 'touchdown' ? (play.scorer === 0 ? 'td' : 'turnover') : play.ended === 'safety' ? 'safety'
          : play.ended === 'touchback' || play.pass === 'intercepted' || has !== 0 ? 'turnover' : play.ended === 'incomplete' ? 'incomplete'
          : { spot: Math.min(99, Math.max(1, Math.round((play.ballPos()[2] + GOAL_LINE) / YD))) };
        play.note = encodeDrive(nextDown(d, r));
        remember(play, o);
      },
      verdict(play, T) {
        remember(play, o);
        const next = decodeDrive(play.note), words = playWords(play, T === 0, gained(play.ballPos()[2], z0, 1), 0, qb);
        if (!next) return words;
        return `${words ? `${words}  ·  ` : ''}${next.over ? OVER[next.over] : next.down === 1 ? `First down! ${downText(next)}` : downText(next)}`;
      },
      status(play) {
        remember(play, o);
        const next = play.ended ? decodeDrive(play.note) : null;
        if (next?.over) return `${OVER[next.over]}  ·  next rep: a new drive from your ${+o.start}`;
        return `${downText(next ?? d)}  ·  ${coverage === 'man' ? 'man' : 'zone'} coverage${routes ? `  ·  ${routes}` : ''}`;
      },
    };
  },
};
