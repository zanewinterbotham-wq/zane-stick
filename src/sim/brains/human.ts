// Human brain: turns the latest input snapshot into Commands. Lives in the sim so humans and bots share
// one interface; the browser shell writes `latest` once per render frame (no DOM access here).
import { neutralCommands, type Commands } from '../control/types';
import type { Brain, Perception } from './types';

/** Device-independent input snapshot (what the shell's InputFrame boils down to). */
export interface HumanInput {
  move: { x: number; y: number };   // x right, y forward, relative to the camera's heading
  torso: number;                    // torso angle −1 (up) .. 1 (down)
  sprint: number; sink: number; armL: number; armR: number;
  held: ReadonlySet<string>;
  cameraYaw: number;                // heading the camera looks along (rad, 0 = +Z)
  aimPitch: number;                 // elevation of the camera's aim above the horizontal (rad)
}

/** Contact mode switches on when a tackle target is this close and roughly ahead, and off past the wider
 *  limits, so it does not flicker at the edge (m; cosine of the bearing off the body's heading). */
const CONTACT_ON = 4, CONTACT_OFF = 5, AHEAD_ON = 0.3, AHEAD_OFF = -0.2;
/** Approach posture in contact mode: a little hip sink. */
const READY_SINK = 0.25;
/** Arms reach toward a point this far along the camera's aim, from chest height (m). */
const AIM_DIST = 1.5, CHEST_BELOW_HEAD = 0.3;

export class HumanBrain implements Brain {
  latest: HumanInput | null = null;
  /** Automatic contact mode (read by the HUD). */
  contact = false;

  think(p: Perception): Commands {
    const c = neutralCommands();
    const i = this.latest;
    this.contact = this.nearTarget(p);
    if (!i) return c;
    const h = i.held;
    // camera-relative movement: stick up = the direction the camera looks
    const fwd = [Math.sin(i.cameraYaw), Math.cos(i.cameraYaw)], right = [-Math.cos(i.cameraYaw), Math.sin(i.cameraYaw)];
    let mx = fwd[0] * i.move.y + right[0] * i.move.x, mz = fwd[1] * i.move.y + right[1] * i.move.x;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    c.move = { x: mx, z: mz };
    c.contactMode = this.contact;
    c.gait = i.sprint > 0.5 ? 'sprint' : m > 0.6 ? 'jog' : 'walk';
    if (c.gait === 'walk' && m > 0) c.move = { x: mx / (m || 1), z: mz / (m || 1) }; // walk at walking speed
    // thrust takes priority: it straightens the hips, so sink and torso lean give way while it is held
    c.thrustHips = h.has('thrust');
    c.dive = h.has('dive'); // one press runs a whole dive; holding changes nothing
    c.sink = c.thrustHips ? 0 : this.contact ? Math.max(i.sink, READY_SINK) : i.sink;
    c.lean = { fwd: c.thrustHips ? 0 : i.torso, side: 0 };
    // Gang Beasts arms: holding a button raises that arm toward the aim and grabs whatever the hand touches
    c.armL = i.armL; c.armR = i.armR;
    c.gripL = i.armL > 0.5; c.gripR = i.armR > 0.5;
    if (c.armL > 0 || c.armR > 0) {
      const me = p.athletes[p.self], ce = Math.cos(i.aimPitch);
      c.aim = [me.head[0] + fwd[0] * ce * AIM_DIST, me.head[1] - CHEST_BELOW_HEAD + Math.sin(i.aimPitch) * AIM_DIST, me.head[2] + fwd[1] * ce * AIM_DIST];
    }
    if (this.contact) {
      c.driveLegs = i.sprint;
      if (c.driveLegs > 0.5) c.gait = 'sprint';
    }
    return c;
  }

  /** Whether an athlete who can be tackled is near and roughly ahead (with hysteresis). */
  private nearTarget(p: Perception): boolean {
    const me = p.athletes[p.self];
    const hx = Math.sin(me.heading), hz = Math.cos(me.heading);
    let best = Infinity, bestCos = -1;
    // shortcut: Perception has no team yet, so every other standing athlete counts as an opponent; add a team
    // to AthleteView when a drill has teammates.
    p.athletes.forEach((a, j) => {
      if (j === p.self || a.down) return;
      const dx = a.com[0] - me.com[0], dz = a.com[2] - me.com[2], d = Math.hypot(dx, dz);
      if (d < best) { best = d; bestCos = d > 1e-6 ? (dx * hx + dz * hz) / d : 1; }
    });
    return this.contact ? best < CONTACT_OFF && bestCos > AHEAD_OFF : best < CONTACT_ON && bestCos > AHEAD_ON;
  }
}
