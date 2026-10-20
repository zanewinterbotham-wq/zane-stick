// Hit feedback from World.hits. Presentation only: none of this feeds back into the simulation (hit-stop
// pauses wall time; the sim still runs the same fixed steps).
import type { Vec3 } from '../sim/math';
import type { HitEvent, World } from '../sim/world';

export const MPH = 2.236936;             // (m/s) → mph
/** Big hit: contact impulse over the last 30 ms and centre-of-mass closing speed at first touch. Per-step
 *  force is useless here: stiff contacts spike 12-53 kN on any solid touch. */
export const BIG_HIT_J = 300;            // N·s in 30 ms
export const BIG_HIT_V = 8.5;            // m/s; with BIG_HIT_J: 7 of 21 open-field tackles by a pursuit bot (closing 6-12.5 m/s, 60-800 N·s)
const WINDOW = 0.03;                     // s
const NEW_COLLISION_GAP = 0.25;          // s without contact before the next touch counts as a new hit
const PAIR_GAP = 0.2;                    // s a segment pair must be apart before it sounds again

export type HitKind = 'helmet' | 'helmetPads' | 'pads' | 'body' | 'grab';
const ARM = /^(upperArm|forearm|hand)/;

/** Which surfaces met: the helmet is on the head, the shoulder pads on the thorax. A slow hand is a grab. */
export function hitKind(segA: string, segB: string, speed: number): HitKind {
  const hand = (s: string) => s.startsWith('hand');
  if ((hand(segA) || hand(segB)) && speed < 3) return 'grab';
  const head = +(segA === 'head') + +(segB === 'head');
  if (head === 2) return 'helmet';
  if (head === 1) return 'helmetPads';
  return segA === 'thorax' && segB === 'thorax' ? 'pads' : 'body';
}

/** Sound loudness 0..1: mostly closing speed (robust), a little contact force on a log scale. */
export function hitLoudness(speed: number, force: number): number {
  const kV = Math.max(0, speed) / 10, kF = Math.log10(Math.max(1, force) / 300) / 2;
  return Math.min(1, Math.max(0, 0.8 * kV + 0.2 * kF));
}

/** limb: an arm segment (upper arm, forearm, hand) was one of the two; pos: contact point (world). */
export interface HitSound { kind: HitKind; loud: number; speed: number; force: number; pair: string; limb: boolean; pos: Vec3 }
export interface BigHit { closing: number; impulse: number; a: number; b: number } // m/s, N·s over 30 ms; the athletes

export interface HitFeel {
  k: number;          // 0..1 intensity
  shake: number;      // camera shake, m
  punch: number;      // camera lurch toward the hit, m
  rumble: { duration: number; strong: number; weak: number };
  stopMs: number;     // hit-stop length (wall time), 0 = none
  slowMo: boolean;
}

export const isBigHit = (J: number, closing: number) => J >= BIG_HIT_J && closing >= BIG_HIT_V;

/** J: contact impulse over 30 ms (N·s); closing: approach speed at contact (m/s). */
export function hitFeel(J: number, closing: number): HitFeel {
  const kJ = Math.min(1, J / 600), kV = Math.min(1, Math.max(0, closing) / 12);
  // a hard push at walking pace should feel heavy, a full-speed collision of the same impulse bigger
  const k = Math.min(1, kJ * (0.6 + 0.6 * kV));
  const big = isBigHit(J, closing);
  return {
    k, shake: big ? 0.08 + 0.3 * k * k : 0.02 * k, punch: big ? 0.4 * k : 0,
    rumble: { duration: 60 + 160 * k, strong: k, weak: Math.min(1, k * 1.4) },
    stopMs: big ? Math.round(40 + 40 * k) : 0, slowMo: big,
  };
}

/** Follows athlete-on-athlete contact step by step: one sound per segment pair as it meets, and one
 *  big-hit verdict per collision. */
export class HitMeter {
  private t = 0;
  private lastContact = -Infinity;
  private win: number[] = [];
  private pairSeen = new Map<string, number>();
  private fired = false;
  /** The collision in progress: COM closing speed at first touch of its strongest pair (a, b) and peak impulse over
   *  30 ms so far. */
  cur: BigHit = { closing: 0, impulse: 0, a: 0, b: 1 };
  /** Hardest collision this rep (by impulse) and the first big hit, if any. */
  best: BigHit | null = null;
  big: BigHit | null = null;

  /** Call after every World step (a multiplayer guest: every render frame, with its length `dt`). `bigNow` is set on
   *  the step a collision first qualifies as big. */
  step(w: World, dt = w.dt): { sounds: HitSound[]; bigNow: BigHit | null } {
    this.t += dt;
    const sounds: HitSound[] = [];
    let total = 0;
    for (const h of w.hits) {
      total += h.force;
      const pair = pairKey(h);
      if (this.t - (this.pairSeen.get(pair) ?? -Infinity) > PAIR_GAP) {
        sounds.push({ kind: hitKind(h.segA, h.segB, h.speed), loud: hitLoudness(h.speed, h.force), speed: h.speed, force: h.force, pair, limb: ARM.test(h.segA) || ARM.test(h.segB), pos: h.pos });
      }
      this.pairSeen.set(pair, this.t);
    }
    // a pile of segments meeting at once is heard as its two loudest contacts
    sounds.sort((x, y) => y.loud - x.loud).splice(2);
    if (total > 0 && this.t - this.lastContact > NEW_COLLISION_GAP) {
      this.win = []; this.fired = false;
      let h: HitEvent | null = null;
      for (const x of w.hits) if (x.a >= 0 && x.b >= 0 && (!h || x.force > h.force)) h = x;
      this.cur = h ? { closing: comClosing(w, h.a, h.b), impulse: 0, a: h.a, b: h.b } : { closing: 0, impulse: 0, a: 0, b: 1 };
    }
    if (total > 0) this.lastContact = this.t;
    this.win.push(total * dt);
    if (this.win.length > Math.max(1, Math.round(WINDOW / dt))) this.win.shift();
    const J = this.win.reduce((s, x) => s + x, 0);
    let bigNow: BigHit | null = null;
    if (J > this.cur.impulse) {
      this.cur.impulse = J;
      if (!this.best || J > this.best.impulse) this.best = this.cur;
      if (!this.fired && isBigHit(J, this.cur.closing)) {
        this.fired = true;
        bigNow = this.cur;
        this.big ??= this.cur;
      }
    }
    return { sounds, bigNow };
  }
}

function pairKey(h: HitEvent) {
  const x = `${h.a}:${h.segA}`, y = `${h.b}:${h.segB}`;
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/** Centre-of-mass closing speed of athletes i and j along the line between them (m/s, positive when approaching). */
export function comClosing(w: World, i: number, j: number) {
  const a = w.scene.athletes[i].state, b = w.scene.athletes[j].state;
  const d = [b.com[0] - a.com[0], b.com[1] - a.com[1], b.com[2] - a.com[2]], L = Math.hypot(...d) || 1;
  return Math.max(0, -((b.comVel[0] - a.comVel[0]) * d[0] + (b.comVel[1] - a.comVel[1]) * d[1] + (b.comVel[2] - a.comVel[2]) * d[2]) / L);
}
