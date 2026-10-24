// The party modes (survival, hot potato, infection) run headlessly: each ends inside its limit, deterministically and
// without instabilities, and its rules decide the result. Plus: co-op (two humans on one team) is possible by position.
import { beforeAll, describe, expect, it } from 'vitest';
import { ScriptBrain } from '../src/sim/brains/script';
import { newLobby, join, place } from '../src/game/net/lobby';
import { Play } from '../src/sim/modes/play';
import { MODES, listSlots, resolveOptions } from '../src/sim/modes/registry';
import { waveSize } from '../src/sim/modes/survival';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { CFG } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const mode = (id: string) => MODES.find((m) => m.id === id)!;

/** One rep; `idle`: the human stands still, else a bot plays his role. */
async function rep(id: string, stored: Record<string, unknown> = {}, idle = false) {
  const def = mode(id), p = await Play.create(mujocoEngine, CFG, def, resolveOptions(def, stored), new ScriptBrain(() => {}), 0);
  if (!idle) p.brains[0] = p.roleBrain(0);
  while (!p.ended) p.step();
  const w = p.world;
  return { p, ended: p.ended, scorer: p.scorer, points: p.points, verdict: p.verdict, t: p.repTime, unstable: w.scene.stats().instabilities, teams: w.athletes.map((a) => a.setup.team), note: p.note };
}
const print = (id: string, r: Awaited<ReturnType<typeof rep>>) => console.log(`${id}: ${r.ended} (${r.verdict}) scorer ${r.scorer} points ${r.points} at ${r.t.toFixed(1)} s, teams ${r.teams}, note ${r.note}`);

describe('registry', () => {
  it('lists the three party modes, with athletes() matching the setup', () => {
    for (const id of ['survival', 'potato', 'infection']) {
      const def = mode(id), o = resolveOptions(def);
      expect(def.athletes(o)).toBe(listSlots(def, o).length);
    }
    expect(waveSize(1)).toBe(1);
    expect(waveSize(3)).toBeGreaterThan(waveSize(1));
    const s = mode('survival');
    expect(s.athletes(resolveOptions(s, { waves: 5 }))).toBeGreaterThan(s.athletes(resolveOptions(s, { waves: 2 })));
  });
});

describe('survival', () => {
  it('ends deterministically; the score is the waves survived, with the waves in the note', async () => {
    const a = await rep('survival', { waves: 2 }), b = await rep('survival', { waves: 2 });
    print('survival', a);
    expect(a.ended).not.toBeNull();
    expect(a.t).toBeLessThanOrEqual(90 + a.p.world.dt);
    expect(a.unstable).toBe(0);
    expect(a.verdict).toMatch(/wave/);
    expect(a.points).toBeLessThanOrEqual(a.ended === 'touchdown' ? 6 : 2);
    expect(b.verdict).toBe(a.verdict);
    expect(b.t).toBe(a.t);
    a.p.destroy(); b.p.destroy();
  }, 240_000);

  it('a runner who stands still is brought down by the first wave without surviving one', async () => {
    const r = await rep('survival', { waves: 2 }, true);
    print('survival idle', r);
    expect(r.ended).not.toBe('touchdown');
    expect(r.points).toBe(0);
    r.p.destroy();
  }, 240_000);
});

describe('hot potato', () => {
  it('ends with a winner, deterministically, and the holder scored', async () => {
    const o = { players: 3, target: 6, duration: 20 }, a = await rep('potato', o), b = await rep('potato', o);
    print('potato', a);
    expect(['potato', 'time', 'out']).toContain(a.ended);
    expect(a.unstable).toBe(0);
    expect(a.verdict).not.toBe('');
    expect(Math.max(...a.note.split(' · ').map(Number))).toBeGreaterThan(0);
    expect(b.verdict).toBe(a.verdict);
    expect(b.t).toBe(a.t);
    a.p.destroy(); b.p.destroy();
  }, 240_000);

  it('a tackled holder does not end the play: the ball comes loose and the holder changes', async () => {
    const def = mode('potato'), p = await Play.create(mujocoEngine, CFG, def, resolveOptions(def, { players: 3, target: 30, duration: 40 }), new ScriptBrain(() => {}), 0);
    const holders = new Set<number>();
    while (!p.ended) { p.step(); if (p.world.ballCarrier >= 0) holders.add(p.world.ballCarrier); }
    console.log('potato holders', [...holders], 'ended', p.ended);
    expect(holders.size).toBeGreaterThan(1); // the idle human is tackled and loses it
    expect(p.world.scene.stats().instabilities).toBe(0);
    p.destroy();
  }, 240_000);
});

describe('infection', () => {
  it('a survivor who stands still is infected; everyone infected ends it for the infected', async () => {
    const r = await rep('infection', { survivors: 1, duration: 30 }, true);
    print('infection', r);
    expect(r.ended).toBe('infected');
    expect(r.teams.every((t) => t === 1)).toBe(true);
    expect(r.scorer).toBe(1);
    expect(r.unstable).toBe(0);
    r.p.destroy();
  }, 240_000);

  it('survivors run: reaches an outcome deterministically', async () => {
    const o = { duration: 20 }, a = await rep('infection', o), b = await rep('infection', o);
    print('infection run', a);
    expect(a.ended).not.toBeNull();
    expect(a.unstable).toBe(0);
    expect(a.verdict).not.toBe('');
    expect(b.teams).toEqual(a.teams);
    expect(b.t).toBe(a.t);
    a.p.destroy(); b.p.destroy();
  }, 240_000);
});

describe('co-op', () => {
  it('two players can be on team 0 of each mode that has two team-0 positions, and the lobby seats both', () => {
    const coop: string[] = [];
    for (const def of MODES) {
      const o = resolveOptions(def), slots = listSlots(def, o), mine = slots.filter((s) => s.team === 0);
      if (mine.length < 2) continue;
      coop.push(def.id);
      const l = newLobby({ id: 'a', name: 'A' }, def.id, o);
      join(l, 'b', 'B');
      place(l, mine[0].index, 'a'); place(l, mine[1].index, 'b');
      expect(l.assign[mine[0].index]).toBe('a');
      expect(l.assign[mine[1].index]).toBe('b');
    }
    console.log('modes with a team-0 partner position at default options:', coop.join(', '));
    expect(coop).toContain('kickoffReturn');
    expect(coop).toContain('keepaway');
  });

  it('Survival with a partner seats two humans on the runner team', () => {
    const def = mode('survival'), slots = listSlots(def, resolveOptions(def, { partners: 1 }));
    expect(slots.filter((s) => s.team === 0).map((s) => s.label)).toEqual(['Runner', 'Partner']);
  });
});
