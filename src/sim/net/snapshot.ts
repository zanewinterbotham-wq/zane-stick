// Multiplayer snapshots (docs/multiplayer.md): the host's Play encoded ~30 times a second (every generalised position
// of the scene plus the world meta the renderer, HUD, faces and audio read), and a Replica that shows them on a guest.
// The replica holds a Play built from the same 'start' message but never steps it: each render frame it interpolates
// the two snapshots around (newest time − delay), writes the pose into the scene (forward pass only) and copies the
// meta in. Pure TypeScript: no DOM, no clock (the caller passes its own time). Size at the standard body detail:
// 596 bytes for 2 athletes, 5216 for 22 (tests/net-sim.test.ts), so qpos stays float32 (positions to ~4 µm at 60 m);
// quantising (joint angles int16, positions mm) would only be worth it past ~30 athletes.
import type { Gait } from '../control/types';
import { BREAK, type InjuryEvent } from '../injury';
import { clamp } from '../math';
import { PASS_STATES, type Play, type RepEnd } from '../modes/play';

/** First byte of every binary game message. */
export const MSG = { snap: 1, input: 2 } as const;
const VERSION = 3;
const GAITS: Gait[] = ['walk', 'jog', 'sprint'];
/** What broke, by index (injury.ts BREAK's names, then a knockout). */
const WHAT = [...new Set(Object.values(BREAK).map((b) => b.what)), 'ko'];
const HEAD = 255;
const HEADER = 20, PER_ATHLETE = 19, PLAY = 83, PER_INJURY = 28;
const enc = new TextEncoder(), dec = new TextDecoder();

/** The host's play now: header, qpos as float32, per-athlete meta, play meta, every injury so far (rare, and sent
 *  whole each time so a lost snapshot loses none), then the play's end, verdict and note strings. */
export function encodeSnapshot(play: Play): ArrayBuffer {
  const w = play.world, sc = w.scene, n = w.athletes.length, inj = w.injuries.slice(0, 255);
  const ended = enc.encode((play.ended ?? '').slice(0, 60)), verdict = enc.encode(play.verdict.slice(0, 80)), note = enc.encode(play.note.slice(0, 40));
  const buf = new ArrayBuffer(HEADER + 4 * sc.nq + PER_ATHLETE * n + PLAY + PER_INJURY * inj.length + 3 + ended.length + verdict.length + note.length);
  const v = new DataView(buf), q = new Float64Array(sc.nq);
  let o = 0;
  const u8 = (x: number) => v.setUint8(o++, x), i8 = (x: number) => v.setInt8(o++, x), f32 = (x: number) => { v.setFloat32(o, x, true); o += 4; };
  const f64 = (x: number) => { v.setFloat64(o, x, true); o += 8; }, unit = (x: number) => u8(Math.round(clamp(x, 0, 1) * 255));
  u8(MSG.snap); u8(VERSION); v.setUint16(o, play.rep & 0xffff, true); o += 2; v.setUint32(o, w.steps >>> 0, true); o += 4; f64(w.time);
  v.setUint16(o, sc.nq, true); o += 2; u8(n); u8(inj.length);
  sc.readQ(q);
  for (let i = 0; i < sc.nq; i++) f32(q[i]);
  for (const a of w.athletes) {
    const c = a.cmd, g = a.grips;
    i8(a.downBy === null ? -1 : a.segIndex.get(a.downBy)!);
    u8(+a.playerContact | +a.feet[0].touching << 1 | +a.feet[1].touching << 2 | +g[0].active << 3 | +g[1].active << 4 | +a.support.down << 5);
    u8(+c.thrustHips | +c.dive << 1 | GAITS.indexOf(c.gait) << 2 | +c.contactMode << 4 | +c.wrap << 5 | +c.hug << 6);
    unit(c.armL); unit(c.armR); unit(a.support.posture); unit(a.support.carry);
    for (const h of g) { i8(h.target?.athlete ?? -1); u8(Math.max(0, h.target?.seg ?? 0)); }
    f32(a.knock); f32(w.impact.peakHeadG[a.index] ?? 0);
  }
  i8(w.ballCarrier); i8(play.recoveredBy); u8(Math.min(255, play.fumbles)); i8(play.scorer); v.setInt16(o, play.points, true); o += 2; u8(play.impetus);
  f64(play.repStart); f64(play.endTime); f32(w.impact.closingSpeed); f32(w.impact.peakForce); f64(w.impact.firstContactTime);
  // the pass: its state, the passer, and the throw (athlete −1: none yet)
  const lp = play.lastPass;
  u8(PASS_STATES.indexOf(play.pass)); i8(play.passer); i8(lp?.athlete ?? -1); f64(lp?.time ?? 0);
  for (const x of [...(lp?.at ?? [0, 0, 0]), ...(lp?.to ?? [0, 0, 0])]) f32(x);
  unit(lp?.loft ?? 0); f32(lp?.speed ?? 0); f32(lp?.error ?? 0);
  for (const e of inj) {
    const a = w.athletes[e.athlete], j = e.kind === 'ko' ? HEAD : a.plan.joints.findIndex((x) => x.name === e.joint);
    u8(e.athlete); u8(e.kind === 'ko' ? 1 : 0); u8(j); u8(WHAT.indexOf(e.what)); f32(e.pos[0]); f32(e.pos[1]); f32(e.pos[2]); f32(e.load); f64(e.time);
  }
  u8(ended.length); new Uint8Array(buf, o, ended.length).set(ended); o += ended.length;
  u8(verdict.length); new Uint8Array(buf, o, verdict.length).set(verdict); o += verdict.length;
  u8(note.length); new Uint8Array(buf, o, note.length).set(note);
  return buf;
}

/** One decoded snapshot: its time, pose, and the meta to copy into a replica's world at that time. */
export interface Snapshot { rep: number; tick: number; time: number; q: Float32Array; view: DataView; meta: number; injuries: number }

/** Parse a snapshot's header and pose; null if it is not one, or not of this scene (wrong size: another setup). */
export function decodeSnapshot(buf: ArrayBuffer, nq: number, athletes: number): Snapshot | null {
  if (buf.byteLength < HEADER) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG.snap || v.getUint8(1) !== VERSION || v.getUint16(16, true) !== nq || v.getUint8(18) !== athletes) return null;
  const injuries = v.getUint8(19), meta = HEADER + 4 * nq, strs = meta + PER_ATHLETE * athletes + PLAY + PER_INJURY * injuries;
  // three length-prefixed strings: each length byte must be inside the buffer, and the last string must end in it
  let at = strs;
  for (let k = 0; k < 3; k++) { if (buf.byteLength <= at) return null; at += 1 + v.getUint8(at); }
  if (buf.byteLength < at) return null;
  const q = new Float32Array(nq);
  for (let i = 0; i < nq; i++) q[i] = v.getFloat32(HEADER + 4 * i, true);
  return { rep: v.getUint16(2, true), tick: v.getUint32(4, true), time: v.getFloat64(8, true), q, view: v, meta, injuries };
}

/** Copy a snapshot's meta into the replica's world and play (everything but the pose). */
export function applyMeta(play: Play, s: Snapshot) {
  const w = play.world, v = s.view;
  let o = s.meta;
  const u8 = () => v.getUint8(o++), i8 = () => v.getInt8(o++), f32 = () => { o += 4; return v.getFloat32(o - 4, true); }, f64 = () => { o += 8; return v.getFloat64(o - 8, true); };
  w.steps = s.tick;
  for (const a of w.athletes) {
    const down = i8(), fl = u8(), cm = u8(), c = a.cmd;
    a.downBy = down < 0 ? null : a.plan.segments[down]?.name ?? null;
    a.playerContact = !!(fl & 1); a.feet[0].touching = !!(fl & 2); a.feet[1].touching = !!(fl & 4);
    a.support.down = !!(fl & 32);
    c.thrustHips = !!(cm & 1); c.dive = !!(cm & 2); c.gait = GAITS[(cm >> 2) & 3] ?? 'jog'; c.contactMode = !!(cm & 16); c.wrap = !!(cm & 32); c.hug = !!(cm & 64);
    c.armL = u8() / 255; c.armR = u8() / 255; a.support.posture = u8() / 255; a.support.carry = u8() / 255;
    for (const h of [0, 1] as const) {
      const g = a.grips[h], ta = i8(), ts = u8();
      g.active = !!(fl & (8 << h)); g.target = g.active ? { athlete: ta, seg: ts } : null;
    }
    a.knock = f32(); w.impact.peakHeadG[a.index] = f32();
  }
  w.ballCarrier = i8(); play.recoveredBy = i8(); play.fumbles = u8(); play.scorer = i8() as -1 | 0 | 1; play.points = v.getInt16(o, true); o += 2; play.impetus = (u8() & 1) as 0 | 1;
  play.repStart = f64(); play.endTime = f64(); w.impact.closingSpeed = f32(); w.impact.peakForce = f32(); w.impact.firstContactTime = f64();
  play.pass = PASS_STATES[u8()] ?? 'none'; play.passer = i8();
  const pa = i8(), pt = f64(), at: [number, number, number] = [f32(), f32(), f32()], to: [number, number, number] = [f32(), f32(), f32()], loft = u8() / 255, speed = f32(), error = f32();
  play.lastPass = w.lastPass = pa < 0 ? null : { athlete: pa, time: pt, at, to, loft, speed, error };
  for (let k = 0; k < s.injuries; k++) {
    const ai = u8(), ko = u8() === 1, j = u8(), what = WHAT[u8()] ?? 'ko', pos: [number, number, number] = [f32(), f32(), f32()], load = f32(), time = f64();
    if (k < w.injuries.length) continue; // already shown
    const a = w.athletes[ai], jp = ko ? a?.plan.joints.find((x) => x.child === 'head') : a?.plan.joints[j];
    if (!a || !jp) continue;
    const e: InjuryEvent = ko ? { athlete: ai, kind: 'ko', joint: 'head', what: 'ko', seg: 'head', parentSeg: jp.parent, pos, load, time }
      : { athlete: ai, kind: 'break', joint: jp.name, what, seg: jp.child, parentSeg: jp.parent, pos, load, time };
    if (ko) a.injury.ko = true; else a.injury.breakJoint(jp.name); // limp limbs and the out-of-play state, for faces and sounds
    w.injuries.push(e);
  }
  const str = () => { const n = u8(), t = dec.decode(new Uint8Array(v.buffer, v.byteOffset + o, n)); o += n; return t; };
  const ended = str();
  play.ended = (ended || null) as RepEnd; play.verdict = str(); play.note = str();
}

/** Guest rendering delay behind the snapshots (s): at least `min`, plus `jitter` × the arrival jitter, at most `max`;
 *  and the furthest a pose is extrapolated past the newest snapshot when packets stop (s). */
const DELAY = { min: 0.1, jitter: 3, max: 0.35 }, EXTRAPOLATE = 0.1;
/** The render clock follows its target by speeding up or slowing down by at most this fraction, and jumps to it
 *  when it is this far off (s). */
const WARP = 0.1, SNAP = 0.3;

/** A guest's view of the host's play: buffers snapshots and writes an interpolated one each render frame. */
export class Replica {
  /** Current delay behind the snapshot clock (s), and the render time last written (host sim s). */
  delay = DELAY.min;
  time = -Infinity;
  /** Called with the interpolated pose (and `now`) before it is written: a guest shifts his own athlete by his
   *  prediction (game/net/session.ts). The pose is rebuilt from the snapshots every frame, so nothing accumulates. */
  adjust: ((q: Float64Array, now: number) => void) | null = null;
  private buf: Snapshot[] = [];
  private off = NaN; private jitter = 0; private lastNow = NaN;
  private readonly q: Float64Array; private readonly qd: Float64Array;

  constructor(readonly play: Play) {
    this.q = new Float64Array(play.world.scene.nq); this.qd = new Float64Array(play.world.scene.nv);
  }

  /** A snapshot arrived at local time `now` (s, any steady clock). Other reps, other setups and stale ones are
   *  dropped (false). */
  push(data: ArrayBuffer, now: number): boolean {
    const w = this.play.world, s = decodeSnapshot(data, w.scene.nq, w.athletes.length);
    if (!s || s.rep !== (this.play.rep & 0xffff) || this.buf.some((b) => b.tick >= s.tick)) return false;
    this.buf.push(s);
    // clock offset (local − host): follows the earliest arrivals at once and later ones slowly (a host slowing
    // down), and the jitter is how far arrivals stray past it
    const o = now - s.time;
    if (Number.isNaN(this.off)) this.off = o;
    else { this.jitter += (Math.max(0, o - this.off) - this.jitter) * 0.1; this.off += (o - this.off) * (o < this.off ? 0.5 : 0.02); }
    this.delay = clamp(DELAY.min + DELAY.jitter * this.jitter, DELAY.min, DELAY.max);
    return true;
  }

  /** Show the play at local time `now`: pose (positions lerped, free joints' quaternions nlerped), velocities, and
   *  the meta of the snapshot at or before that moment. False until a snapshot has arrived. */
  render(now: number): boolean {
    const b = this.buf, sc = this.play.world.scene;
    if (!b.length) return false;
    const target = now - this.off - this.delay, step = Number.isNaN(this.lastNow) ? 0 : Math.max(0, now - this.lastNow);
    this.lastNow = now;
    let t = this.time === -Infinity || Math.abs(target - this.time - step) > SNAP ? target : this.time + step + clamp(target - this.time - step, -WARP * step, WARP * step);
    t = Math.min(t, b[b.length - 1].time + EXTRAPOLATE);
    this.time = t;
    // the snapshots around t (beyond the newest: the last two, extrapolated)
    let k = b.findIndex((s) => s.time > t);
    if (k < 0) k = b.length - 1;
    const s0 = b[Math.max(0, k - 1)], s1 = b[k], dt = s1.time - s0.time, a = dt > 0 ? clamp((t - s0.time) / dt, 0, 1 + EXTRAPOLATE / dt) : 1;
    const q = this.q, q0 = s0.q, q1 = s1.q;
    for (let i = 0; i < q.length; i++) q[i] = q0[i] + (q1[i] - q0[i]) * a;
    for (const f of sc.freeQ) {
      const d = q0[f + 3] * q1[f + 3] + q0[f + 4] * q1[f + 4] + q0[f + 5] * q1[f + 5] + q0[f + 6] * q1[f + 6], sg = d < 0 ? -1 : 1;
      let n = 0;
      for (let j = 3; j < 7; j++) n += (q[f + j] = q0[f + j] + (sg * q1[f + j] - q0[f + j]) * a) ** 2;
      n = Math.sqrt(n) || 1;
      for (let j = 3; j < 7; j++) q[f + j] /= n;
    }
    if (dt > 0) sc.diffQ(q0, q1, dt, this.qd); else this.qd.fill(0);
    this.adjust?.(q, now);
    sc.writeQ(q, this.qd);
    const w = this.play.world;
    w.time = t;
    w.sense(); // feet, touches and hits from the written pose (the meta overrides what the host knows better)
    applyMeta(this.play, t >= s1.time ? s1 : s0);
    // keep what the next frames can still need
    while (b.length > 2 && b[1].time <= t) b.shift();
    return true;
  }
}
