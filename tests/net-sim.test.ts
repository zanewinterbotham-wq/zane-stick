// Multiplayer, sim side (docs/multiplayer.md): any athlete can be a player's, the lobby lists every mode's positions,
// guest input survives the wire, and a guest's replica built from snapshots shows what the host simulates.
import { beforeAll, describe, expect, it } from 'vitest';
import bindings from '../src/game/input/bindings.json';
import { HumanBrain, type HumanInput } from '../src/sim/brains/human';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { Play } from '../src/sim/modes/play';
import { listSlots, modeById, MODES, resolveOptions } from '../src/sim/modes/registry';
import { NFL } from '../src/sim/modes/rules';
import type { ModeDef, ModeOptions, PlayerSpec } from '../src/sim/modes/types';
import { ACTIONS, decodeInput, encodeInput } from '../src/sim/net/input';
import { encodeSnapshot, Replica } from '../src/sim/net/snapshot';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { Rng } from '../src/sim/rng';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier };
const input = (o: Partial<HumanInput> = {}): HumanInput => ({ move: { x: 0, y: 0 }, torso: 0, sprint: 0, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0, ...o });
/** Every option that sets a head count at its maximum. */
const maxed = (m: ModeDef): ModeOptions => resolveOptions(m, Object.fromEntries(m.options.filter((d) => d.kind === 'range' && d.unit === undefined).map((d) => [d.id, (d as { max: number }).max])));

describe('input codec', () => {
  it('round-trips a HumanInput with its held actions, and rejects junk', () => {
    const i = input({ move: { x: -0.5, y: 1 }, torso: 0.25, sprint: 1, armL: 1, armR: 0.5, cameraYaw: 2.5, aimPitch: -0.3, shiftLock: true, held: new Set(['thrust', 'armL', 'jump', 'notAnAction']) });
    const d = decodeInput(encodeInput(i, 77))!;
    expect(d.seq).toBe(77);
    expect([...d.input.held].sort()).toEqual(['armL', 'jump', 'thrust']);
    expect(d.input.move).toEqual({ x: -0.5, y: 1 });
    expect([d.input.torso, d.input.sprint, d.input.armL, d.input.armR, d.input.cameraYaw, d.input.shiftLock]).toEqual([0.25, 1, 1, 0.5, 2.5, true]);
    expect(d.input.aimPitch).toBeCloseTo(-0.3, 6);
    expect(decodeInput(new ArrayBuffer(10))).toBeNull();
    const bad = encodeInput(input({ move: { x: NaN, y: 9 } }), 1);
    expect(decodeInput(bad)!.input.move).toEqual({ x: 0, y: 1 });
  });

  it('knows every digital action the bindings have', () => {
    const analog = new Set(['moveX', 'moveY', 'lookX', 'lookY']);
    for (const a of [...Object.keys(bindings.keyboard), ...Object.keys(bindings.gamepad)]) if (!analog.has(a)) expect(ACTIONS).toContain(a);
    expect(ACTIONS.length).toBeLessThanOrEqual(32);
  });
});

describe('position menu slots', () => {
  it('every mode labels every athlete uniquely within his team, at its default and its largest head counts, and spawns nobody on top of another', () => {
    for (const m of MODES) for (const o of [resolveOptions(m), maxed(m)]) {
      const slots = listSlots(m, o);
      expect(slots.length, m.id).toBe(m.athletes(o));
      expect(slots.every((s) => s.label.length > 0), m.id).toBe(true);
      expect(new Set(slots.map((s) => `${s.team} ${s.label}`)).size, `${m.id} ${slots.map((s) => s.label)}`).toBe(slots.length);
      const ps: PlayerSpec[] = m.setup(o, new Rng(3), CFG).players;
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++)
        expect(Math.hypot(ps[i].pos[0] - ps[j].pos[0], ps[i].pos[1] - ps[j].pos[1]), `${m.id} ${ps[i].label} / ${ps[j].label}`).toBeGreaterThan(0.9);
    }
    expect(listSlots(modeById('kickoffReturn')).map((s) => s.label)).toEqual(['Returner', 'Blocker', 'Kicker', 'Cover R1']);
    expect(listSlots(modeById('kickoffReturn'))[0].group).toBe('Return team');
  });
});

describe('players on any slot (headless)', () => {
  it('two human brains, one on a non-zero slot, each drive their own athlete and are never reassigned', async () => {
    const def = modeById('carry'), local = new HumanBrain(), remote = new HumanBrain();
    local.steerAssist = remote.steerAssist = 0;
    // slot 0 the ball carrier, slot 2 his blocker (the remote player), the tackler a bot
    const play = await Play.create(mujocoEngine, CFG, def, resolveOptions(def, { blockers: 1 }), local, 0, { fixed: [null, null, remote] });
    expect([play.human, play.isBot(0), play.isBot(1), play.isBot(2)]).toEqual([0, false, true, false]);
    const w = play.world, at = (i: number) => [...w.scene.athletes[i].state.com];
    const p0 = at(0), p2 = at(2);
    for (let k = 0; k < Math.round(2 / w.dt) && !play.ended; k++) {
      local.latest = input({ move: { x: 0, y: 1 } }); // up the field (+Z)
      remote.latest = decodeInput(encodeInput(input({ move: { x: 0, y: 1 }, cameraYaw: Math.PI / 2 }), k))!.input; // across it (+X), over the wire
      play.step();
      if (k === 100) play.reassign(); // a change of roles leaves the players' brains alone
    }
    expect(play.brains[0]).toBe(local); expect(play.brains[2]).toBe(remote);
    expect(at(0)[2] - p0[2]).toBeGreaterThan(2);
    expect(at(2)[0] - p2[0]).toBeGreaterThan(2);
    expect(Math.abs(at(2)[2] - p2[2])).toBeLessThan(1.5);
    expect(w.scene.stats().instabilities).toBe(0);
    play.destroy();
  });

  it('the local player may sit on any slot, or none', async () => {
    const def = modeById('tackle');
    const p = await Play.create(mujocoEngine, CFG, def, resolveOptions(def), new HumanBrain(), 0, { human: 1 });
    expect([p.human, p.isBot(0), p.isBot(1)]).toEqual([1, true, false]);
    p.destroy();
    const spectator = await Play.create(mujocoEngine, CFG, def, resolveOptions(def), null, 0, { human: -1 });
    expect([spectator.isBot(0), spectator.isBot(1)]).toEqual([true, true]);
    spectator.destroy();
  });
});

describe('snapshots and the replica (headless)', () => {
  it('a replica fed 30 Hz snapshots over a jittery link matches the host within a few cm, with the same meta', async () => {
    const def = modeById('tackle'), o = resolveOptions(def);
    const host = await Play.create(mujocoEngine, CFG, def, o, null, 0, { human: -1 });
    const guest = await Play.create(mujocoEngine, CFG, def, o, null, 0, { human: -1 }), rep = new Replica(guest);
    const hw = host.world, gw = guest.world, rng = new Rng(5), every = Math.round(1 / 30 / hw.dt), CLOCK = 1000;
    // the host's segment positions every step, and its meta at every snapshot
    const hist: { t: number; pos: Float64Array[] }[] = [], meta: { t: number; bc: number; down: (string | null)[]; injuries: number; ended: string | null }[] = [];
    const wire: { at: number; buf: ArrayBuffer }[] = [];
    let worst = 0, sum = 0, n = 0, broke = false, checks = 0;
    while (hw.time < 20 && !(host.ended && hw.time - host.endTime > 1)) {
      host.step();
      hist.push({ t: hw.time, pos: hw.athletes.map((_, i) => Float64Array.from(hw.scene.athletes[i].state.segPos)) });
      if (!broke && hw.time > 2) { // a break, as the injury code reports one (the bones hold in a plain tackle)
        broke = true;
        const a = hw.athletes[1], dof = a.muscles.names.indexOf('elbowL.flex'), j = a.plan.joints.find((x) => x.name === 'elbowL')!;
        hw.breakJoint(1, 'elbowL', dof, -1, 1);
        hw.injuries.push({ athlete: 1, kind: 'break', joint: 'elbowL', what: 'elbow', seg: j.child, parentSeg: j.parent, pos: [0, 1.2, 0], load: 120, time: hw.time });
      }
      if (hw.steps % every === 0) {
        meta.push({ t: hw.time, bc: hw.ballCarrier, down: hw.athletes.map((a) => a.downBy), injuries: hw.injuries.length, ended: host.ended });
        wire.push({ at: hw.time + 0.04 + 0.03 * rng.next(), buf: encodeSnapshot(host) }); // 40-70 ms latency
      }
      // a 60 Hz render frame on the guest: deliver what has arrived, show it, compare with the host at that time
      if (hw.steps % 4 !== 0) continue;
      const now = hw.time;
      while (wire.length && wire[0].at <= now) rep.push(wire.shift()!.buf, CLOCK + now);
      if (!rep.render(CLOCK + now) || hw.time < 1) continue;
      const t = rep.time, k = hist.findIndex((h) => h.t >= t);
      if (k <= 0) continue;
      const h0 = hist[k - 1], h1 = hist[k], f = (t - h0.t) / (h1.t - h0.t);
      gw.athletes.forEach((_, i) => {
        const g = gw.scene.athletes[i].state.segPos;
        for (let s = 0; s < g.length; s += 3) {
          const e = Math.hypot(...[0, 1, 2].map((c) => g[s + c] - (h0.pos[i][s + c] + (h1.pos[i][s + c] - h0.pos[i][s + c]) * f)));
          worst = Math.max(worst, e); sum += e; n++;
        }
      });
      const m = meta.filter((x) => x.t <= t + 1e-9).pop()!;
      expect(gw.ballCarrier).toBe(m.bc);
      expect(gw.athletes.map((a) => a.downBy)).toEqual(m.down);
      expect(gw.injuries.length).toBe(m.injuries);
      expect(guest.ended).toBe(m.ended);
      expect(now - t).toBeGreaterThan(0.09); expect(now - t).toBeLessThan(0.3);
      checks++;
    }
    console.log(`replica: ${checks} frames, segment error mean ${(100 * sum / n).toFixed(2)} cm, worst ${(100 * worst).toFixed(1)} cm, delay ${(1000 * rep.delay).toFixed(0)} ms; host ${host.ended}`);
    expect(checks).toBeGreaterThan(150);
    expect(sum / n).toBeLessThan(0.02);
    expect(worst).toBeLessThan(0.08);
    expect(host.ended).not.toBeNull();
    expect(guest.verdict).toBe(host.verdict);
    expect(gw.injuries[0]).toMatchObject({ athlete: 1, kind: 'break', joint: 'elbowL', what: 'elbow', seg: hw.injuries[0].seg, parentSeg: hw.injuries[0].parentSeg });
    expect(gw.athletes[1].injury.arm[0]).toBe(true); // the broken arm hangs limp on the guest too
    expect(hw.scene.stats().instabilities).toBe(0);
    host.destroy(); guest.destroy();
  });

  it('snapshot size for 2 and 22 athletes', async () => {
    const sizes: number[] = [];
    for (const per of [1, 11]) {
      const players: PlayerSpec[] = [0, 1].flatMap((team) => Array.from({ length: per }, (_, k) => ({ team: team as 0 | 1, label: `P${team}${k}`, pos: [(k - 5) * 4, team ? 10 : -10] as [number, number] })));
      const def: ModeDef = { id: 'n', title: '', pitch: '', preview: '', options: [], athletes: () => players.length, setup: () => ({ players, ball: { holder: 0 }, rules: NFL }) };
      const p = await Play.create(mujocoEngine, CFG, def, {}, null, 0, { human: -1 });
      sizes.push(encodeSnapshot(p).byteLength);
      p.destroy();
    }
    console.log(`snapshot bytes: 2 athletes ${sizes[0]}, 22 athletes ${sizes[1]}`);
    expect(sizes[1]).toBeLessThan(8192);
  }, 60_000);
});
