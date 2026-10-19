// One multiplayer room from the game's side (docs/multiplayer.md): the lobby, and each rep's Play. The host keeps the
// lobby, runs the only simulation (his own athlete from his HumanBrain, each guest's from a HumanBrain fed by that
// guest's input) and sends snapshots 30 times a second; a guest builds the same Play from the 'start' message, never
// steps it, and shows the snapshots through a Replica. No DOM: the browser shell drives it, Node tests use a
// loopback room.
import type { NetRoom } from '../../net/room';
import { HumanBrain, type HumanInput } from '../../sim/brains/human';
import type { Brain } from '../../sim/brains/types';
import { neutralCommands } from '../../sim/control/types';
import { Play } from '../../sim/modes/play';
import { modeById } from '../../sim/modes/registry';
import type { ModeOptions, PlayConfig } from '../../sim/modes/types';
import { decodeInput, encodeInput } from '../../sim/net/input';
import { MSG, Replica, encodeSnapshot } from '../../sim/net/snapshot';
import type { PhysicsEngine } from '../../sim/physics/engine';
import * as L from './lobby';
import type { Lobby, NetEvent, StartMsg, ToGuest } from './lobby';

/** Snapshots per second of sim time (unreliable channel). */
export const SNAP_HZ = 30;
/** Seconds of 3-2-1 before the first rep of a game. */
export const COUNTDOWN = 3;
/** A ping-only change to the lobby is sent at most this often (ms of `clock`). */
const PING_EVERY = 1000;
/** A guest's stand-in for every player's brain: never run (the guest does not step), it only makes the slot a
 *  player's, so the body and toughness match the host's. */
const PLAYER: Brain = { think: () => neutralCommands() };

export class Session {
  lobby: Lobby;
  /** This rep's play (the host's simulation, or the guest's replica world), its start message, and the replica. */
  play: Play | null = null;
  start: StartMsg | null = null;
  replica: Replica | null = null;
  closed = '';
  // the shell's hooks
  onLobby: (l: Lobby) => void = () => {};
  onStart: (s: StartMsg, play: Play) => void = () => {};
  onEvent: (e: NetEvent) => void = () => {};
  onClose: (reason: string) => void = () => {};
  /** Host: each guest's brain this rep (by id), his steer assist and newest input seq. */
  private remote = new Map<string, { brain: HumanBrain | null; steer: number; seq: number }>();
  private banned = new Set<string>();
  private snapAt = 0; private scored = false; private rep = 0; private seq = 0; private builds = 0; private pingSent = -Infinity;

  /** `clock`: a steady clock in seconds (snapshot arrival times, ping throttling). */
  constructor(readonly room: NetRoom, readonly engine: PhysicsEngine, selfName: string, setup: { mode: string; options: ModeOptions; steer: number },
    readonly clock: () => number = () => performance.now() / 1000) {
    this.lobby = L.newLobby({ id: room.selfId, name: selfName }, setup.mode, setup.options);
    if (!room.isHost) { this.lobby.players = []; this.lobby.assign.fill(null); } // until the host's arrives
    room.onMessage((from, data) => (room.isHost ? this.hostGot(from, data) : this.guestGot(data)));
    room.onClose((r) => this.end(r));
    if (room.isHost) { room.onPeers((p) => this.peers(p)); this.peers(room.peers()); }
    else room.broadcast(JSON.stringify({ t: 'hi', steer: setup.steer }), true);
  }

  get isHost() { return this.room.isHost; }
  get selfId() { return this.room.selfId; }
  /** The local player's slot in the lobby (−1: watching). */
  get mySlot() { return this.lobby.assign.indexOf(this.selfId); }
  name(id: string | null) { return this.lobby.players.find((p) => p.id === id)?.name ?? ''; }

  // ------------------------------------------------------------------ lobby actions (anyone)
  want(slot: number | null) { this.isHost ? this.edit(() => L.want(this.lobby, this.selfId, slot)) : this.say({ t: 'want', slot }); }
  ready(on: boolean) { if (!this.isHost) this.say({ t: 'ready', on }); }
  // host only
  setup(mode: string, options: ModeOptions) { this.edit(() => L.setup(this.lobby, mode, options)); }
  count(id: string, delta: number) { this.edit(() => L.count(this.lobby, id, delta)); }
  place(slot: number, id: string | null) { this.edit(() => L.place(this.lobby, slot, id)); }
  autoAssign() { this.edit(() => L.autoAssign(this.lobby)); }
  allBots() { this.edit(() => L.allBots(this.lobby)); }
  kick(id: string) {
    if (!this.isHost || id === this.selfId) return;
    this.room.send(id, JSON.stringify({ t: 'kick' } satisfies ToGuest), true);
    this.banned.add(id);
    this.gone(id);
    this.sendLobby();
  }

  private say(m: L.ToHost) { this.room.broadcast(JSON.stringify(m), true); }
  private edit(f: () => void) { if (!this.isHost) return; f(); this.sendLobby(); }
  private sendLobby() {
    this.pingSent = this.clock();
    this.room.broadcast(JSON.stringify({ t: 'lobby', lobby: this.lobby } satisfies ToGuest), true);
    this.onLobby(this.lobby);
  }

  // ------------------------------------------------------------------ game (host)
  /** Host: start a rep with the lobby's assignment (a new game counts down first). The local player plays his slot
   *  with `human`; every guest on a slot gets a fresh HumanBrain fed by his input. */
  async begin(cfg: PlayConfig, human: HumanBrain, countdown = 0): Promise<Play> {
    const l = this.lobby, assign = l.assign.slice(), rep = this.rep++;
    const start: StartMsg = { mode: l.mode, options: { ...l.options }, seed: cfg.seed, rep, assign, cfg, countdown };
    l.phase = 'game';
    this.sendLobby();
    this.room.broadcast(JSON.stringify({ t: 'start', start } satisfies ToGuest), true); // first, so the guests build while the host does
    for (const r of this.remote.values()) r.brain = null;
    const fixed = assign.map((id) => {
      const r = id && id !== this.selfId ? this.remote.get(id) : undefined;
      if (!r) return null;
      r.brain = new HumanBrain(); r.brain.steerAssist = r.steer; r.seq = -1;
      return r.brain;
    });
    const me = assign.indexOf(this.selfId), req = ++this.builds;
    const play = await Play.create(this.engine, cfg, modeById(l.mode), start.options, me >= 0 ? human : null, rep, { human: me, fixed });
    if (req !== this.builds || this.closed) { play.destroy(); return play; }
    // a guest who left while it was being built is a bot already
    assign.forEach((id, i) => { if (id && id !== this.selfId && !this.remote.has(id)) { play.toBot(i); assign[i] = null; } });
    this.swap(play, start);
    this.snapAt = play.world.time; this.scored = false;
    return play;
  }

  /** Host: one fixed step of the play, its snapshot on time, and the score when it ends. */
  step() {
    const d = this.play;
    if (!d || !this.isHost) return;
    d.step();
    const w = d.world;
    if (w.time >= this.snapAt) {
      this.room.broadcast(encodeSnapshot(d), false);
      this.snapAt = Math.max(this.snapAt + 1 / SNAP_HZ, w.time - 0.5 / SNAP_HZ); // steady cadence, never a burst to catch up
    }
    if (d.ended && !this.scored) {
      this.scored = true;
      if (d.scorer >= 0 && d.points) { this.lobby.score[d.scorer as 0 | 1] += d.points; this.sendLobby(); }
    }
  }

  event(ev: NetEvent) { if (this.isHost) this.room.broadcast(JSON.stringify({ t: 'ev', ev } satisfies ToGuest), true); }

  /** Host: back to the lobby (everyone's screens follow the phase). */
  toLobby() {
    if (!this.isHost) return;
    this.builds++;
    this.lobby.phase = 'lobby';
    this.drop();
    this.sendLobby();
  }

  // ------------------------------------------------------------------ game (guest)
  /** Guest: the local input, every render frame (the host's HumanBrain for him reads the newest). */
  sendInput(i: HumanInput) { if (!this.isHost) this.room.broadcast(encodeInput(i, ++this.seq), false); }

  /** Guest: show the play at the clock's now; false until a snapshot of this rep has arrived. */
  render(now = this.clock()) { return this.replica?.render(now) ?? false; }

  close() { this.room.close(); }

  // ------------------------------------------------------------------ wire
  private hostGot(from: string, data: ArrayBuffer | string) {
    if (this.banned.has(from)) return;
    if (typeof data !== 'string') {
      const r = this.remote.get(from), m = new Uint8Array(data)[0] === MSG.input ? decodeInput(data) : null;
      if (r?.brain && m && m.seq > r.seq) { r.seq = m.seq; r.brain.latest = m.input; }
      return;
    }
    const m = L.parseToHost(data);
    if (!m) return;
    if (m.t === 'hi') { const r = this.remote.get(from); if (r) { r.steer = m.steer; if (r.brain) r.brain.steerAssist = m.steer; } } // he is known from onPeers first
    else if (m.t === 'want') this.edit(() => L.want(this.lobby, from, m.slot));
    else this.edit(() => L.setReady(this.lobby, from, m.on));
  }

  private guestGot(data: ArrayBuffer | string) {
    if (typeof data !== 'string') { this.replica?.push(data, this.clock()); return; }
    let m: ToGuest;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'lobby') {
      this.lobby = m.lobby;
      if (m.lobby.phase === 'lobby') { this.builds++; this.drop(); }
      this.onLobby(this.lobby);
    } else if (m.t === 'start') void this.build(m.start);
    else if (m.t === 'ev') this.onEvent(m.ev);
    else if (m.t === 'kick') { this.end('kicked'); this.room.close(); }
  }

  /** Guest: the same Play as the host's (same mode, options, seed, rep, config, and players on the same slots, so
   *  the bodies match), shown through a Replica. */
  private async build(s: StartMsg) {
    const req = ++this.builds, me = s.assign.indexOf(this.selfId);
    const play = await Play.create(this.engine, s.cfg, modeById(s.mode), s.options, me >= 0 ? PLAYER : null, s.rep, { human: me, fixed: s.assign.map((id) => (id ? PLAYER : null)) });
    if (req !== this.builds || this.closed) { play.destroy(); return; }
    this.replica = new Replica(play);
    this.swap(play, s);
  }

  private swap(play: Play, s: StartMsg) {
    const old = this.play;
    this.play = play; this.start = s;
    this.onStart(s, play); // the shell moves its renderer to the new world before the old one goes
    old?.destroy();
  }

  private drop() { this.play?.destroy(); this.play = null; this.start = null; this.replica = null; }

  /** Host: the transport's peer list changed (join, leave, path, ping). */
  private peers(list: ReturnType<NetRoom['peers']>) {
    const names = new Map(this.lobby.players.map((p) => [p.id, p.name])); // before the sync drops who left
    const { joined, left, changed } = L.syncPeers(this.lobby, list.filter((p) => !this.banned.has(p.id)));
    for (const id of joined) {
      this.remote.set(id, { brain: null, steer: 0.3, seq: -1 });
      if (this.start && this.play) this.room.send(id, JSON.stringify({ t: 'start', start: { ...this.start, countdown: 0 } } satisfies ToGuest), true); // joined mid-game: he watches this rep
    }
    for (const id of left) this.gone(id, names.get(id) ?? '');
    if (joined.length || left.length || changed || this.clock() - this.pingSent >= PING_EVERY / 1000) this.sendLobby();
  }

  /** Host: a guest left (or was kicked). His athlete is a bot from this moment. */
  private gone(id: string, name = this.name(id)) {
    L.leave(this.lobby, id);
    this.remote.delete(id);
    const i = this.start?.assign.indexOf(id) ?? -1;
    if (i >= 0 && this.play) {
      this.play.toBot(i); this.start!.assign[i] = null;
      this.event({ k: 'left', name, athlete: i });
      this.onEvent({ k: 'left', name, athlete: i });
    }
  }

  private end(reason: string) {
    if (this.closed) return;
    this.closed = reason;
    this.builds++;
    this.drop();
    this.onClose(reason);
  }
}
