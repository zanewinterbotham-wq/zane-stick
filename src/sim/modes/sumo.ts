// Sumo Ring: push the other side out of a circle on the turf. An athlete is out when his centre of mass leaves the ring
// or (optionally) any part of him but his hands and feet touches the turf; a side loses when all of it is out. The
// football lies loose in a far corner and is ignored. Pure physics decides who goes out; the cones only mark the ring.
import { BALL } from '../anatomy/equipment';
import { PushBrain } from '../brains/push';
import type { PropDesc } from '../physics/engine';
import { END_LINE, HALF_WIDTH, NFL } from './rules';
import type { ModeDef, PlayerSpec } from './types';

const MARK_LEN = 0.6, MARK: [number, number] = [0.05, 0.012];

export const SUMO: ModeDef = {
  id: 'sumo', title: 'Sumo Ring', preview: 'modes/sumo.jpg',
  pitch: 'Shove the other side out of the circle, or onto the turf. Grip, sink your hips and drive with your legs.',
  options: [
    { id: 'radius', label: 'Ring radius', kind: 'range', min: 2.5, max: 6, step: 0.5, default: 3.5, unit: 'm' },
    { id: 'perSide', label: 'Wrestlers per side', kind: 'range', min: 1, max: 2, step: 1, default: 1 },
    { id: 'fall', label: 'Touching down loses', kind: 'toggle', default: true },
    { id: 'timeLimit', label: 'Time limit', kind: 'range', min: 10, max: 60, step: 5, default: 30, unit: 's' },
  ],
  athletes: (o) => 2 * +o.perSide,
  setup(o, rng) {
    const R = +o.radius, n = +o.perSide, out = new Set<number>(), ring: PropDesc[] = [];
    const MARKERS = Math.round((2 * Math.PI * R) / MARK_LEN); // rails ~0.6 m long, each tangent to the circle (renderer poses them)
    for (let k = 0; k < MARKERS; k++) {
      const th = (2 * Math.PI * k) / MARKERS, phi = th + Math.PI / 2;
      ring.push({ name: 'ring', shape: 'box', size: [MARK[0], MARK[1], Math.PI * R / MARKERS], mass: 0, pos: [R * Math.sin(th), MARK[1], R * Math.cos(th)],
        quat: [0, Math.sin(phi / 2), 0, Math.cos(phi / 2)], friction: 0.8, soft: true });
    }
    const players: PlayerSpec[] = [];
    for (const team of [0, 1] as const) for (let k = 0; k < n; k++) players.push({ team, pos: [(k - (n - 1) / 2) * 1.6 + rng.range(-0.2, 0.2), (team === 0 ? -1 : 1) * R * 0.45] });
    return {
      players, props: ring, ball: { at: [-HALF_WIDTH + 3, BALL.diameter / 2 + 0.01, -END_LINE + 3], impetus: 0 },
      rules: { ...NFL, outOfBounds: false, timeLimit: +o.timeLimit },
      brain: (play, _i, r) => new PushBrain(r, play.cfg.difficulty, { x: 0, z: 0, r: R }),
      step(play) {
        play.world.athletes.forEach((a, i) => {
          const c = play.world.scene.athletes[i].state.com;
          if (Math.hypot(c[0], c[2]) > R || (o.fall && a.downBy)) out.add(i);
        });
        for (const t of [0, 1] as const) {
          if (play.world.athletes.every((_, i) => play.team(i) !== t || out.has(i))) return play.end('sumo', t === 0 ? 1 : 0, 1);
        }
      },
      ended(play) {
        if (play.ended === 'sumo') play.verdict = play.scorer === 0 ? 'Ring cleared: you win' : 'You are out of the ring';
        else if (play.ended === 'time') play.verdict = 'Time: nobody is out (draw)';
      },
      status: () => `${n} v ${n}  ·  ${(2 * R).toFixed(0)} m ring${o.fall ? '  ·  touching down loses' : ''}`,
    };
  },
};
