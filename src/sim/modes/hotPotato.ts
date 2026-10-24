// Hot Potato: a free-for-all in a small arena. Whoever holds the ball earns a point for every second he keeps it; a
// tackle (the holder brought down with an opponent on him) makes him drop it, a strip takes it, and anyone may pick it
// up. First to the target wins, or the leader when the clock runs out. Everyone is the holder's opponent: while one holds
// the ball he is team 0 and the rest team 1, so the ordinary tackle and block rules apply with no teams of their own.
// The ball leaving the arena ends the rep (the leader wins).
import { FleeBrain } from './partyBrains';
import { arenaHalf, arenaProps, arenaRules } from './arena';
import type { ModeDef, PlayerSpec } from './types';

/** A holder down with an opponent on him this recently (s) is tackled. */
const TACKLE_MEM = 1;

export const HOT_POTATO: ModeDef = {
  id: 'potato', title: 'Hot Potato', preview: 'modes/keepaway.jpg',
  pitch: 'Free-for-all. Hold the ball to score a point a second. Tackle or strip the holder to steal it; first to the target wins.',
  options: [
    { id: 'players', label: 'Players', kind: 'range', min: 2, max: 6, step: 1, default: 3 },
    { id: 'target', label: 'Points to win', kind: 'range', min: 5, max: 30, step: 1, default: 10 },
    { id: 'size', label: 'Arena size', kind: 'range', min: 14, max: 30, step: 2, default: 20, unit: 'yd' },
    { id: 'duration', label: 'Time limit', kind: 'range', min: 15, max: 90, step: 5, default: 45, unit: 's' },
  ],
  athletes: (o) => +o.players,
  setup(o, rng) {
    const n = +o.players, h = arenaHalf(+o.size), target = +o.target, score: number[] = Array(n).fill(0), players: PlayerSpec[] = [];
    // athlete 0 holds the ball and is the only team-0 position; the others stand round him, each facing the middle
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n + rng.range(-0.2, 0.2), r = k ? 0.6 * h : 0;
      players.push({ team: k ? 1 : 0, label: `Player ${k + 1}`, pos: [r * Math.sin(a), r * Math.cos(a)], yaw: k ? a + Math.PI : 0 });
    }
    const home = players.map((p) => p.team);
    let touched = -Infinity, winner = -1;
    return {
      players, props: arenaProps(h), ball: { holder: 0 }, tackleDrops: true,
      rules: arenaRules(h, true, +o.duration),
      // the holder runs; everyone else is a tackler (not by team: it has not been renumbered yet when the ball changes hands)
      brain: (play, i, r) => (play.world.ballCarrier === i ? new FleeBrain(r, play.cfg.difficulty, h) : null),
      step(play) {
        const w = play.world, hi = w.ballCarrier;
        if (hi < 0) return;
        w.athletes.forEach((a, i) => { a.setup.team = i === hi ? 0 : 1; });
        score[hi] += w.dt;
        const a = w.athletes[hi];
        if (a.touching.length) touched = w.time;
        if (a.downBy && w.time - touched < TACKLE_MEM) {
          const g = w.gripping(hi, { athlete: -1, seg: play.ball });
          if (g >= 0) w.releaseGrip(hi, g as 0 | 1);
        }
        play.note = score.map((s) => Math.floor(s)).join(' · ');
        if (score[hi] >= target) play.end('potato');
      },
      ended(play) {
        const top = Math.max(...score), leaders = score.map((s, i) => (s >= top - 1e-9 ? i : -1)).filter((i) => i >= 0);
        winner = leaders.length === 1 ? leaders[0] : -1;
        play.scorer = winner < 0 ? -1 : home[winner]; play.points = winner < 0 ? 0 : 1;
        play.verdict = winner < 0 ? 'Tied: nobody wins the potato' : `${players[winner].label} wins with ${Math.floor(top)}`;
      },
      verdict: (play) => (play.human >= 0 && winner === play.human ? `You win with ${Math.floor(score[winner])}` : ''),
      status: (play) => `Hold it for points, first to ${target}  ·  ${play.note || score.map(() => 0).join(' · ')}`,
    };
  },
};
