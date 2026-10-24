// 11 on 11: a full play from scrimmage, every position filled (scrimmage.ts). The offense runs a pass play (three
// wide outs, a tight end and a back on routes, five linemen protecting) or a run (a direct snap to the back, everyone
// else blocking); the defense rushes four and plays Cover 1 man or Cover 3 zone. Pick any position: by default the
// quarterback on a pass, the ball carrier on a run. Your side is team 0, so a defender's offense attacks the other way.
// It is heavy: measured in Node on a desktop, 3.3 ms per step on Low and 4.1 on High (6 athletes: 0.7 and 0.9), nearly
// all physics and controllers (the brains under 0.1 ms), so the menu warns, the presets' far-bot planning and physics
// Worker apply, and "7 per side" (two linemen a side, one safety) is the light version.
import { ownYard } from './kicks';
import type { Play } from './play';
import { gained, playWords, scrimmage } from './scrimmage';
import type { ModeDef } from './types';

const OFFENSE = ['auto', 'qb', 'rb', 'wr0', 'wr1', 'wr2', 'te', 'ol2'];
const LABELS: Record<string, string> = {
  auto: 'Quarterback (pass) / ball carrier (run)', qb: 'Quarterback', rb: 'Running back', wr0: 'Wide receiver 1', wr1: 'Wide receiver 2', wr2: 'Slot receiver',
  te: 'Tight end', ol2: 'Centre', dl0: 'Defensive line', lb1: 'Middle linebacker', cb0: 'Cornerback', s0: 'Free safety', s1: 'Strong safety',
};

export const ELEVEN: ModeDef = {
  id: 'eleven', title: '11 on 11', preview: 'modes/eleven.jpg',
  pitch: 'A full play from scrimmage with every position filled. Call pass or run, pick your spot on either side of the ball, and play it out.',
  options: [
    { id: 'perSide', label: 'Players per side', kind: 'choice', default: '11', choices: [{ id: '11', label: '11 (full)' }, { id: '7', label: '7 (lighter: two linemen a side)' }] },
    { id: 'position', label: 'Your position', kind: 'choice', default: 'auto', choices: Object.entries(LABELS).map(([id, label]) => ({ id, label })) },
    { id: 'play', label: 'Offense play call', kind: 'choice', default: 'pass', choices: [{ id: 'pass', label: 'Pass' }, { id: 'run', label: 'Run' }, { id: 'random', label: 'Random' }] },
    { id: 'coverage', label: 'Defense coverage', kind: 'choice', default: 'random', choices: [{ id: 'man', label: 'Cover 1 man' }, { id: 'zone', label: 'Cover 3 zone' }, { id: 'random', label: 'Random' }] },
    { id: 'los', label: 'Line of scrimmage (offense yard line)', kind: 'range', min: 5, max: 95, step: 5, default: 25, unit: 'yd' },
    { id: 'timeLimit', label: 'Time limit', kind: 'range', min: 8, max: 30, step: 1, default: 15, unit: 's' },
  ],
  athletes: (o) => 2 * (o.perSide === '7' ? 7 : 11),
  setup(o, rng) {
    const pos = o.position as string, O: 0 | 1 = OFFENSE.includes(pos) ? 0 : 1, z0 = ownYard(O, +o.los), side = rng.next() < 0.5 ? 1 : -1;
    const run = o.play === 'random' ? rng.next() < 0.4 : o.play === 'run', coverage = o.coverage === 'random' ? (rng.next() < 0.5 ? 'man' : 'zone') : o.coverage as 'man' | 'zone';
    const human = pos === 'auto' ? (run ? 'rb' : 'qb') : pos;
    const n = o.perSide === '7' ? { ol: 2, wr: 2, dl: 2, lb: 2, cb: 2, s: 1 } : { ol: 5, wr: 3, dl: 4, lb: 3, cb: 2, s: 2 };
    const ps = scrimmage({ O, los: z0, side, ...n, te: true, rb: true, coverage, run, scramble: false, human }, rng);
    const qb = ps.order.indexOf('qb'), s = O === 0 ? 1 : -1, yd = (play: Play) => gained(play.ballPos()[2], z0, s);
    return {
      ...ps, rules: { ...ps.rules, timeLimit: +o.timeLimit },
      verdict: (play, T) => playWords(play, T === O, yd(play), O, qb),
      status: (play) => `${play.human >= 0 ? `You are the ${play.mode.players[play.human].label}  ·  ` : ''}${run ? 'run' : 'pass'} vs ${coverage === 'man' ? 'Cover 1 man' : 'Cover 3 zone'}`,
    };
  },
};
