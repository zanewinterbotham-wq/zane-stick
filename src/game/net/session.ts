// One multiplayer room from the game's side (docs/multiplayer.md): the lobby, and each rep's Play. The host keeps the
// lobby, runs the only simulation (his own athlete from his HumanBrain, each guest's from a HumanBrain fed by that
// guest's input) and sends snapshots 30 times a second; a guest builds the same Play from the 'start' message, never
// steps it, and shows the snapshots through a Replica. No DOM: the browser shell drives it, Node tests use a
// loopback room.
import type { NetRoom } from '../../net/room';
import { HumanBrain, type HumanInput } from '../../sim/brains/human';
import type { Brain } from '../../sim/brains/types';
import { GAIT_SPEED } from '../../sim/control/hand';
import { neutralCommands } from '../../sim/control/types';
import { clamp } from '../../sim/math';
import { Play } from '../../sim/modes/play';
import { modeById } from '../../sim/modes/registry';
import type { ModeOptions, PlayConfig } from '../../sim/modes/types';
import { decodeInput, encodeInput, type PassHold } from '../../sim/net/input';
import { MSG, Replica, encodeSnapshot } from '../../sim/net/snapshot';
import type { PhysicsEngine } from '../../sim/physics/engine';
import { BUILD } from './version';
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

/** Prediction model: speeding up and braking (m/s², about the animator's sprint ACCEL and DECEL), the correction
 *  blend (s), the error that snaps instead (m), and the longest lead it covers (s). */
const PREDICT = { accel: 7, decel: 9, blend: 0.1, snap: 1, maxLead: 0.5 };

/** The ground velocity a HumanInput asks for (m/s, world x z), as HumanBrain reads it (no steer assist). */
function wish(i: HumanInput | null): [number, number] {
  if (!i) return [0, 0];
  const y = i.cameraYaw, mx = Math.sin(y) * i.move.y - Math.cos(y) * i.move.x, mz = Math.cos(y) * i.move.y + Math.sin(y) * i.move.x, m = Math.hypot(mx, mz);
  if (m < 0.1) return [0, 0];
  const s = i.sprint > 0.5 ? GAIT_SPEED.sprint * Math.min(1, m) : m > 0.6 ? GAIT_SPEED.jog * Math.min(1, m) : GAIT_SPEED.walk;
  return [(mx / m) * s, (mz / m) * s];
}

/** A guest's prediction of his own athlete (client-side prediction, display only; the host stays authoritative).
 *  His input drives a simple velocity model at once; the shown body is shifted by how much that model's velocity has
 *  changed over the lead (the time an input takes to come back in a snapshot): ∫ (v(τ) − v(now − lead)) dτ over
 *  [now − lead, now]. Running steadily that is zero, so he stays where the host has him and lines up with everyone
 *  else; on a start, stop or cut it moves him the way he asked before the host's answer arrives, and drains away as
 *  it does. A wrong model never drifts (the window is short; |shift| ≤ decel·lead²/2). The shift is scaled by
 *  `weight` (0 in contact, near an opponent, knocked or down: physics there is the host's) and blended in over
 *  ~100 ms; host contact or a big error snaps it. */
export class Predictor {
  /** The shift shown now (m, world x z). */
  off: [number, number] = [0, 0];
  private v: [number, number] = [0, 0];
  /** The model's velocity from each frame's time on (zero-order hold). */
  private hist: { t: number; vx: number; vz: number }[] = [];
  private last = NaN;

  update(now: number, input: HumanInput | null, lead: number, weight: number, snap: boolean): [number, number] {
    const dt = Number.isNaN(this.last) ? 0 : clamp(now - this.last, 0, 0.1);
    this.last = now;
    lead = clamp(lead, 0, PREDICT.maxLead);
    const v = this.v, [tx, tz] = wish(input), ex = tx - v[0], ez = tz - v[1], e = Math.hypot(ex, ez);
    const a = (tx * v[0] + tz * v[1] >= v[0] * v[0] + v[1] * v[1] ? PREDICT.accel : PREDICT.decel) * dt;
    const k = e > a ? a / e : 1;
    v[0] += ex * k; v[1] += ez * k;
    const h = this.hist;
    if (!h.length) h.push({ t: now - PREDICT.maxLead, vx: 0, vz: 0 }); // standing before the first frame
    h.push({ t: now, vx: v[0], vz: v[1] });
    while (h.length > 2 && h[1].t <= now - PREDICT.maxLead) h.shift();
    // the model's velocity at now − lead, then the integral of the change since
    const from = now - lead;
    let o = h.length - 1;
    while (o > 0 && h[o].t > from) o--;
    const v0 = h[o];
    let sx = 0, sz = 0;
    for (let j = o; j < h.length - 1; j++) {
      const len = h[j + 1].t - Math.max(h[j].t, from);
      if (len > 0) { sx += (h[j].vx - v0.vx) * len; sz += (h[j].vz - v0.vz) * len; }
    }
    sx *= weight; sz *= weight;
    const f = this.off, err = Math.hypot(sx - f[0], sz - f[1]), b = snap || err > PREDICT.snap ? 1 : Math.min(1, dt / PREDICT.blend);
    f[0] += (sx - f[0]) * b; f[1] += (sz - f[1]) * b;
    return f;
  }
}

export class Session {
  lobby: Lobby;
  /** This rep's play (the host's simulation, or the guest's replica world), its start message, and the replica. */
  play: Play | null = null;
  start: StartMsg | null = null;
  /** Host: the rep being built (its start is out, its play not yet): a guest joining now gets this one. */
  private next: StartMsg | null = null;
  replica: Replica | null = null;
  closed = '';
  // the shell's hooks
  onLobby: (l: Lobby) => void = () => {};
  onStart: (s: StartMsg, play: Play) => void = () => {};
  onEvent: (e: NetEvent) => void = () => {};
  onClose: (reason: string) => void = () => {};
  /** Host: every player on a position has asked for the next rep. */
  onRestart: () => void = () => {};
  /** Host: each guest's brain this rep (by id), his steer assist and newest input seq. */
  private remote = new Map<string, { brain: HumanBrain | null; steer: number; seq: number }>();
  private banned = new Set<string>();
  /** Host: every name seen in the room by id (one may have left before his last message arrived). */
  private known = new Map<string, string>();
  private snapAt = 0; private scored = false; private rep = 0; private seq = 0; private builds = 0; private pingSent = -Infinity;

  /** `clock`: a steady clock in seconds (snapshot arrival times, ping throttling). */
  /** This game's build (version.ts); tests pass another to play an outdated client. */
  readonly version: string;

  constructor(readonly room: NetRoom, readonly engine: PhysicsEngine, selfName: string, setup: { mode: string; options: ModeOptions; steer: number; build?: string },
    readonly clock: () => number = () => performance.now() / 1000) {
    this.version = setup.build ?? BUILD;
    this.lobby = L.newLobby({ id: room.selfId, name: selfName }, setup.mode, setup.options, this.version);
    if (!room.isHost) { this.lobby.players = []; this.lobby.assign.fill(null); } // until the host's arrives
    room.onMessage((from, data) => (room.isHost ? this.hostGot(from, data) : this.guestGot(data)));
    room.onClose((r) => this.end(r));
    if (room.isHost) { room.onPeers((p) => this.peers(p)); this.peers(room.peers()); }
    else room.broadcast(JSON.stringify({ t: 'hi', steer: setup.steer, v: this.version } satisfies L.ToHost), true);
  }

  get isHost() { return this.room.isHost; }
  get selfId() { return this.room.selfId; }
  /** The local player's slot in the lobby (−1: watching). */
  get mySlot() { return this.lobby.assign.indexOf(this.selfId); }
  name(id: string | null) { return this.lobby.players.find((p) => p.id === id)?.name ?? ''; }

  // ------------------------------------------------------------------ lobby actions (anyone)
  want(slot: number | null) { this.isHost ? this.edit(() => L.want(this.lobby, this.selfId, slot)) : this.say({ t: 'want', slot }); }
  ready(on: boolean) { if (!this.isHost) this.say({ t: 'ready', on }); }
  /** Ask for the next rep (or take it back): it starts once every player on a position has asked. */
  voteRestart(on = !this.voted) {
    if (this.isHost) return this.edit(() => L.vote(this.lobby, this.selfId, on));
    this.myVote = on; // at once: a second press before the host's lobby comes back takes it back
    this.say({ t: 'restart', on, rep: this.start?.rep ?? -1 });
  }
  get voted() { return this.isHost ? this.lobby.votes.includes(this.selfId) : this.myVote; }
  /** Guest: his own vote this rep, as he last sent it. */
  private myVote = false;
  /** This rep's restart votes (have / need), for the HUD. */
  get tally() { return L.restartTally(this.lobby, this.start?.assign ?? this.lobby.assign); }
  // host only
  setup(mode: string, options: ModeOptions) { this.edit(() => L.setup(this.lobby, mode, options)); }
  count(id: string, delta: number) { this.edit(() => L.count(this.lobby, id, delta)); }
  place(slot: number, id: string | null) { this.edit(() => L.place(this.lobby, slot, id)); }
  autoAssign() { this.edit(() => L.autoAssign(this.lobby)); }
  allBots() { this.edit(() => L.allBots(this.lobby)); }
  kick(id: string) {
    if (!this.isHost || id === this.selfId) return;
    this.tell({ t: 'kick' }, id); // an older room server has no kick: the message alone sends an honest guest away
    this.banned.add(id); // until the server's leave arrives
    this.gone(id);
    // shortcut: he can rejoin at once under a new id (a new socket), until rooms get a lock or a ban list
    this.room.kick(id);
    this.sendLobby();
    this.due();
  }

  private say(m: L.ToHost) { this.room.broadcast(JSON.stringify(m), true); }
  /** Host: a reliable game message to one guest, or (no `to`) to every guest. */
  private tell(m: ToGuest, to?: string) { const s = JSON.stringify(m); if (to) this.room.send(to, s, true); else this.room.broadcast(s, true); }
  private edit(f: () => void) { if (!this.isHost) return; f(); this.sendLobby(); this.due(); }
  /** Host: start the next rep once its votes are in (asked during a running rep only). */
  private due() { if (this.isHost && this.start && this.play && this.lobby.phase === 'game' && this.tally.due) this.onRestart(); }
  private sendLobby() {
    this.pingSent = this.clock();
    this.tell({ t: 'lobby', lobby: this.lobby });
    this.onLobby(this.lobby);
  }

  // ------------------------------------------------------------------ game (host)
  /** Host: start a rep with the lobby's assignment (a new game counts down first). The local player plays his slot
   *  with `human`; every guest on a slot gets a fresh HumanBrain fed by his input. */
  async begin(cfg: PlayConfig, human: HumanBrain, countdown = 0): Promise<Play> {
    const l = this.lobby, assign = l.assign.slice(), rep = this.rep++;
    const start: StartMsg = { mode: l.mode, options: { ...l.options }, seed: cfg.seed, rep, assign, cfg, countdown };
    l.phase = 'game'; l.votes = [];
    this.sendLobby();
    this.tell({ t: 'start', start }); // first, so the guests build while the host does
    this.next = start;
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

  event(ev: NetEvent) { if (this.isHost) this.tell({ t: 'ev', ev }); }

  /** Host: back to the lobby (everyone's screens follow the phase). */
  toLobby() {
    if (!this.isHost) return;
    this.builds++;
    this.lobby.phase = 'lobby';
    this.drop();
    this.sendLobby();
  }

  // ------------------------------------------------------------------ game (guest)
  /** Guest: the local input, every render frame (the host's HumanBrain for him reads the newest). Over the relay, where
   *  every message bills the room server, at most SNAP_HZ a second, but a throw or a button change goes at once. */
  sendInput(i: HumanInput) {
    if (this.isHost) return;
    this.input = i;
    const t = this.clock(), held = [...i.held].join();
    if (this.room.peers().find((p) => p.host)?.via !== 'rtc' && !i.pass && held === this.inputHeld && t - this.inputAt < 1 / SNAP_HZ) return;
    this.inputAt = t; this.inputHeld = held;
    this.room.broadcast(encodeInput(i, ++this.seq, this.passHold), false);
  }
  private inputAt = -Infinity; private inputHeld = '';
  /** A guest's last throw, repeated in the next few inputs (a lost packet must not lose it). */
  private passHold: PassHold = { pass: null, until: -1 };
  /** Guest: the input last given to sendInput (the prediction's), and this rep's prediction of his own athlete. */
  private input: HumanInput | null = null;
  predictor = new Predictor();

  /** Guest: shift his own athlete (slot `me`) in the replica's pose `q` by the prediction, and the ball with him when
   *  he carries it. */
  private predict(q: Float64Array, me: number, now: number) {
    const d = this.play, r = this.replica;
    if (!d || !r) return;
    const w = d.world, a = w.athletes[me], f = w.scene.freeQ, px = q[f[me]], pz = q[f[me] + 2];
    let near = Infinity;
    for (let i = 0; i < w.athletes.length; i++) if (i !== me) near = Math.min(near, Math.hypot(q[f[i]] - px, q[f[i] + 2] - pz));
    // physics around other bodies, or a knocked or downed body, is the host's alone: no prediction there
    const free = !a.playerContact && !a.grips.some((g) => g.active) && !a.support.down && !a.cmd.dive && a.knock < 0.1 && !a.injury.out && !d.ended;
    const lead = (this.room.peers().find((p) => p.host)?.rtt || 0.1) + r.delay;
    const [dx, dz] = this.predictor.update(now, this.input, lead, free ? clamp((near - 1.2) / 1, 0, 1) : 0, a.playerContact);
    q[f[me]] += dx; q[f[me] + 2] += dz;
    if (w.ballCarrier === me) { const b = f[w.athletes.length]; q[b] += dx; q[b + 2] += dz; } // the ball: prop 0, the first free joint after the athletes'
  }

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
    if (m.t === 'hi') {
      // another build cannot play here (its replica would not match, nor its messages): he is told to reload
      if (m.v !== this.version) {
        const name = this.known.get(from) ?? '';
        this.tell({ t: 'kick', why: 'version' }, from);
        this.banned.add(from); // or the next peers update (an rtt probe) puts him back on a slot
        this.gone(from); this.sendLobby();
        this.onEvent({ k: 'old', name }); this.event({ k: 'old', name });
        return;
      }
      const r = this.remote.get(from); if (r) { r.steer = m.steer; if (r.brain) r.brain.steerAssist = m.steer; } // he is known from onPeers first
    }
    else if (m.t === 'want') this.edit(() => L.want(this.lobby, from, m.slot));
    else if (m.t === 'restart') { if (m.rep === (this.next ?? this.start)?.rep) this.edit(() => L.vote(this.lobby, from, m.on)); } // a late vote is for a rep gone by
    else this.edit(() => L.setReady(this.lobby, from, m.on));
  }

  private guestGot(data: ArrayBuffer | string) {
    if (typeof data !== 'string') { this.replica?.push(data, this.clock()); return; }
    let m: ToGuest;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'lobby') {
      if (m.lobby.build !== this.version) { this.end('version'); this.room.close(); return; } // the host's game is another version
      this.lobby = m.lobby;
      if (m.lobby.phase === 'lobby') { this.builds++; this.drop(); }
      this.onLobby(this.lobby);
    } else if (m.t === 'start') void this.build(m.start);
    else if (m.t === 'ev') this.onEvent(m.ev);
    else if (m.t === 'kick') { this.end(m.why === 'version' ? 'version' : 'kicked'); this.room.close(); }
  }

  /** Guest: the same Play as the host's (same mode, options, seed, rep, config, and players on the same slots, so
   *  the bodies match), shown through a Replica. */
  private async build(s: StartMsg) {
    const req = ++this.builds, me = s.assign.indexOf(this.selfId);
    const play = await Play.create(this.engine, s.cfg, modeById(s.mode), s.options, me >= 0 ? PLAYER : null, s.rep, { human: me, fixed: s.assign.map((id) => (id ? PLAYER : null)) });
    if (req !== this.builds || this.closed) { play.destroy(); return; }
    this.replica = new Replica(play);
    this.predictor = new Predictor();
    if (me >= 0) this.replica.adjust = (q, now) => this.predict(q, me, now);
    this.swap(play, s);
  }

  private swap(play: Play, s: StartMsg) {
    const old = this.play;
    this.play = play; this.start = s; this.next = null; this.myVote = false;
    this.onStart(s, play); // the shell moves its renderer to the new world before the old one goes
    old?.destroy();
  }

  private drop() { this.play?.destroy(); this.play = null; this.start = null; this.next = null; this.replica = null; }

  /** Host: the transport's peer list changed (join, leave, path, ping). */
  private peers(list: ReturnType<NetRoom['peers']>) {
    const names = new Map(this.lobby.players.map((p) => [p.id, p.name])); // before the sync drops who left
    const { joined, left, changed } = L.syncPeers(this.lobby, list.filter((p) => !this.banned.has(p.id)));
    for (const p of list) this.known.set(p.id, p.name);
    for (const id of joined) {
      this.remote.set(id, { brain: null, steer: 0.3, seq: -1 });
      // joined mid-game: he watches this rep (the one being built, else the running one)
      if (this.next) this.tell({ t: 'start', start: this.next }, id);
      else if (this.start && this.play) this.tell({ t: 'start', start: { ...this.start, countdown: 0 } }, id);
    }
    for (const id of left) this.gone(id, names.get(id) ?? '');
    if (joined.length || left.length || changed || this.clock() - this.pingSent >= PING_EVERY / 1000) this.sendLobby();
    if (left.length) this.due(); // the one still to ask may have been the one who left
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
