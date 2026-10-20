// Punt block: the bots punt from their own 30, you rush with your teammates against their protectors. The punt goes
// off the punter's foot after the snap-to-kick time unless a rusher is on the ball by then. A punt that hits a
// rusher, or never gets away, is blocked: a loose ball, live for both teams (scoop it and score). One that clears
// the line untouched is away; a punter brought down with the ball is a stop.
import { IdleBrain } from '../brains/idle';
import type { Vec3 } from '../math';
import { ballTouches, FLIGHT_MIN, goalposts, KICK_RULES, kick, lob, near, ownYard, PUNTER, row, SMOTHER, spotVerdict } from './kicks';
import { attackDir, YD } from './rules';
import type { ModeDef, PlayerSpec } from './types';

/** Line of scrimmage (the punting team's own yd line), the punt (yd past the line, hang s), and the ball past the
 *  line by this much (m) is away. */
const LOS = 30, PUNT = 45, HANG = 4.25, AWAY = 2, { depth: DEPTH, foot: FOOT } = PUNTER;

export const PUNT_BLOCK: ModeDef = {
  id: 'puntBlock', title: 'Punt Block', preview: 'modes/puntBlock.jpg',
  pitch: 'Fourth down, they are punting. Beat your man off the snap, get a hand on the ball and scoop it up.',
  options: [
    { id: 'rush', label: 'Your teammates', kind: 'range', min: 0, max: 8, step: 1, default: 1 },
    { id: 'protect', label: 'Their protectors', kind: 'range', min: 0, max: 8, step: 1, default: 1 },
    // an NFL operation takes 2.0-2.2 s, but at 2.1 s an unblocked bot rusher is still ~3.5 m short of the kick point
    { id: 'kickTime', label: 'Snap to kick', kind: 'range', min: 1.6, max: 3, step: 0.1, default: 2.4, unit: 's' },
  ],
  athletes: (o) => 2 + +o.rush + +o.protect,
  setup(o, rng) {
    const K = 1, s = attackDir(K), los = ownYard(K, LOS), pz = ownYard(K, LOS - DEPTH), P = 1 + +o.rush, kickAt = Math.round(+o.kickTime * 10) / 10;
    const e = 0.07 * rng.gauss();
    // you and your rushers on the line, their protectors across from you, the punter deep
    const rushers = row(0, 1 + +o.rush, los + s, 2.5, rng.range(-0.5, 0.5), 'Rusher', 'Rush'), protectors = row(K, +o.protect, los - s * 0.6, 2, 0, 'Protector', 'Punt team');
    const players: PlayerSpec[] = [...rushers, { team: K, label: 'Punter', group: 'Punt team', pos: [0, pz] }, ...protectors];
    let kicked = false, flight = false, kickedAt = 0;
    return {
      players, ball: { holder: P }, rules: KICK_RULES, props: goalposts(),
      // the punter waits for the snap-to-kick time; afterwards everyone plays the ball
      brain: (play, i, rng) => (i === P && !kicked && play.world.ballCarrier === P ? new IdleBrain(rng) : null),
      step(play) {
        const w = play.world;
        if (!kicked) {
          if (play.repTime < kickAt) return;
          kicked = true;
          if (w.ballCarrier !== P) return; // stripped before the kick: already a live ball
          const c = w.scene.athletes[P].state.com, from: Vec3 = [c[0], FOOT[1], c[2] + s * FOOT[0]];
          // a rusher on the ball: the punter never gets it away, it comes loose from his hands
          if (near(play, 0, from, SMOTHER)) { play.note = 'BLOCKED'; return play.ballLoose(K, false); }
          flight = true; kickedAt = play.repTime;
          return kick(play, K, lob(PUNT * YD + Math.abs(from[2] - los), HANG, FOOT[1], [Math.sin(e), s * Math.cos(e)]), [0, 0, 40], from);
        }
        if (!flight || play.repTime - kickedAt <= FLIGHT_MIN) return;
        const t = ballTouches(play), bc = w.ballCarrier;
        if (t.teams[0] || (bc >= 0 && play.team(bc) === 0)) { play.note = 'BLOCKED'; flight = false; if (bc < 0) play.reassign(); }
        else if (s * (play.ballPos()[2] - los) > AWAY) play.end('punt');
        else if (t.turf || t.teams[1] || bc >= 0) { flight = false; if (bc < 0) play.reassign(); }
      },
      verdict(play, T) {
        const spot = spotVerdict(play, T);
        return play.ended === 'punt' ? 'Punt away: no block'
          : play.note === 'BLOCKED' ? `Blocked!${spot ? ` ${spot}` : ''}`
          : play.ended === 'down' && play.world.ballCarrier === P ? 'Punter brought down' : spot;
      },
      status: (play) => `Block the punt  ·  ${kickAt.toFixed(1)} s snap to kick${play.note ? `  ·  ${play.note}` : ''}`, // the note reaches guests
    };
  },
};
