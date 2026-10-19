// A bot waiting for the play to reach him (a gauntlet tackler before he wakes, a kicker before the kick) looks alive,
// through Commands only, as a waiting player does: square to the ball in a ready stance, shifting his weight, chopping
// his feet now and then, glancing round, and stepping back to his spot. With `zone` > 0 he plays the waiting instead:
// slides across the field with the ball and comes up to `zone` m toward it, still facing it (the high-end tier).
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type Commands } from '../control/types';
import { clamp, type Vec3 } from '../math';
import type { Rng } from '../rng';
import type { Brain, Perception } from './types';

/** Ready stance (sink, forward lean), weight shift amplitude (lean.side), and how far (m) he squares up with the ball
 *  across the field while idle. */
const SINK = 0.3, LEAN = 0.12, SWAY = 0.12, SQUARE = 0.6;
/** Back to the target at this gain (1/s), up to WALK m/s idle or RUN m/s in a zone; inside DEAD m he stands. */
const GAIN = 1.5, WALK = 0.9, RUN = 4, DEAD = 0.15;
/** A zone player keeps off the sideline by this much (m). */
const SIDELINE = 2;

export class IdleBrain implements Brain {
  private spot: [number, number] | null = null;
  private heading = 0;
  private swayT: number; private swayPh: number;
  private chopAt: number; private chopEnd = -Infinity;
  private glanceAt: number; private glanceEnd = -Infinity; private glance = 0;
  private shuffle = 0; private shuffleAt: number;
  constructor(private rng: Rng, private zone = 0) {
    this.swayT = rng.range(2.5, 4); this.swayPh = rng.range(0, 2 * Math.PI);
    this.chopAt = rng.range(1, 5); this.glanceAt = rng.range(1.5, 5); this.shuffleAt = rng.range(2, 6);
  }

  think(p: Perception): Commands {
    const c = neutralCommands(), me = p.athletes[p.self], t = p.time;
    if (!this.spot) { this.spot = [me.com[0], me.com[2]]; this.heading = me.heading; }
    if (me.down) return c;
    // the ball (its carrier, or the ball itself): none, or in my own hands, and I look the way I lined up
    const b: Vec3 | undefined = p.athletes.find((a) => a.hasBall)?.com ?? p.ball?.pos;
    const bx = b ? b[0] - me.com[0] : 0, bz = b ? b[2] - me.com[2] : 0, bd = Math.hypot(bx, bz);
    let h = bd > 0.5 && !me.hasBall ? Math.atan2(bx, bz) : this.heading;
    // now and then a look round (the whole body turns a little: the rig has no separate head command)
    if (t >= this.glanceAt) { this.glance = this.rng.range(0.35, 0.8) * (this.rng.next() < 0.5 ? -1 : 1); this.glanceEnd = t + this.rng.range(0.6, 1.2); this.glanceAt = t + this.rng.range(3, 7); }
    if (t < this.glanceEnd) h += this.glance;
    c.face = { x: Math.sin(h), z: Math.cos(h) };
    c.contactMode = true; c.sink = SINK; c.lean.fwd = LEAN;
    c.lean.side = SWAY * Math.sin(2 * Math.PI * t / this.swayT + this.swayPh);
    if (t >= this.chopAt) { this.chopEnd = t + this.rng.range(0.6, 1.4); this.chopAt = t + this.rng.range(3, 7); }
    c.chopFeet = t < this.chopEnd;
    // where to stand: my spot squared up with the ball across the field (plus a stray shuffle step), or my zone
    if (t >= this.shuffleAt) { this.shuffle = this.rng.range(-0.3, 0.3); this.shuffleAt = t + this.rng.range(3, 7); }
    const [sx, sz] = this.spot, ox = b ? b[0] - sx : 0, oz = b ? b[2] - sz : 0, half = p.field.halfWidth - SIDELINE;
    const tx = this.zone > 0 ? clamp(sx + ox, -half, half) : sx + clamp(ox * 0.1, -SQUARE, SQUARE) + this.shuffle;
    const tz = sz + (this.zone > 0 ? clamp(oz, -this.zone, this.zone) : 0);
    const gx = tx - me.com[0], gz = tz - me.com[2], g = Math.hypot(gx, gz);
    if (g > DEAD) {
      const v = Math.min(GAIN * (g - DEAD), this.zone > 0 ? RUN : WALK);
      c.gait = v > GAIT_SPEED.walk ? 'jog' : 'walk';
      const m = Math.min(1, v / GAIT_SPEED[c.gait]);
      c.move = { x: gx / g * m, z: gz / g * m };
    }
    return c;
  }
}
