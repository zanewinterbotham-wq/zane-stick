// Pass Rush: you are a defensive lineman against a bot quarterback and his blockers, with receivers covered man to
// man behind you. Beat the block (physics: hands, leverage, a rip or a bull rush) and get him down before he throws.
// Under a real rush the bot QB may scramble (pass.ts SCRAMBLE is off only for want of a rush). You win the rep with a
// sack, an incompletion, a takeaway or any play he gains nothing on.
import { ownYard } from './kicks';
import type { Play } from './play';
import { gained, playWords, scrimmage } from './scrimmage';
import type { ModeDef } from './types';

export const PASS_RUSH: ModeDef = {
  id: 'passRush', title: 'Pass Rush', preview: 'modes/passRush.jpg',
  pitch: 'Beat your blocker and get to the quarterback before he throws, and stay in your lane: flush him and he will scramble.',
  options: [
    { id: 'blockers', label: 'Their blockers', kind: 'range', min: 1, max: 3, step: 1, default: 1 },
    { id: 'mates', label: 'Rushers with you', kind: 'range', min: 0, max: 2, step: 1, default: 0 },
    { id: 'receivers', label: 'Receivers (each covered man to man)', kind: 'range', min: 1, max: 2, step: 1, default: 1 },
    { id: 'los', label: 'Line of scrimmage (their yard line)', kind: 'range', min: 5, max: 95, step: 5, default: 30, unit: 'yd' },
    { id: 'timeLimit', label: 'Time limit', kind: 'range', min: 5, max: 20, step: 1, default: 10, unit: 's' },
  ],
  athletes: (o) => 1 + +o.blockers + 1 + +o.mates + 2 * +o.receivers,
  setup(o, rng) {
    const z0 = ownYard(1, +o.los), side = rng.next() < 0.5 ? 1 : -1, n = +o.receivers;
    const ps = scrimmage({ O: 1, los: z0, side, ol: +o.blockers, wr: n, te: false, rb: false, dl: 1 + +o.mates, lb: 0, cb: n, s: 0, coverage: 'man', run: false, scramble: true, human: 'dl0' }, rng);
    const qb = ps.order.indexOf('qb'), yd = (play: Play) => gained(play.ballPos()[2], z0, -1);
    return {
      ...ps, rules: { ...ps.rules, timeLimit: +o.timeLimit },
      ended(play) {
        // the rush (team 0) wins every rep the offense gains nothing on
        if (play.ended === 'touchdown' && play.scorer === 1) return;
        const bc = play.world.ballCarrier, theirs = bc >= 0 ? play.team(bc) === 1 : play.impetus === 1;
        if (play.ended === 'incomplete' || play.pass === 'intercepted' || !theirs || yd(play) <= 0) { play.scorer = 0; play.points = 1; }
      },
      verdict(play, T) {
        if (play.ended === 'time' && play.pass === 'none' && play.world.ballCarrier === qb) return T === 0 ? 'Time: he never got it out' : 'Time: the ball never came out';
        return playWords(play, T === 1, yd(play), 1, qb);
      },
      status: () => `Get to the QB  ·  ${+o.blockers} blocker${+o.blockers > 1 ? 's' : ''}  ·  ${n} receiver${n > 1 ? 's' : ''} in man  ·  he can scramble`,
    };
  },
};
