// Infection: one tackler starts infected; everyone he brings down joins his side. Survivors (team 0) run, the infected
// (team 1) hunt. A survivor is infected when he is on the turf with an infected player on him (or within a second of
// one), or when he leaves the arena. Last survivor standing when the clock runs out wins; if every survivor falls the
// infected win. The football lies loose out of reach in a far corner and is ignored. Physics decides every tackle; the
// team swap on infection is the only rule.
import { BALL } from '../anatomy/equipment';
import { ChaseBrain, FleeBrain } from './partyBrains';
import { arenaHalf, arenaProps, arenaRules } from './arena';
import { END_LINE, HALF_WIDTH, nth } from './rules';
import type { Brain, Perception } from '../brains/types';
import type { Commands } from '../control/types';
import type { ModeDef, PlayerSpec } from './types';

/** A survivor down with an infected player on him this recently (s) is tagged. */
const TAG_MEM = 1;

/** Plays a hunter while his team is the infected one (read live from the perception), else a survivor. */
class InfectionBrain implements Brain {
  constructor(private chase: Brain, private flee: Brain) {}
  think(p: Perception, dt?: number): Commands { return (p.athletes[p.self].team === 1 ? this.chase : this.flee).think(p, dt ?? 1 / 240); }
}

export const INFECTION: ModeDef = {
  id: 'infection', title: 'Infection', preview: 'modes/keepaway.jpg',
  pitch: 'One tackler starts infected. Everyone he takes down joins him. Be the last survivor standing when time runs out.',
  options: [
    { id: 'survivors', label: 'Survivors', kind: 'range', min: 1, max: 5, step: 1, default: 3 },
    { id: 'infected', label: 'Infected at the start', kind: 'range', min: 1, max: 3, step: 1, default: 1 },
    { id: 'size', label: 'Arena size', kind: 'range', min: 14, max: 30, step: 2, default: 24, unit: 'yd' },
    { id: 'duration', label: 'Survive for', kind: 'range', min: 15, max: 90, step: 5, default: 40, unit: 's' },
  ],
  athletes: (o) => +o.survivors + +o.infected,
  setup(o, rng) {
    const ns = +o.survivors, ni = +o.infected, h = arenaHalf(+o.size), players: PlayerSpec[] = [];
    for (let k = 0; k < ns; k++) players.push({ team: 0, label: nth('Survivor', k, ns), pos: [(k - (ns - 1) / 2) * 0.5 * h * Math.min(1, 2 / Math.max(1, ns - 1)) + rng.range(-1, 1), -0.5 * h + rng.range(-1, 1)] });
    for (let k = 0; k < ni; k++) players.push({ team: 1, label: nth('Infected', k, ni), pos: [(k - (ni - 1) / 2) * 0.6 * h + rng.range(-1, 1), 0.7 * h + rng.range(-1, 1)] });
    const touched: number[] = players.map(() => -Infinity);
    return {
      players, props: arenaProps(h), ball: { at: [HALF_WIDTH - 2, BALL.diameter / 2 + 0.01, -END_LINE + 3], impetus: 0 },
      rules: arenaRules(h, false, +o.duration),
      brain: (play, _i, r) => new InfectionBrain(new ChaseBrain(r, play.cfg.defense ?? play.cfg.difficulty), new FleeBrain(r, play.cfg.difficulty, h)),
      step(play) {
        const w = play.world;
        w.athletes.forEach((a, i) => {
          if (a.setup.team === 1) return;
          if (a.touching.some((k) => w.athletes[k].setup.team === 1)) touched[i] = w.time;
          const c = w.scene.athletes[i].state.com;
          if ((a.downBy && w.time - touched[i] < TAG_MEM) || Math.abs(c[0]) > h || Math.abs(c[2]) > h) a.setup.team = 1;
        });
        const left = w.athletes.filter((a) => a.setup.team === 0).length;
        play.note = `${left} left`;
        if (!left) play.end('infected');
      },
      ended(play) {
        const left = play.world.athletes.filter((a) => a.setup.team === 0).length;
        play.scorer = left ? 0 : 1; play.points = 1;
        play.verdict = left ? `${left} survived` : 'Everyone is infected';
      },
      verdict(play) {
        const me = play.human >= 0 ? play.world.athletes[play.human] : null, left = play.world.athletes.filter((a) => a.setup.team === 0).length;
        if (!me) return '';
        return me.setup.team === 0 ? (left > 1 ? `You survived (${left} left)` : 'Last survivor: you win') : left ? 'You were infected' : 'Everyone is infected';
      },
      status: (play) => `${play.note || `${ns} survivor${ns > 1 ? 's' : ''}`}  ·  tackled or out of the arena = infected`,
    };
  },
};
