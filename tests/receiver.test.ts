// The receiver brain (src/sim/brains/football/receiver.ts), headless under the shared play rules: every route of the
// tree run to its break on time without falling, a release off a press man, separation from a scripted man defender,
// the option read (man / zone), playing a launched ball with both hands (back to it, up for it; the lay-out decision
// from a Perception), running after the catch, and two receivers with two defenders: their routes keep apart and the
// one the ball is not thrown to blocks. Physics stays stable throughout. Numbers are printed.
import { beforeAll, describe, expect, it } from 'vitest';
import { DIFFICULTY } from '../src/sim/brains/carrier';
import { ReceiverBrain } from '../src/sim/brains/football/receiver';
import { runTime } from '../src/sim/brains/football/sense';
import { ROUTES } from '../src/sim/brains/football/routes';
import type { RouteKind } from '../src/sim/brains/football/types';
import { ScriptBrain } from '../src/sim/brains/script';
import type { AthleteView } from '../src/sim/brains/types';
import type { Commands } from '../src/sim/control/types';
import type { Vec3 } from '../src/sim/math';
import type { Play } from '../src/sim/modes/play';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { Rng } from '../src/sim/rng';
import { leadPoint, throwVelocity } from '../src/sim/throw';
import { launch, lead, LOS, manDefender, passPlay, route, type Spec } from './helpers/receiver';

beforeAll(() => mujocoEngine.init());
const ALL = Object.keys(ROUTES) as RouteKind[], DT = 1 / 240;
const flat = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const com = (p: Play, i: number) => p.world.scene.athletes[i].state.com;
/** Step the play `secs` s, calling `each` after every step (true: stop). */
function run(p: Play, secs: number, each?: () => boolean | void) {
  const end = p.repTime + secs;
  while (p.repTime < end && !p.ended) { p.step(); if (each?.()) break; }
}

describe('ReceiverBrain routes', () => {
  it('every route of the tree reaches its break within 0.5 m and on time, without falling', async () => {
    const rows: string[] = [];
    for (const [r, x, d] of [...ALL.map((r) => [r, -15, 0] as const), ['wheel', -4, -5] as const, ['slant', -4, -5] as const]) {
      const { play, receiver } = await passPlay([{ team: 0, pos: [x, LOS + d], assign: route(r) }]);
      const rb = receiver(1), w = play.world;
      run(play, 0.05);
      const path = rb.routePath!, b = path.pts[path.brk];
      // the drawn length to the break, and the sprint-start model's time for it (GAIT_ACCEL / GAIT_SPEED)
      let len = 0;
      for (let k = 1; k <= path.brk; k++) len += flat(path.pts[k], path.pts[k - 1]);
      let closest = Infinity, down = false, vmax = 0;
      run(play, 5, () => {
        const c = com(play, 1), dd = flat(c, b);
        closest = Math.min(closest, dd);
        down ||= !!w.athletes[1].downBy;
        vmax = Math.max(vmax, Math.hypot(w.scene.athletes[1].state.comVel[0], w.scene.athletes[1].state.comVel[2]));
      });
      const model = runTime(len, 0), late = rb.breakAt.time - play.repStart - model;
      rows.push(`${r}${d ? ' (backfield)' : ''}: break ${len.toFixed(1)} m in ${(rb.breakAt.time - play.repStart).toFixed(2)} s (model ${model.toFixed(2)}), closest ${closest.toFixed(2)} m, top ${vmax.toFixed(1)} m/s, ${rb.phase}`);
      expect(closest, r).toBeLessThan(0.5);
      expect(Number.isFinite(rb.breakAt.time), r).toBe(true);
      // on time: no later than the straight sprint plus 0.6 s (the snap's reaction and the throttle into the break)
      expect(late, r).toBeLessThan(0.6);
      expect(late, r).toBeGreaterThan(-0.1);
      expect(down, r).toBe(false);
      expect(w.scene.stats().instabilities).toBe(0);
      play.destroy();
    }
    console.log('routes run by the bot:\n  ' + rows.join('\n  '));
  }, 240_000);

  it('releases off a press man (a jab, then past him on the side away from his leverage)', async () => {
    const out: string[] = [];
    for (const [shade, want] of [[1, 'outside'], [-1, 'inside']] as const) {
      // pressed 1 m off, shaded `shade` m toward the middle (+x is the middle for a receiver at x = −15)
      const press = new ScriptBrain((_t, p, c) => { const r = p.athletes[1], me = p.athletes[p.self]; const dx = r.com[0] + shade * 0.4 - me.com[0], dz = r.com[2] + 1 - me.com[2], d = Math.hypot(dx, dz) || 1; const v = Math.min(1, d * 0.6); c.move = { x: dx / d * v * 0.5, z: dz / d * v * 0.5 }; c.face = { x: 0, z: -1 }; c.sink = 0.3; });
      const { play, receiver } = await passPlay([{ team: 0, pos: [-15, LOS], assign: route('go') }, { team: 1, pos: [-15 + shade * 0.4, LOS + 1], brain: press }]);
      const rb = receiver(1), phases: string[] = [];
      let side = 0, past = NaN;
      run(play, 3, () => {
        if (phases[phases.length - 1] !== rb.phase) phases.push(rb.phase);
        const r = com(play, 1), d = com(play, 2);
        if (rb.phase === 'release' && Math.abs(r[0] - d[0]) > Math.abs(side)) side = r[0] - d[0];
        if (Number.isNaN(past) && r[2] > d[2] + 0.5) past = play.repTime;
      });
      const got = side > 0 ? 'inside' : 'outside'; // +x of the defender is toward the middle
      out.push(`shade ${shade > 0 ? 'inside' : 'outside'}: released ${got} (${side.toFixed(2)} m across), past him at ${past.toFixed(2)} s, ${phases.join('>')}`);
      expect(phases).toContain('release');
      expect(got).toBe(want);
      expect(past).toBeLessThan(2);
      expect(play.world.scene.stats().instabilities).toBe(0);
      play.destroy();
    }
    console.log('press release:', out.join('; '));
  }, 120_000);

  it('gets separation from a scripted man defender (0.3 s late, 9 m/s top) at the break', async () => {
    const out: string[] = [];
    for (const r of ['slant', 'out', 'in', 'curl', 'comeback', 'post'] as RouteKind[]) {
      const { play, receiver } = await passPlay([{ team: 0, pos: [-15, LOS], assign: route(r) }, { team: 1, pos: [-14, LOS + 5], brain: manDefender(1, { cushion: 4, lag: 0.3 }) }]);
      const rb = receiver(1);
      let atBreak = NaN, after = 0;
      run(play, 5, () => {
        if (Number.isNaN(rb.breakAt.time)) return;
        const s = flat(com(play, 1), com(play, 2));
        if (Number.isNaN(atBreak)) atBreak = s;
        if (play.world.time - rb.breakAt.time < 0.8) after = Math.max(after, s);
        else return true;
      });
      out.push(`${r} ${atBreak.toFixed(1)} -> ${after.toFixed(1)} m`);
      expect(after, r).toBeGreaterThan(1.5);
      expect(play.world.scene.stats().instabilities).toBe(0);
      play.destroy();
    }
    console.log('separation from the man defender at the break -> most within 0.8 s after it:', out.join(', '));
  }, 120_000);

  it('option route: breaks away from a man defender\'s leverage, sits down in a zone hole', async () => {
    // man: an inside-leverage defender trails him; the "in" becomes an out
    const man = await passPlay([{ team: 0, pos: [-15, LOS], assign: route('in', { option: true }) }, { team: 1, pos: [-13.5, LOS + 4], brain: manDefender(1, { cushion: 3, inside: 1.2, lag: 0.25 }) }]);
    run(man.play, 4);
    const rm = man.receiver(1), lastM = com(man.play, 1);
    // zone: two defenders sit at 9 m depth, 5 m apart, around his break; he settles between them
    const sit = (x: number) => new ScriptBrain((_t, p, c) => { const me = p.athletes[p.self]; c.move = { x: (x - me.com[0]) * 0.3, z: (LOS + 9 - me.com[2]) * 0.3 }; c.face = { x: 0, z: -1 }; });
    const zone = await passPlay([{ team: 0, pos: [-15, LOS], assign: route('in', { option: true }) }, { team: 1, pos: [-18, LOS + 9], brain: sit(-18) }, { team: 1, pos: [-12, LOS + 9], brain: sit(-12) }]);
    run(zone.play, 4);
    const rz = zone.receiver(1), lastZ = com(zone.play, 1);
    console.log(`option vs man: read ${rm.read}, ends at x ${lastM[0].toFixed(1)} (broke ${lastM[0] < -15 ? 'out' : 'in'}); vs zone: read ${rz.read}, settles at x ${lastZ[0].toFixed(1)}, depth ${(lastZ[2] - LOS).toFixed(1)} m (defenders at -18 and -12)`);
    expect(rm.read).toBe('man');
    expect(lastM[0]).toBeLessThan(-17);          // out toward his sideline
    expect(rz.read).toBe('zone');
    expect(rz.phase).toBe('settle');
    expect(Math.abs(lastZ[0] + 15)).toBeLessThan(1.5); // the hole's middle
    for (const p of [man.play, zone.play]) { expect(p.world.scene.stats().instabilities).toBe(0); p.destroy(); }
  }, 120_000);
});

/** One throw at the receiver (athlete 1) `at` s after the snap, led `T` s on at `v` m/s (lead helper), optionally
 *  displaced by `off` (world m) from the lead point; whether it was caught, the try, and what he did. */
type Throw = (p: Play, rb: ReceiverBrain) => { at: Vec3; T: number } | null;
async function pass(r: RouteKind, at: number, seed: number, o: { v?: number; off?: Vec3; specs?: Spec[]; each?: (p: Play) => void; throwAt?: Throw } = {}) {
  const { play, receiver } = await passPlay(o.specs ?? [{ team: 0, pos: [-15, LOS], assign: route(r) }, { team: 1, pos: [-14, LOS + 6], brain: manDefender(1, { cushion: 5 }) }], seed);
  const rb = receiver(1), w = play.world;
  let thrown = false, jump = false, dive = false, back = 0, atCatch: Vec3 | null = null;
  const phases: string[] = [];
  run(play, at + 6, () => {
    const th = !thrown && play.repTime >= at ? (o.throwAt ? o.throwAt(play, rb) : lead(play, 1, o.v ?? 18)) : null;
    if (th) {
      const off = o.off ?? [0, 0, 0];
      launch(play, [th.at[0] + off[0], th.at[1] + off[1], th.at[2] + off[2]], th.T); thrown = true;
    }
    if (phases[phases.length - 1] !== rb.phase) phases.push(rb.phase);
    const c = w.athletes[1].cmd;
    if (thrown && !play.lastCatch) { jump ||= c.jump; dive ||= c.dive; back = Math.max(back, -w.scene.athletes[1].state.comVel[2]); }
    if (play.lastCatch && !atCatch) atCatch = [...com(play, 1)] as Vec3;
    o.each?.(play);
    return play.lastCatch !== null && w.time - play.lastCatch.time > 1.5;
  });
  const t = play.lastCatch, caught = !!t?.caught && t.athlete === 1;
  const res = { t, caught, jump, dive, back, phases, rb, play, gain: atCatch ? com(play, 1)[2] - atCatch[2] : 0 };
  return res;
}

describe('ReceiverBrain playing the ball', () => {
  it('catches a launched ball with both hands and runs on with it toward the goal', async () => {
    const xs = [];
    for (const [r, at] of [['out', 2.6], ['in', 2.6], ['slant', 1.3]] as [RouteKind, number][]) for (const seed of [1, 2, 3]) {
      const x = await pass(r, at, seed);
      xs.push({ r, seed, ...x });
      x.play.destroy();
    }
    const tries = xs.filter((x) => x.t?.athlete === 1), both = tries.filter((x) => x.t!.factors.hands === 0.95), caught = xs.filter((x) => x.caught);
    console.log('led throws (out, in, slant x 3 seeds): tries', tries.length, '/', xs.length, ', both hands', both.length, ', caught', caught.length,
      '\n  ', xs.map((x) => `${x.r}#${x.seed} ${x.t ? `${x.t.factors.hands === 0.95 ? 'both' : x.t.factors.hands === 0.55 ? 'one' : 'body'} ${x.t.chance.toFixed(2)} ${x.caught ? 'CAUGHT' : 'drop'}` : 'no try'}${x.caught ? `, ran on ${x.gain.toFixed(1)} m (${x.phases.slice(-1)})` : ''}`).join('; '));
    expect(tries.length).toBeGreaterThanOrEqual(7);
    expect(both.length).toBeGreaterThanOrEqual(5);
    expect(caught.length).toBeGreaterThanOrEqual(4);
    for (const x of caught) { expect(x.phases).toContain('carry'); expect(x.gain).toBeGreaterThan(2); }
  }, 240_000);

  it('adjusts: comes back to a short ball, goes up for a high one', async () => {
    // set at the end of a curl (no defender): a ball dropping 2 m short of him (he comes back to it), a flat one 0.3 m
    // over his reach on his feet (he high-points it with a jump)
    const alone = (r: RouteKind): Spec[] => [{ team: 0, pos: [-15, LOS], assign: route(r) }];
    const set = (dz: number, h: (rb: ReceiverBrain, p: Play) => number, T: number): Throw => (p, rb) => {
      if (rb.phase !== 'settle' || Math.hypot(p.world.scene.athletes[1].state.comVel[0], p.world.scene.athletes[1].state.comVel[2]) > 0.5) return null;
      const c = com(p, 1);
      return { at: [c[0], h(rb, p), c[2] + dz], T };
    };
    const head = (p: Play) => p.world.perception(1).athletes[1].head[1];
    const short = await pass('curl', 2, 1, { specs: alone('curl'), throwAt: set(-2, () => 1.2, 1.4) });
    const high = await pass('curl', 2, 1, { specs: alone('curl'), throwAt: set(0, (_rb, p) => head(p) + 0.6, 0.9) });
    // (the lay-out: see the Perception-level test below; in the physics the low balls tried here were met on the feet)
    console.log(`short ball: came back at ${short.back.toFixed(1)} m/s, try ${short.t?.factors.hands} caught ${short.caught}; high ball: jumped ${high.jump}, try ${high.t?.factors.hands} air ${high.t?.factors.air} caught ${high.caught}`);
    expect(short.back).toBeGreaterThan(1);
    expect(short.t?.athlete).toBe(1);
    expect(short.t!.time).toBeGreaterThan(0); // reached it in the air
    expect(high.jump).toBe(true);
    for (const x of [short, high]) { expect(x.play.world.scene.stats().instabilities).toBe(0); x.play.destroy(); }
  }, 240_000);

  it('over the shoulder: eyes on a deep ball in the air (go, post), caught at the normal chance', async () => {
    // the real throw's arc (throw.ts, loft 0.6) from where launch lets go, led onto his run. Before the eyes followed
    // the ball (Commands.look) and he ran on under it in stride: 1 try in 8, gaze factor 0.3, none caught
    const deep: Throw = (p) => {
      const q = com(p, 0), s = p.world.scene.athletes[1].state, from: Vec3 = [q[0], 2, q[2] + 0.5];
      const at = leadPoint(from, { pos: [s.com[0], 1.3, s.com[2]], vel: [s.comVel[0], 0, s.comVel[2]] }, 0.6, 0);
      return { at, T: throwVelocity(from, at, 0.6).time };
    };
    const xs = [];
    for (const r of ['go', 'post'] as RouteKind[]) for (const seed of [1, 2, 3, 4]) {
      // alone deep (the catch rule, not a defender, decides): a lofted ball led ~1.9 s, coming down over his shoulder
      // the post is thrown once he is on its angle (a lead on the stem's velocity would miss the break)
      const x = await pass(r, r === 'post' ? 3 : 2.2, seed, { specs: [{ team: 0, pos: [-15, LOS], assign: route(r) }], throwAt: deep });
      xs.push({ r, seed, ...x });
      expect(x.play.world.scene.stats().instabilities).toBe(0);
      x.play.destroy();
    }
    const tries = xs.filter((x) => x.t?.athlete === 1), caught = xs.filter((x) => x.caught), look = tries.map((x) => x.t!.factors.look);
    console.log(`deep balls (go, post x 4 seeds): tries ${tries.length} / ${xs.length}, caught ${caught.length}; look factor ${look.map((v) => v.toFixed(2)).join(' ')}; chance ${tries.map((x) => x.t!.chance.toFixed(2)).join(' ')}`);
    expect(tries.length).toBeGreaterThanOrEqual(6);
    for (const v of look) expect(v).toBeGreaterThan(0.9);
    expect(caught.length).toBeGreaterThanOrEqual(3);
  }, 240_000);
});

describe('ReceiverBrain decisions (Perception only)', () => {
  const view = (com: Vec3, vel: Vec3, team: 0 | 1, hasBall = false): AthleteView => ({ com, comVel: vel, pelvis: com, head: [com[0], 1.75, com[2]], heading: Math.atan2(vel[0], vel[2]), down: false, hasBall, team });
  /** A receiver running on at `v` (+z) with a pass in flight that comes down at `land` (world, on the turf) `T` s
   *  after t = 0 from 20 m behind; his Commands each 1/240 s for `secs`. */
  function feed(v: number, land: Vec3, T: number, secs: number, high = 0) {
    const call = { frame: { los: -20, dir: 1 as const, halfWidth: 24.38, snapTime: -10 }, offense: 0 as const, assign: [null, { kind: 'route' as const, route: 'go' as const }] };
    const rb = new ReceiverBrain(new Rng(1), DIFFICULTY.hard, call, 1), out: Commands[] = [];
    const from: Vec3 = [land[0], 2, land[2] - 20], g = 9.81, vel: Vec3 = [0, (high - 2 + g * T * T / 2) / T, 20 / T];
    for (let k = 0; k * DT < secs; k++) {
      const t = k * DT, me = view([0, 1, v * t], [0, 0, v], 0);
      const ball = { pos: [from[0] + vel[0] * t, from[1] + vel[1] * t - g * t * t / 2, from[2] + vel[2] * t] as Vec3, vel: [vel[0], vel[1] - g * t, vel[2]] as Vec3 };
      out.push(rb.think({ time: t, self: 1, athletes: [view([0, 1, -25], [0, 0, 0], 0), me], field: { halfWidth: 24.38, goalZ: 45.72, dirZ: 1 }, ball }, DT));
    }
    return out;
  }
  it('lays out for a ball coming down in front of his run below his knees, not for one at his chest', () => {
    const low = feed(8, [0, 0, 8 * 1.0 + 2], 1.0, 1.0), chest = feed(8, [0, 0, 8 * 1.0 - 0.5], 1.0, 1.0, 1.2);
    const di = low.findIndex((c) => c.dive), hands = low.findIndex((c) => c.armL === 1 && c.armR === 1 && c.gripL && c.gripR);
    console.log(`low ball 2 m beyond his run: dives at ${(di * DT).toFixed(2)} s (it lands at 1.00 s), hands up from ${(hands * DT).toFixed(2)} s; chest-high ball: dives ${chest.some((c) => c.dive)}`);
    expect(di).toBeGreaterThan(0);
    expect(di * DT).toBeGreaterThan(0.5);
    expect(hands).toBeGreaterThanOrEqual(0);
    expect(chest.some((c) => c.dive)).toBe(false);
    expect(chest.some((c) => c.armL === 1 && c.armR === 1)).toBe(true);
  });
});

describe('ReceiverBrain 2 v 2', () => {
  it('two receivers on crossing routes keep apart; the one the ball is not thrown to blocks a defender', async () => {
    // a slot's out (athlete 1, thrown to) and a wide receiver's slant (2) on the same side cross; two man defenders
    let minGap = Infinity, blocked = false, onDefender = Infinity;
    const x = await pass('out', 2.6, 1, {
      specs: [
        { team: 0, pos: [-10, LOS], assign: route('out') }, { team: 0, pos: [-18, LOS], assign: route('slant') },
        { team: 1, pos: [-9, LOS + 5], brain: manDefender(1, { cushion: 4 }) }, { team: 1, pos: [-17, LOS + 5], brain: manDefender(2, { cushion: 4 }) },
      ],
      each: (p) => {
        const r2 = p.brains[2] as ReceiverBrain;
        if (p.repTime < 2.6) minGap = Math.min(minGap, flat(com(p, 1), com(p, 2)));
        else if (r2.phase === 'block') { blocked = true; onDefender = Math.min(onDefender, flat(com(p, 2), com(p, 3)), flat(com(p, 2), com(p, 4))); }
      },
    });
    const r1 = x.rb, r2 = x.play.brains[2] as ReceiverBrain;
    console.log(`crossing out/slant: closest the receivers came ${minGap.toFixed(2)} m; breaks at ${(r1.breakAt.time - x.play.repStart).toFixed(2)} / ${(r2.breakAt.time - x.play.repStart).toFixed(2)} s; thrown to the out: try by ${x.t?.athlete} caught ${x.caught}; the slant blocks ${blocked}, got within ${onDefender.toFixed(2)} m of a defender`);
    expect(minGap).toBeGreaterThan(1);
    expect(Number.isFinite(r1.breakAt.time) && Number.isFinite(r2.breakAt.time)).toBe(true);
    expect(blocked).toBe(true);
    expect(onDefender).toBeLessThan(2);
    expect(x.play.world.scene.stats().instabilities).toBe(0);
    x.play.destroy();
  }, 240_000);
});
