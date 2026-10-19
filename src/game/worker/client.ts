// The page's side of worker mode (protocol.ts): starts reps in the physics Worker, keeps one request in flight, and
// shows each returned snapshot on a replica Play (pose, velocities from the last two snapshots, contacts from a
// forward pass, and the play's meta), as a multiplayer guest does without the network's delay.
import type { HumanInput } from '../../sim/brains/human';
import type { Brain } from '../../sim/brains/types';
import { neutralCommands } from '../../sim/control/types';
import { Play } from '../../sim/modes/play';
import { modeById } from '../../sim/modes/registry';
import type { ModeOptions, PlayConfig } from '../../sim/modes/types';
import { applyMeta, decodeSnapshot } from '../../sim/net/snapshot';
import type { PhysicsEngine } from '../../sim/physics/engine';
import type { FromSim, ToSim } from './protocol';

/** The replica's stand-in for the player's brain: never run (the replica never steps), it only makes athlete 0 the
 *  player's, so the bodies match the Worker's. */
const PLAYER: Brain = { think: () => neutralCommands() };

export type Frame = Extract<FromSim, { t: 'frame' }>;

export class SimClient {
  /** This rep's replica (null until started), and the step requests out (at most two: the Worker always has the next
   *  one when it finishes, so it never waits on the page; a frame or two of latency). */
  play: Play | null = null;
  inFlight = 0;
  private worker: Worker;
  private id = 0;
  private ready: ((m: FromSim) => void) | null = null;
  private frames: Frame[] = [];
  private prev: { q: Float32Array; time: number } | null = null;
  private qd: Float64Array | null = null;
  failed = '';

  constructor(private engine: PhysicsEngine) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromSim>) => this.got(e.data);
    this.worker.onerror = (e) => { this.failed = e.message || 'worker error'; this.inFlight = 0; this.ready?.({ t: 'error', id: this.id, message: this.failed }); };
  }

  private send(m: ToSim) { this.worker.postMessage(m); }

  private got(m: FromSim) {
    if (m.id !== this.id) return; // an older rep's
    if (m.t === 'frame') { this.inFlight = Math.max(0, this.inFlight - 1); this.frames.push(m); return; }
    if (m.t === 'error') { this.failed = m.message; this.inFlight = 0; }
    this.ready?.(m);
  }

  /** Build a rep in the Worker and its replica here; resolves with the replica once the first snapshot is shown. */
  async start(cfg: PlayConfig, mode: string, options: ModeOptions, rep: number, steer: number): Promise<Play> {
    const id = ++this.id;
    this.inFlight = 0; this.frames = []; this.prev = null;
    const got = new Promise<FromSim>((resolve) => (this.ready = resolve));
    this.send({ t: 'start', id, cfg, mode, options, rep, steer });
    const play = await Play.create(this.engine, cfg, modeById(mode), options, PLAYER, rep);
    const m = await got;
    if (m.t === 'error') { play.destroy(); throw new Error(m.message); }
    if (id !== this.id) { play.destroy(); throw new Error('superseded'); }
    this.qd = new Float64Array(play.world.scene.nv);
    this.play = play;
    if (m.t === 'ready') this.show(m.snap);
    return play;
  }

  /** Whether another request may go out now. */
  get free() { return !!this.play && this.inFlight < 2; }

  /** Ask for `n` more fixed steps with this input. */
  step(n: number, input: HumanInput | null, stopOnBig: boolean) {
    if (!this.free || n <= 0) return;
    this.inFlight++;
    this.send({ t: 'step', id: this.id, n, input, stopOnBig });
  }

  /** The results that arrived since the last call (the newest snapshot shown; every one's events returned). */
  take(): Frame[] {
    const out = this.frames;
    this.frames = [];
    if (out.length) this.show(out[out.length - 1].snap);
    return out;
  }

  /** Write a snapshot into the replica: pose, velocities (from the previous snapshot), contacts, meta. */
  private show(data: ArrayBuffer) {
    const play = this.play;
    if (!play) return;
    const w = play.world, sc = w.scene, s = decodeSnapshot(data, sc.nq, w.athletes.length);
    if (!s) return;
    const qd = this.qd!, dt = this.prev ? s.time - this.prev.time : 0;
    if (this.prev && dt > 0) sc.diffQ(this.prev.q, s.q, dt, qd); else if (!this.prev) qd.fill(0);
    sc.writeQ(s.q, qd);
    w.time = s.time;
    w.sense();
    applyMeta(play, s);
    this.prev = { q: s.q, time: s.time };
  }

  /** End the rep in the Worker (the replica is the caller's to destroy). */
  stop() { this.id++; this.play = null; this.inFlight = 0; this.frames = []; this.send({ t: 'stop' }); }

  dispose() { this.worker.terminate(); this.play = null; }
}
