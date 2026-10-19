// Multiplayer, game side (docs/multiplayer.md): the lobby's rules, and a host with two guests over an in-memory room
// playing a rep: the guests' replicas track the host, a guest's input moves his athlete on the host, and a guest who
// leaves mid-rep hands his athlete to a bot.
import { beforeAll, describe, expect, it } from 'vitest';
import { HumanBrain, type HumanInput } from '../src/sim/brains/human';
import { DEFAULT_OPEN_FIELD } from '../src/sim/drills/openField';
import { listSlots, modeById } from '../src/sim/modes/registry';
import { mujocoEngine } from '../src/sim/physics/mujoco';
import { createLoopbackRoom } from '../src/net/loopback';
import { defaultServer, PAGES_SERVER } from '../src/net/room';
import * as L from '../src/game/net/lobby';
import { Session } from '../src/game/net/session';
import { STD } from './helpers/scenario';

beforeAll(() => mujocoEngine.init());
const { carrier, timeLimit: _t, mode: _m, ...base } = DEFAULT_OPEN_FIELD;
const CFG = { ...base, physics: STD, bot: carrier, seed: 1 };
const input = (o: Partial<HumanInput> = {}): HumanInput => ({ move: { x: 0, y: 0 }, torso: 0, sprint: 0, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0, ...o });
const flush = () => new Promise((r) => setTimeout(r, 0));
const labels = (l: L.Lobby) => L.slotsOf(l).map((s, i) => `${s.label}=${l.assign[i] ?? 'bot'}`);

describe('lobby rules', () => {
  const lobby = () => { const l = L.newLobby({ id: 'h', name: 'Host' }, 'carry', { tacklers: 2, blockers: 1 }); L.join(l, 'a', 'Ann'); L.join(l, 'b', 'Bob'); return l; };

  it('newcomers land on open slots of the emptier team; want takes open slots, frees your own, never steals', () => {
    const l = lobby();
    expect(labels(l)).toEqual(['Ball carrier=h', 'Tackler 1=a', 'Tackler 2=bot', 'Blocker=b']);
    L.want(l, 'b', 1); expect(l.assign[1]).toBe('a'); // taken: no
    L.want(l, 'b', 2); expect(labels(l)).toEqual(['Ball carrier=h', 'Tackler 1=a', 'Tackler 2=b', 'Blocker=bot']); // moved
    L.want(l, 'b', 2); expect(l.assign).toEqual(['h', 'a', null, null]); // own slot: back to a bot
    L.want(l, 'a', null); expect(l.assign).toEqual(['h', null, null, null]);
    L.want(l, 'x', 1); L.want(l, 'a', 99); expect(l.assign).toEqual(['h', null, null, null]); // unknown player, bad slot
  });

  it('the host places and swaps, auto-assigns alternating teams, and sends everyone to bots', () => {
    const l = lobby();
    L.place(l, 0, 'a'); expect(l.assign).toEqual(['a', 'h', null, 'b']); // swapped with the host
    L.place(l, 2, 'h'); expect(l.assign).toEqual(['a', null, 'h', 'b']);
    L.place(l, 3, null); expect(l.assign[3]).toBeNull();
    L.allBots(l); expect(l.assign).toEqual([null, null, null, null]);
    L.autoAssign(l); expect(labels(l)).toEqual(['Ball carrier=h', 'Tackler 1=a', 'Tackler 2=bot', 'Blocker=b']);
    L.join(l, 'c', 'Cy'); expect(l.assign[2]).toBe('c'); // team 1 had fewer
    L.join(l, 'd', 'Di'); expect(l.assign.includes('d')).toBe(false); // no open slot: he watches
  });

  it('head counts and mode changes keep players on their team and position where they can', () => {
    const l = lobby(), def = modeById('carry');
    expect(L.countOptions(def).map((d) => d.id)).toEqual(['tacklers', 'blockers']);
    expect(L.countInfo(def, l.options, L.countOptions(def)[1])).toEqual({ teams: [0], noun: 'blocker' });
    l.score = [7, 0];
    L.count(l, 'blockers', 1); // 'Blocker' becomes 'Blocker 1'
    expect(labels(l)).toEqual(['Ball carrier=h', 'Tackler 1=a', 'Tackler 2=bot', 'Blocker 1=b', 'Blocker 2=bot']);
    expect(l.score).toEqual([0, 0]);
    L.count(l, 'tacklers', -1); // Ann's 'Tackler 1' becomes 'Tackler'
    expect(labels(l)).toEqual(['Ball carrier=h', 'Tackler=a', 'Blocker 1=b', 'Blocker 2=bot']);
    L.count(l, 'tacklers', -5); expect(+l.options.tacklers).toBe(1); // within the option's range
    L.setup(l, 'tackle', {}); // 1 v 1: team 0 'Tackler', team 1 'Ball carrier'
    expect(labels(l)).toEqual(['Tackler=h', 'Ball carrier=a']); // Bob has no slot left: he watches
    expect(l.players.map((p) => p.id)).toEqual(['h', 'a', 'b']);
  });

  it('a restart needs a vote from every player on a position; a watcher may vote but is not waited for', () => {
    const l = lobby(), assign = ['h', 'a', null]; // Bob watches
    expect(L.restartTally(l, assign)).toEqual({ have: 0, need: 2, due: false });
    L.vote(l, 'h', true); L.vote(l, 'b', true);
    expect(L.restartTally(l, assign)).toEqual({ have: 1, need: 2, due: false });
    L.vote(l, 'a', true); L.vote(l, 'a', true); // twice is once
    expect([L.restartTally(l, assign), l.votes.length]).toEqual([{ have: 2, need: 2, due: true }, 3]);
    L.vote(l, 'h', false); expect(L.restartTally(l, assign).due).toBe(false); // taken back
    L.leave(l, 'h'); expect(L.restartTally(l, assign)).toEqual({ have: 1, need: 1, due: true }); // the one still to vote left
    L.vote(l, 'zz', true); expect(l.votes).not.toContain('zz'); // not in the room
    const empty = L.newLobby({ id: 'h', name: 'Host' }, 'tackle', {});
    expect(L.restartTally(empty, [null, null]).due).toBe(false); // all bots: anyone's vote restarts
    L.vote(empty, 'h', true); expect(L.restartTally(empty, [null, null]).due).toBe(true);
    expect(L.parseToHost(JSON.stringify({ t: 'restart', on: true }))).toEqual({ t: 'restart', on: true });
    expect(L.parseToHost(JSON.stringify({ t: 'restart', on: 'yes' }))).toBeNull();
  });

  it('ready, start checks and trusting nothing a guest sends', () => {
    const l = lobby();
    expect(L.notReady(l).map((p) => p.id)).toEqual(['a', 'b']);
    L.setReady(l, 'a', true); L.setReady(l, 'h', false);
    expect(L.notReady(l).map((p) => p.id)).toEqual(['b']);
    expect(L.parseToHost('{"t":"want","slot":2}')).toEqual({ t: 'want', slot: 2 });
    expect(L.parseToHost('{"t":"want","slot":"2"}')).toBeNull();
    expect(L.parseToHost('{"t":"hi","steer":7}')).toEqual({ t: 'hi', steer: 1 });
    expect(L.parseToHost('nope')).toBeNull();
  });

  it('the room server is the page itself locally and on Pages, else the Pages site', () => {
    const at = (href: string) => { const u = new URL(href); return defaultServer({ search: u.search, origin: u.origin, hostname: u.hostname }); };
    expect(at('http://localhost:5173/')).toBe('http://localhost:5173');
    expect(at('https://zane-stick.pages.dev/?join=ABCDE')).toBe('https://zane-stick.pages.dev');
    expect(at('https://someone.github.io/zane-stick/')).toBe(PAGES_SERVER);
    expect(at('https://someone.github.io/zane-stick/?server=http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });
});

describe('a host and two guests over a loopback room (headless)', () => {
  it('lobby sync, a rep the replicas track, guest input on the host, a guest leaving to a bot', async () => {
    const room = createLoopbackRoom(['Ann', 'Bob']);
    let clock = 100; // shared steady clock (s): host sim time + 100 once the rep runs
    const now = () => clock;
    const host = new Session(room.host, mujocoEngine, 'Host', { mode: 'carry', options: { tacklers: 1, blockers: 1 }, steer: 0.3 }, now);
    const [ann, bob] = room.guests.map((g) => new Session(g, mujocoEngine, g.selfId, { mode: 'tackle', options: {}, steer: 0 }, now));
    await flush();
    // carry, 1 tackler, 1 blocker: the host carries, Ann (first in) tackles, Bob blocks
    expect(listSlots(modeById('carry'), host.lobby.options).map((s) => s.label)).toEqual(['Ball carrier', 'Tackler', 'Blocker']);
    for (const s of [ann, bob]) expect(s.lobby).toEqual(host.lobby);
    expect([ann.mySlot, bob.mySlot]).toEqual([1, 2]);
    expect(ann.lobby.players.map((p) => p.name)).toEqual(['Host', 'Ann', 'Bob']);
    // Bob asks for Ann's slot (no), the host swaps them, Bob gets ready
    bob.want(1); await flush(); expect(bob.mySlot).toBe(2);
    host.place(1, room.guests[1].selfId); await flush(); expect([ann.mySlot, bob.mySlot]).toEqual([2, 1]);
    bob.ready(true); await flush();
    expect(L.notReady(host.lobby).map((p) => p.name)).toEqual(['Ann']);

    const starts: number[] = [], events: L.NetEvent[] = [];
    for (const s of [host, ann, bob]) s.onStart = (st) => starts.push(st.rep);
    host.onEvent = (e) => events.push(e);
    const human = new HumanBrain();
    await host.begin(CFG, human, 3);
    for (let k = 0; k < 200 && !(ann.play && bob.play); k++) await flush();
    expect(starts).toEqual([0, 0, 0]);
    expect(ann.lobby.phase).toBe('game');
    const hp = host.play!, hw = hp.world, annAt = ann.mySlot, bobAt = bob.mySlot;
    expect([hp.human, hp.isBot(annAt), hp.isBot(bobAt)]).toEqual([0, false, false]);
    expect([ann.play!.human, bob.play!.human, ann.play!.world.athletes.length]).toEqual([2, 1, 3]);

    // 2 s: the host steps; every 4 steps (a 60 Hz frame) messages flow, guests send input and render
    const hist: { t: number; com: number[][] }[] = [], start = hw.athletes.map((_, i) => [...hw.scene.athletes[i].state.com]);
    let worst = 0, checks = 0;
    while (hw.time < 2) {
      host.step();
      hist.push({ t: hw.time, com: hw.athletes.map((_, i) => [...hw.scene.athletes[i].state.com]) });
      if (hw.steps % 4) continue;
      clock = 100 + hw.time;
      bob.sendInput(input({ move: { x: 0, y: 1 }, cameraYaw: Math.PI / 2 })); // Bob, the tackler: run across the field (+X)
      await flush();
      for (const g of [ann, bob]) {
        if (!g.render(clock)) continue;
        const t = g.replica!.time, h = hist.find((x) => x.t >= t - 1e-9);
        if (!h || hw.time < 0.5) continue;
        g.play!.world.athletes.forEach((_, i) => { const c = g.play!.world.scene.athletes[i].state.com; worst = Math.max(worst, Math.hypot(c[0] - h.com[i][0], c[1] - h.com[i][1], c[2] - h.com[i][2])); });
        checks++;
      }
    }
    const moved = hw.scene.athletes[bobAt].state.com[0] - start[bobAt][0];
    console.log(`loopback: ${checks} guest frames, worst replica COM error ${(100 * worst).toFixed(1)} cm, Bob's athlete moved ${moved.toFixed(2)} m along +X`);
    expect(checks).toBeGreaterThan(150);
    expect(worst).toBeLessThan(0.05);
    expect(moved).toBeGreaterThan(2);
    expect(ann.replica!.delay).toBeLessThan(0.2);

    // Bob leaves mid-rep: his athlete is a bot at once, Ann hears of it
    const annEvents: L.NetEvent[] = [];
    ann.onEvent = (e) => annEvents.push(e);
    bob.close(); await flush();
    expect(hp.isBot(bobAt)).toBe(true);
    expect(hp.brains[bobAt]).not.toBeInstanceOf(HumanBrain);
    expect(events).toEqual([{ k: 'left', name: 'Bob', athlete: bobAt }]);
    expect(annEvents).toEqual(events);
    expect(ann.lobby.players.map((p) => p.name)).toEqual(['Host', 'Ann']);
    for (let k = 0; k < 120; k++) host.step(); // and the play goes on
    expect(hw.scene.stats().instabilities).toBe(0);
    // the next rep waits for every player on a position: the host alone, then Ann, restarts it; the votes reset
    const restarts: number[] = [];
    host.onRestart = () => restarts.push(hw.time);
    host.voteRestart(); await flush();
    expect([restarts.length, ann.tally]).toEqual([0, { have: 1, need: 2, due: false }]);
    ann.voteRestart(); await flush();
    expect(restarts.length).toBe(1);
    await host.begin(CFG, human, 0);
    for (let k = 0; k < 200 && ann.start?.rep !== 1; k++) await flush();
    expect([ann.start?.rep, host.lobby.votes, ann.voted]).toEqual([1, [], false]);
    host.onRestart = () => {};

    // a late joiner watches the rep in progress; back to the lobby, the guests drop their replicas
    const cy = new Session(room.join('Cy'), mujocoEngine, 'Cy', { mode: 'tackle', options: {}, steer: 0 }, now);
    for (let k = 0; k < 200 && !cy.play; k++) await flush();
    expect([cy.play?.human, cy.mySlot]).toEqual([-1, -1]);
    host.toLobby(); await flush();
    expect([ann.play, cy.play, ann.lobby.phase]).toEqual([null, null, 'lobby']);
    host.close(); await flush();
    expect(ann.closed).toBe('host-left');
  }, 120_000);
});
