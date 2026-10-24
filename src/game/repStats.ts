// End-of-rep stats for the result card: top speed, and yards after contact. Reads the World each frame (presentation
// only, never written back); the hardest hit in kN comes from HitMeter (feel.ts).
import type { World } from '../sim/world';

export const YD = 0.9144;
/** The mean force (kN) a collision's impulse over HitMeter's 30 ms window implies. */
export const impulseKN = (impulse: number) => impulse / 30;

export class RepStats {
  /** Fastest ground speed of the followed athlete this rep (m/s). */
  topSpeed = 0;
  private world: World | null = null;
  private carrier = -1;
  private sx = 0; private sz = 0; private dx = 0; private dz = 0;
  /** Metres gained by carriers who handed over (fumbles, passes) before the current one. */
  private banked = 0;
  private cur = 0;

  /** Metres the ball carrier gained along his line of running since the first contact (0 before it). */
  get yardsAfterContactM() { return this.banked + this.cur; }
  get yardsAfterContact() { return this.yardsAfterContactM / YD; }

  /** Call once a frame while the rep is live. `focus`: the athlete whose top speed counts (the player's). */
  step(w: World, focus: number) {
    if (w !== this.world) { this.world = w; this.topSpeed = 0; this.carrier = -1; this.banked = this.cur = 0; }
    const f = w.scene.athletes[focus]?.state;
    if (f) this.topSpeed = Math.max(this.topSpeed, Math.hypot(f.comVel[0], f.comVel[2]));
    const bc = w.ballCarrier;
    if (w.impact.firstContactTime < 0 || bc < 0) return;
    const s = w.scene.athletes[bc].state;
    if (bc !== this.carrier) { // first contact, or the ball changed hands: measure from here, along where he is running
      this.banked += this.cur; this.cur = 0; this.carrier = bc;
      const v = Math.hypot(s.comVel[0], s.comVel[2]) || 1;
      this.sx = s.com[0]; this.sz = s.com[2]; this.dx = s.comVel[0] / v; this.dz = s.comVel[2] / v;
    }
    this.cur = Math.max(0, (s.com[0] - this.sx) * this.dx + (s.com[2] - this.sz) * this.dz);
  }
}
