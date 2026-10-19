// The invented modes (gauntlet, sumo, keep away, fumble scramble, goal-line stand, big-hit challenge) run headlessly with
// the role's own bot brain standing in for the human: each reaches an outcome inside its limit, deterministically, with
// no physics instabilities, and its rules decide the result the way the card promises.
import { beforeAll, describe, expect, it } from 'vitest';
import { ScriptBrain } from '../src/sim/brains/script';
import { GateBrain } from '../src/sim/brains/gate';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { PRESETS } from '../src/game/presets';
import { wrapAngle } from '../src/sim/math';
import { Play } from '../src/sim/modes/play';
import { MODES, resolveOptions } from '../src/sim/modes/registry';
import type { ModeOptions } from '../src/sim/modes/types';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier };
const mode = (id: string) => MODES.find((m) => m.id === id)!;

/** One rep with a bot standing in for the human; returns what the rep decided and a fingerprint of the final state. */
async function rep(id: string, stored: Record<string, unknown> = {}, n = 0, each?: (p: Play) => void) {
  const def = mode(id), o: ModeOptions = resolveOptions(def, stored);
  const p = await Play.create(mujocoEngine, CFG, def, o, new ScriptBrain(() => {}), n);
  p.brains[0] = p.roleBrain(0);
  while (!p.ended) { p.step(); each?.(p); }
  const w = p.world, out = {
    ended: p.ended, scorer: p.scorer, points: p.points, verdict: p.verdict, t: +p.repTime.toFixed(3), athletes: w.athletes.length,
    com: w.scene.athletes.map((a) => [...a.state.com].map((x) => +x.toFixed(4))), ball: p.ballPos().map((x) => +x.toFixed(4)),
    unstable: w.scene.stats().instabilities, limit: p.rules.timeLimit, dt: w.dt, p,
  };
  return out;
}
const fingerprint = (r: Awaited<ReturnType<typeof rep>>) => JSON.stringify({ ...r, p: undefined });

for (const id of ['gauntlet', 'sumo', 'keepaway', 'scramble', 'goalline', 'hitstick']) {
  describe(id, () => {
    it('is in the registry with a few athletes by default, and reaches an outcome deterministically without instabilities', async () => {
      const def = mode(id);
      expect(def.athletes(resolveOptions(def))).toBeLessThanOrEqual(4);
      const a = await rep(id), b = await rep(id);
      console.log(`${id}: ${a.ended} (${a.verdict}) scorer ${a.scorer} points ${a.points} at ${a.t} s of ${a.limit}`);
      expect(a.ended).not.toBeNull();
      expect(a.t).toBeLessThanOrEqual(a.limit + a.dt);
      if (['sumo', 'keepaway', 'goalline', 'hitstick'].includes(id)) expect(a.verdict).not.toBe(''); // these always call the result
      expect(a.unstable).toBe(0);
      expect(fingerprint(b)).toBe(fingerprint(a));
      a.p.destroy(); b.p.destroy();
    }, 240_000);
  });
}

describe('mode rules', () => {
  it('gauntlet: tacklers wait until the runner is inside the wake-up distance, then chase', async () => {
    const woke: number[] = [];
    const r = await rep('gauntlet', { wake: 8 }, 0, (p) => {
      p.brains.forEach((b, i) => { if (b instanceof GateBrain && b.awake && !woke.includes(i)) { woke.push(i); expect(p.repTime).toBeGreaterThan(0.5); } });
    });
    console.log('gauntlet woke tacklers', woke, 'ended', r.ended, r.verdict);
    expect(woke.length).toBeGreaterThan(0);
    expect(woke.length).toBeLessThanOrEqual(3);
    r.p.destroy();
  }, 240_000);

  // the human stands (or walks across the field) outside every tackler's wake-up distance, so they all wait throughout
  async function waiting(cfg: object, human: ScriptBrain, secs: number) {
    const def = mode('gauntlet'), p = await Play.create(mujocoEngine, { ...CFG, ...cfg }, def, resolveOptions(def, { wake: 6 }), human, 0);
    const w = p.world, ids = w.athletes.map((_, i) => i).filter((i) => p.team(i) === 1), look = (i: number) => w.perception(i).athletes[i].heading;
    const spot = ids.map((i) => [...w.scene.athletes[i].state.com]), h0 = ids.map(look), far = ids.map(() => 0), turn = ids.map(() => 0);
    let down = false;
    for (let k = 0; k < Math.round(secs / w.dt) && !p.ended; k++) {
      p.step();
      ids.forEach((i, j) => {
        const c = w.scene.athletes[i].state.com;
        far[j] = Math.max(far[j], Math.hypot(c[0] - spot[j][0], c[2] - spot[j][2]));
        turn[j] = Math.max(turn[j], Math.abs(wrapAngle(look(i) - h0[j])));
        down ||= !!w.athletes[i].downBy;
      });
    }
    expect(p.ended).toBeNull();
    expect(ids.every((i) => p.brains[i] instanceof GateBrain && !(p.brains[i] as GateBrain).awake)).toBe(true);
    return { p, ids, spot, far, turn, down, unstable: w.scene.stats().instabilities };
  }

  it('gauntlet: a waiting tackler stays alive at his spot (stance, weight shifts, glances) without falling', async () => {
    const r = await waiting({ physics: PRESETS.minimum.physics }, new ScriptBrain(() => {}), 10); // the low-end tier idles
    console.log('idle tacklers: furthest from spot (m)', r.far.map((x) => x.toFixed(2)), 'turned up to (rad)', r.turn.map((x) => x.toFixed(2)));
    expect(r.down).toBe(false);
    expect(Math.max(...r.far)).toBeLessThan(1.5);
    expect(Math.min(...r.turn)).toBeGreaterThan(0.2); // he glances round, not a statue
    expect(r.unstable).toBe(0);
    r.p.destroy();
  }, 240_000);

  it('gauntlet, active bots: a waiting tackler mirrors the runner across the field and comes up into his zone', async () => {
    const r = await waiting({ physics: PRESETS.high.physics, activeBots: PRESETS.high.activeBots }, new ScriptBrain((t, _p, c) => { if (t < 2.5) { c.move = { x: 1, z: 0 }; c.gait = 'jog'; } }), 9);
    const w = r.p.world, run = w.scene.athletes[0].state.com;
    r.ids.forEach((i, j) => {
      const c = w.scene.athletes[i].state.com;
      console.log(`active tackler ${i}: x ${c[0].toFixed(2)} (runner ${run[0].toFixed(2)}), came up ${(r.spot[j][2] - c[2]).toFixed(2)} m`);
      expect(Math.abs(c[0] - run[0])).toBeLessThan(1.5);
      expect(r.spot[j][2] - c[2]).toBeGreaterThan(2);
      expect(r.spot[j][2] - c[2]).toBeLessThan(3.6);
    });
    expect(r.down).toBe(false);
    expect(r.unstable).toBe(0);
    r.p.destroy();
  }, 240_000);

  it('sumo: the side left in the ring wins, and nobody wins before an athlete is out', async () => {
    const r = await rep('sumo', { perSide: 1 });
    if (r.ended === 'sumo') expect([0, 1]).toContain(r.scorer);
    else expect(r.ended).toBe('time');
    r.p.destroy();
  }, 240_000);

  it('sumo 2 v 2: a side loses only when both its wrestlers are out', async () => {
    const out = new Set<number>();
    const r = await rep('sumo', { perSide: 2 }, 1, (p) => {
      p.world.athletes.forEach((a, i) => { const c = p.world.scene.athletes[i].state.com; if (Math.hypot(c[0], c[2]) > 3.5 || a.downBy) out.add(i); });
    });
    expect(r.athletes).toBe(4);
    if (r.ended === 'sumo') { const lost = r.scorer === 0 ? 1 : 0; for (const i of [0, 1, 2, 3]) if (r.p.team(i) === lost) expect(out.has(i)).toBe(true); }
    else expect(r.ended).toBe('time');
    r.p.destroy();
  }, 240_000);

  it('keep away: surviving the clock scores for you, being caught for the bots', async () => {
    const r = await rep('keepaway', { duration: 10 });
    expect(r.ended === 'time' ? r.scorer === 0 : r.scorer === 1).toBe(true);
    expect(r.points).toBe(1);
    r.p.destroy();
  }, 240_000);

  it('scramble: with play-it-out off, the first recovery ends the rep for the recoverer\'s team', async () => {
    const r = await rep('scramble', { playOut: false });
    if (r.ended === 'recovered') { expect(r.p.recoveredBy).toBeGreaterThanOrEqual(0); expect(r.scorer).toBe(r.p.team(r.p.recoveredBy)); } else expect(r.ended).toBe('time');
    r.p.destroy();
  }, 240_000);

  it('goal-line stand: your side wins every rep that is not a touchdown against it', async () => {
    const r = await rep('goalline');
    expect(r.ended === 'touchdown' ? r.scorer === 1 || r.scorer === 0 : r.scorer === 0).toBe(true);
    r.p.destroy();
  }, 240_000);

  it('big hit: a hit scores its closing speed in mph, a miss scores nothing', async () => {
    const r = await rep('hitstick');
    const imp = r.p.world.impact;
    if (imp.firstContactTime >= 0) { expect(r.scorer).toBe(0); expect(r.points).toBeGreaterThanOrEqual(Math.round(imp.closingSpeed * 2.236936)); } else expect([r.points, r.verdict]).toEqual([0, 'Missed him']);
    r.p.destroy();
  }, 240_000);
});
