// What the special-teams modes share. There is no kicking leg model, so the kick is the one setup action: at the kick
// moment the ball gets its launch velocity once (PhysicsScene.launchProp), as the rep start tucks it in a hand.
// Flight, bounces, catches, muffs, blocks and returns are physics and the shared rules (play.ts), plus the NFL kick
// rules below: the kicking team may recover a kick the receivers never had but not advance it, a punt that touches
// the receivers' end zone and a kickoff that stops there are touchbacks.
import { BALL } from '../anatomy/equipment';
import { BlockerBrain } from '../brains/blocker';
import { CoverBrain, type CoverLane } from '../brains/cover';
import { IdleBrain } from '../brains/idle';
import { ReturnerBrain } from '../brains/returner';
import type { Brain } from '../brains/types';
import { neutralCommands } from '../control/types';
import type { Vec3 } from '../math';
import type { PropDesc } from '../physics/engine';
import type { Rng } from '../rng';
import type { Play } from './play';
import { attackDir, END_LINE, GOAL_LINE, inOwnEndZone, NFL, YD } from './rules';
import type { PlayerSpec, PlaySetup, Rules } from './types';

const G = 9.81;
/** A ball lying on its side on the turf (centre). */
export const BALL_REST_Y = BALL.diameter / 2 + 0.005;
/** A loose ball this low (m, centre) is on the turf. */
const ON_TURF = 0.25;
/** Ball contacts this soon after the kick (s) are the ones it is leaving (the turf it lay on). */
const FLIGHT_MIN = 0.1;
/** A rusher with any segment this close to the kick point (m) when the ball should go is on it: no kick. */
export const SMOTHER = 0.45;
/** NFL goalposts (m): crossbar height, half the gap inside the uprights, uprights above the crossbar, tube radius,
 *  and the gooseneck's base behind the end line. */
export const POST = { crossbar: 3.05, halfGap: 2.82, above: 10.67, r: 0.06, base: 1.83 };
/** Plays with kicks end here at the latest (s). */
export const KICK_RULES: Rules = { ...NFL, timeLimit: 40 };

/** Waits where he lined up (IdleBrain): the kicker and the punter until the ball is away. */
export const hold = (rng: Rng): Brain => new IdleBrain(rng);
/** Everyone set, still, for the moment before a kickoff or a return's kick (KICK_AT: too short to idle in). */
const SET: Brain = { think: () => neutralCommands() };

/** z of a team's own yard line `yd` (0: its own goal line, 50: midfield). */
export const ownYard = (team: 0 | 1, yd: number) => attackDir(team) * (yd * YD - GOAL_LINE);

/** Where z is, from the player's side (team 0): "your 27", "the 50", "their 40", an end zone. */
export function yardLine(z: number): string {
  if (z < -GOAL_LINE) return 'your end zone';
  if (z > GOAL_LINE) return 'their end zone';
  const yd = Math.round((z + GOAL_LINE) / YD);
  return yd === 50 ? 'the 50' : yd < 50 ? `your ${yd}` : `their ${100 - yd}`;
}

/** Launch velocity of a kick from height y0 that lands `range` m away along the unit ground direction `dir`,
 *  `hang` s later (no air drag in the scene: a vacuum trajectory). */
export function lob(range: number, hang: number, y0: number, dir: [number, number]): Vec3 {
  return [dir[0] * range / hang, (G * hang * hang / 2 - y0) / hang, dir[1] * range / hang];
}

/** Goalposts at both end lines, static, so a kick that hits one bounces off it (the uprights stand on the end line,
 *  the gooseneck behind it, out of bounds). */
export function goalposts(): PropDesc[] {
  const { crossbar: h, halfGap: g, above: u, r, base: b } = POST;
  const post = (shape: 'box' | 'capsule', size: number[], pos: Vec3): PropDesc => ({ name: 'goalpost', shape, size, mass: 0, pos, friction: 0.5 });
  return [1, -1].flatMap((s) => {
    const z = s * END_LINE;
    return [
      post('capsule', [r, u / 2], [g + r, h + u / 2, z]), post('capsule', [r, u / 2], [-g - r, h + u / 2, z]),
      post('box', [g + r, r, r], [0, h, z]), post('box', [r, r, b / 2], [0, h, z + s * b / 2]),
      post('capsule', [1.5 * r, h / 2], [0, h / 2, z + s * b]),
    ];
  });
}

/** The kick: the ball leaves the holder's hand (if any) and, moved to `from` when given (a punt, off the foot), gets
 *  its launch velocity and spin (prop frame: the ball's long axis is its z). */
export function kick(play: Play, team: 0 | 1, vel: Vec3, spin: Vec3, from?: Vec3) {
  play.ballLoose(team);
  if (from) play.world.scene.placeProp(play.ball, from, [0, 0, 0, 1]);
  play.world.scene.launchProp(play.ball, vel, spin);
}

/** What the ball touched in the last step: the turf, and each team's bodies. */
export function ballTouches(play: Play) {
  let turf = false;
  const teams = [false, false];
  for (const c of play.world.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]] as const) {
    if (p.athlete >= 0 || p.seg !== play.ball) continue;
    if (o.athlete >= 0) teams[play.team(o.athlete)] = true;
    else if (o.seg < 0) turf = true;
  }
  return { turf, teams };
}

/** Whether any athlete of `team` has a segment within r of the point. */
export function near(play: Play, team: 0 | 1, at: Vec3, r: number) {
  return play.world.athletes.some((a, i) => {
    if (a.setup.team !== team) return false;
    const c = play.world.scene.athletes[i].state.segCom;
    for (let k = 0; k < c.length; k += 3) if (Math.hypot(c[k] - at[0], c[k + 1] - at[1], c[k + 2] - at[2]) < r) return true;
    return false;
  });
}

/** Every bot thinks again: the kick came down, so roles change without a change of possession. */
export function rethink(play: Play) { for (let i = 1; i < play.brains.length; i++) play.brains[i] = play.roleBrain(i); }

/** n players of `team` in a row across the field at z: from x0 outward, alternating sides, `gap` m apart. */
export function row(team: 0 | 1, n: number, z: number, gap: number, x0 = 0): PlayerSpec[] {
  return Array.from({ length: n }, (_, k) => ({ team, pos: [x0 + (k % 2 ? -1 : 1) * gap * Math.ceil(k / 2), z] as [number, number] }));
}

/** The result card's title from the player's side, with the spot. '' leaves the game's own title. */
export function spotVerdict(play: Play): string {
  const bc = play.world.ballCarrier, at = yardLine(play.ballPos()[2]);
  const who = bc === play.human ? 'You were' : bc >= 0 && play.team(bc) === 0 ? 'Your teammate was' : 'Their runner was';
  switch (play.ended) {
    case 'down': return `${who} tackled at ${at}`;
    case 'out': return bc < 0 ? `Ball out of bounds at ${at}` : `${who} forced out at ${at}`;
    case 'downed': return `${play.team(bc) === 0 ? 'Your team' : 'The kicking team'} downs the kick at ${at}`;
    case 'touchdown': return play.scorer === 0 ? 'Touchdown!' : 'Touchdown against you';
    case 'touchback': return 'Touchback';
    default: return '';
  }
}

export interface ReturnSpec {
  kind: 'kickoff' | 'punt';
  kicking: 0 | 1;
  players: PlayerSpec[];
  returner: number;
  /** A punt's punter: he holds the ball until the kick. */
  punter?: number;
  /** The kicker or the punter: the coverage's safety. */
  safety: number;
  /** Where the ball leaves from: a kickoff's tee spot (it lies there from the start), a punt's foot. */
  from: Vec3;
  vel: Vec3;
  spin: Vec3;
  status: string;
}

/** Everyone set this long (s) after the rep starts, then the kick. */
const KICK_AT = 0.3;

/** The coverage's assignments: every man of the kicking team but the safety keeps the lane he lines up in, the
 *  outermost on each side (of two or more) contain; the safety trails. */
export function coverLanes(players: PlayerSpec[], K: 0 | 1, safety: number): (CoverLane | undefined)[] {
  const men = players.map((p, i) => ({ x: p.pos[0], i })).filter(({ i }) => players[i].team === K && i !== safety).sort((a, b) => a.x - b.x);
  const lanes: (CoverLane | undefined)[] = players.map((p, i) => (i === safety ? { x: p.pos[0], role: 'safety' } : undefined));
  men.forEach(({ x, i }, k) => { lanes[i] = { x, role: men.length > 1 && (k === 0 || k === men.length - 1) ? 'contain' : 'lane' }; });
  return lanes;
}

/** A kick to a returner: kickoff or punt (the snap is over when the rep starts). While the ball is in the air the
 *  returner goes to meet it, his teammates set up a wall in front of him and block the coverage, and the coverage
 *  runs down in its lanes (CoverBrain), staying in them while the returner has the ball until each man is near him;
 *  a loose ball after that, and every other role, is the play's own (the holder runs, his teammates block, the
 *  others tackle or go for the ball). */
export function returnPlay(s: ReturnSpec): PlaySetup {
  const K = s.kicking, R = K === 0 ? 1 : 0, punt = s.kind === 'punt', lanes = coverLanes(s.players, K, s.safety);
  let kicked = false, flight = false, kickedAt = 0, received = false;
  return {
    players: s.players,
    ball: punt ? { holder: s.punter! } : { at: s.from, impetus: K },
    rules: KICK_RULES,
    props: goalposts(),
    brain(play, i, rng) {
      if (!kicked) return SET;
      const bc = play.world.ballCarrier, lane = lanes[i];
      if (lane && (bc < 0 ? flight : play.team(bc) === R)) return new CoverBrain(rng, play.cfg.defense ?? play.cfg.difficulty, lane);
      // a catch changes possession before this play's step sees the flight is over
      if (!flight || bc >= 0) return null;
      if (i === s.returner) return new ReturnerBrain(rng, play.cfg.difficulty);
      return play.team(i) === R ? new BlockerBrain(rng, play.cfg.difficulty) : null;
    },
    step(play) {
      if (!kicked) {
        if (play.repTime < KICK_AT) return;
        kicked = flight = true; kickedAt = play.repTime;
        return kick(play, K, s.vel, s.spin, punt ? s.from : undefined);
      }
      const r = play.rules, bc = play.world.ballCarrier, b = play.ballPos();
      if (bc >= 0 && play.team(bc) === R) received = true;
      if (flight && play.repTime - kickedAt > FLIGHT_MIN) {
        const t = ballTouches(play);
        if (bc >= 0 || t.turf || t.teams[0] || t.teams[1]) { flight = false; if (bc < 0) rethink(play); }
      }
      if (received) return;
      if (bc >= 0 && play.team(bc) === K) {
        // a kickoff the kicking team recovers in the end zone is a touchdown (the shared rules score it next step)
        if (!inOwnEndZone(r, R, b[2])) return play.end('downed');
        if (punt) return play.end('touchback');
        return;
      }
      if (bc < 0 && b[1] < ON_TURF && inOwnEndZone(r, R, b[2])) {
        const v = play.world.scene.propVel(play.ball);
        if (punt || Math.hypot(v[0], v[1], v[2]) < 1) play.end('touchback');
      }
    },
    ended(play) { play.verdict = spotVerdict(play); },
    status: () => s.status,
  };
}
