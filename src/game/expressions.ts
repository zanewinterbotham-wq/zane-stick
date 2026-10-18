// Moods for the athletes' eyebrows (render/brows.ts), read from the world after each step: angry as he closes on an
// opponent or charges, and for a moment after a hard hit; sad/hurt while injured or knocked out, and briefly after a
// hard hit that leaves him on the turf. Presentation only: reads the sim, never writes to it.
import type { World } from '../sim/world';
import { isBigHit } from './feel';
import type { Expression } from './render/brows';

/** Closing on an opponent: within this distance (m), at least this fast relative to him and himself (m/s). */
export const APPROACH = { dist: 5, closing: 2.5, speed: 3 };
/** How long the anger from a hard hit lasts (s); how long the hurt look lasts when it leaves him down; and how
 *  soon after the hit he must go down for that (s). */
export const HIT_ANGRY = 2.5, HIT_SAD = 2.5, HIT_DOWN_WITHIN = 4;
const WINDOW = 0.03, GAP = 0.25;

interface Track { angryUntil: number; sadUntil: number; hitAt: number; sadDone: boolean; down: boolean; win: number[]; lastContact: number; closing: number; fired: boolean }

export class ExpressionTracker {
  private tr: Track[] = [];

  /** Call after every World step; returns each athlete's mood target (the brows ease toward it). */
  step(w: World): Expression[] {
    const t = w.time, dt = w.dt, n = w.athletes.length, force = new Array<number>(n).fill(0), pair = new Array<number>(n).fill(-1);
    for (const h of w.hits) {
      if (h.a < 0 || h.b < 0 || h.a >= n || h.b >= n) continue;
      force[h.a] += h.force; force[h.b] += h.force; pair[h.a] = h.b; pair[h.b] = h.a;
    }
    return w.athletes.map((a, i) => {
      const down = a.downBy !== null;
      const tr = this.tr[i] ??= { angryUntil: -Infinity, sadUntil: -Infinity, hitAt: -Infinity, sadDone: true, down, win: [], lastContact: -Infinity, closing: 0, fired: false };

      // a hard hit received: the same impulse-and-closing-speed rule as the big-hit feedback (feel.ts), per athlete
      if (force[i] > 0 && t - tr.lastContact > GAP) { tr.win = []; tr.fired = false; tr.closing = pair[i] >= 0 ? closing(w, i, pair[i]) : 0; }
      if (force[i] > 0) tr.lastContact = t;
      tr.win.push(force[i] * dt);
      if (tr.win.length > Math.max(1, Math.round(WINDOW / dt))) tr.win.shift();
      if (!tr.fired && isBigHit(tr.win.reduce((x, y) => x + y, 0), tr.closing)) {
        tr.fired = true; tr.angryUntil = t + HIT_ANGRY; tr.hitAt = t; tr.sadDone = false;
      }
      // then down on the turf soon after: a hurt look
      if (down && !tr.down && !tr.sadDone && t - tr.hitAt < HIT_DOWN_WITHIN) { tr.sadUntil = t + HIT_SAD; tr.sadDone = true; }
      tr.down = down;

      if (a.injury.out) return { angry: 0, sad: 1 };
      if (t < tr.sadUntil) return { angry: 0, sad: 0.8 };
      let angry = t < tr.angryUntil || a.cmd.thrustHips || !!a.cmd.dive;
      for (let j = 0; j < n && !angry; j++) if (j !== i && w.athletes[j].setup.team !== a.setup.team && !down) angry = approaching(w, i, j);
      return { angry: angry ? 1 : 0, sad: 0 };
    });
  }
}

/** Centre-of-mass closing speed of two athletes along the line between them (m/s, positive when approaching). */
function closing(w: World, i: number, j: number) {
  const a = w.scene.athletes[i].state, b = w.scene.athletes[j].state;
  const d = [b.com[0] - a.com[0], b.com[1] - a.com[1], b.com[2] - a.com[2]], L = Math.hypot(...d) || 1;
  return Math.max(0, -((b.comVel[0] - a.comVel[0]) * d[0] + (b.comVel[1] - a.comVel[1]) * d[1] + (b.comVel[2] - a.comVel[2]) * d[2]) / L);
}

/** Athlete i is running at opponent j: close, closing fast, and himself moving toward him at speed. */
export function approaching(w: World, i: number, j: number): boolean {
  const a = w.scene.athletes[i].state, b = w.scene.athletes[j].state;
  const dx = b.com[0] - a.com[0], dz = b.com[2] - a.com[2], L = Math.hypot(dx, dz);
  if (L > APPROACH.dist || L < 1e-6) return false;
  const toward = (a.comVel[0] * dx + a.comVel[2] * dz) / L;
  return toward > APPROACH.speed && closing(w, i, j) > APPROACH.closing;
}
