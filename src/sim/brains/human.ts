// Human brain: turns the latest input snapshot into Commands. Lives in the sim so humans and bots share
// one interface; the browser shell writes `latest` once per render frame (no DOM access here).
import { neutralCommands, type Commands, type PassCmd } from '../control/types';
import { clamp } from '../math';
import { catchPoint, dropPoint, incoming, OVERHEAD } from './returner';
import { wrapArms } from './tackler';
import { leadShoulder, type AthleteView, type Brain, type Perception } from './types';

/** Device-independent input snapshot (what the shell's InputFrame boils down to). */
export interface HumanInput {
  move: { x: number; y: number };   // x right, y forward, relative to the camera's heading
  torso: number;                    // torso angle −1 (up) .. 1 (down); lowering the pads also sinks the hips
  sprint: number; armL: number; armR: number;
  held: ReadonlySet<string>;
  cameraYaw: number;                // heading the camera looks along (rad, 0 = +Z)
  aimPitch: number;                 // elevation of the camera's aim above the horizontal (rad)
  /** Side shuffle (Roblox-style shift lock): face the camera's way, so A / D shuffle and S backpedals. */
  shiftLock?: boolean;
  /** A throw (docs/passing.md): the shell sets it on the frame its throw scheme fires; the brain passes each one on once. */
  pass?: PassCmd | null;
}

/** Contact mode switches on when a tackle target is this close and roughly ahead, and off past the wider
 *  limits, so it does not flicker at the edge (m; cosine of the bearing off the body's heading). */
const CONTACT_ON = 4, CONTACT_OFF = 5, AHEAD_ON = 0.3, AHEAD_OFF = -0.2;
/** Approach posture in contact mode: a little hip sink. */
const READY_SINK = 0.25;
/** One control gets low: hip sink per unit of torso down (a full lowering of the pads is a 0.6 sink). */
const TORSO_SINK = 0.6;
/** Arms reach toward a point this far along the camera's aim, from chest height (m). */
const AIM_DIST = 1.5, CHEST_BELOW_HEAD = 0.3;
/** Steer assist: farthest target it turns toward (m), and the cosine of the widest angle between the stick and the
 *  target it acts within (~60°). */
const STEER = { range: 10, cone: 0.5 };
/** A loose ball this close (m, along the ground) and no higher than this (m) draws both arms to it and a stoop. */
const LOOSE_REACH = 2, LOOSE_HIGH = 1;

export class HumanBrain implements Brain {
  latest: HumanInput | null = null;
  /** Steer assist 0..1 (a player setting): how far the move direction turns toward the ball carrier or a loose ball. */
  steerAssist = 0.3;
  /** Automatic contact mode (read by the HUD). */
  contact = false;
  /** The nearest opponent who can be tackled (last think). */
  private nearest: AthleteView | undefined;
  /** The last pass handed on: the shell's input stays `latest` over several steps, the throw is one. */
  private passed: PassCmd | null = null;

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
    if (m > 0.1) [mx, mz] = this.steer(p, mx, mz);
    c.move = { x: mx, z: mz };
    if (i.shiftLock) c.face = { x: fwd[0], z: fwd[1] };
    c.contactMode = this.contact;
    c.gait = i.sprint > 0.5 ? 'sprint' : m > 0.6 ? 'jog' : 'walk';
    if (c.gait === 'walk' && m > 0) c.move = { x: mx / (m || 1), z: mz / (m || 1) }; // walk at walking speed
    // one press runs a whole thrust; the torso input keeps the pads' angle it fires out along
    c.thrustHips = h.has('thrust');
    c.shoulder = this.contact ? leadShoulder(p.athletes[p.self], this.nearest) : 0;
    c.dive = h.has('dive'); // one press runs a whole dive; holding changes nothing
    c.diveFacing = !!i.shiftLock; // shuffling, he dives the way he moves, still facing forward
    c.jump = h.has('jump'); // the same for a jump
    const sink = TORSO_SINK * Math.max(0, i.torso);
    c.sink = this.contact ? Math.max(sink, READY_SINK) : sink;
    c.lean = { fwd: i.torso, side: 0 };
    // Gang Beasts arms: holding a button raises that arm toward the aim and grabs whatever the hand touches
    c.armL = i.armL; c.armR = i.armR;
    c.gripL = i.armL > 0.5; c.gripR = i.armR > 0.5;
    if (c.armL > 0 || c.armR > 0) {
      const me = p.athletes[p.self], ce = Math.cos(i.aimPitch);
      c.aim = [me.head[0] + fwd[0] * ce * AIM_DIST, me.head[1] - CHEST_BELOW_HEAD + Math.sin(i.aimPitch) * AIM_DIST, me.head[2] + fwd[1] * ce * AIM_DIST];
    }
    const t = this.nearest;
    const me0 = p.athletes[p.self], dx = t ? t.com[0] - me0.com[0] : 0, dz = t ? t.com[2] - me0.com[2] : 0, d = Math.hypot(dx, dz) || 1e-6;
    // both arm buttons: always the bear hug, arms out wide at the camera aim, or round the man ahead (squared up to him);
    // the world closes the hands when my trunk meets his (before that they would catch on his front)
    if (i.armL > 0.5 && i.armR > 0.5) {
      if (t && this.contact) { wrapArms(c, t, 0); c.face = { x: dx / d, z: dz / d }; }
      c.wrap = c.hug = true; c.gripL = c.gripR = false;
    }
    if (this.contact) {
      c.driveLegs = i.sprint;
      if (c.driveLegs > 0.5) c.gait = 'sprint';
    }
    if (i.pass && i.pass !== this.passed) { c.pass = i.pass; this.passed = i.pass; }
    this.reachLoose(p, c);
    // a ball coming down on him (a kick, a pop-up) or flying at him: the raised hands go to where it will be, both
    // to one point when both buttons are held (the diamond: the hands meet behind the ball)
    const me = p.athletes[p.self], chest = [me.head[0], me.head[1] - CHEST_BELOW_HEAD, me.head[2]];
    if ((c.armL > 0 || c.armR > 0) && p.ball && !p.athletes.some((a) => a.hasBall)) {
      const drop = p.ball.pos[1] > me.head[1] ? dropPoint(p.ball, chest, me.head[1] + OVERHEAD) : null;
      const at = drop ?? (incoming(p.ball, chest) ? catchPoint(p.ball, chest) : null);
      // a ball to catch beats the hug: the hands go to it (both: the diamond) and hold on
      if (at) { c.aim = at; c.wrap = c.hug = false; c.gripL = c.armL > 0.5; c.gripR = c.armR > 0.5; }
    }
    return c;
  }

  /** Steer assist (owner decision 2026-10-18): the move direction turns part way (steerAssist of the way, fading out
   *  toward the edges of the range and the cone) toward the ball carrier, or a loose ball, when it is near and
   *  roughly where the player is heading. It changes only the brain's intent; the body still has to run there. */
  private steer(p: Perception, mx: number, mz: number): [number, number] {
    const me = p.athletes[p.self], k = this.steerAssist;
    if (k <= 0 || me.hasBall) return [mx, mz];
    const carrier = p.athletes.find((a) => a.hasBall && a.team !== me.team);
    const t = carrier ? carrier.com : !p.athletes.some((a) => a.hasBall) ? p.ball?.pos : undefined;
    if (!t) return [mx, mz];
    const dx = t[0] - me.com[0], dz = t[2] - me.com[2], d = Math.hypot(dx, dz), m = Math.hypot(mx, mz);
    if (d < 1e-3) return [mx, mz];
    const cos = (dx * mx + dz * mz) / (d * m);
    const w = k * clamp((STEER.range - d) / 2, 0, 1) * clamp((cos - STEER.cone) / 0.3, 0, 1);
    if (w <= 0) return [mx, mz];
    const sx = mx / m + (dx / d - mx / m) * w, sz = mz / m + (dz / d - mz / m) * w, s = Math.hypot(sx, sz) || 1;
    return [sx / s * m, sz / s * m];
  }

  /** A loose ball within reach: the hands go for it and the body stoops, so walking over it picks it up. */
  private reachLoose(p: Perception, c: Commands) {
    const me = p.athletes[p.self], b = p.ball;
    if (!b || p.athletes.some((a) => a.hasBall) || b.pos[1] > LOOSE_HIGH) return;
    const d = Math.hypot(b.pos[0] - me.com[0], b.pos[2] - me.com[2]);
    if (d > LOOSE_REACH) return;
    const k = Math.min(1, (LOOSE_REACH - d) / 0.6);
    c.armL = c.armR = 1; c.gripL = c.gripR = true; c.wrap = c.hug = false; c.aim = [b.pos[0], b.pos[1], b.pos[2]];
    c.sink = Math.max(c.sink, 0.5 * k); c.lean.fwd = Math.max(c.lean.fwd, k);
  }

  /** Whether an athlete who can be tackled is near and roughly ahead (with hysteresis). */
  private nearTarget(p: Perception): boolean {
    const me = p.athletes[p.self];
    const hx = Math.sin(me.heading), hz = Math.cos(me.heading);
    let best = Infinity, bestCos = -1;
    this.nearest = undefined;
    p.athletes.forEach((a) => {
      if (a.team === me.team || a.down) return;
      const dx = a.com[0] - me.com[0], dz = a.com[2] - me.com[2], d = Math.hypot(dx, dz);
      if (d < best) { best = d; bestCos = d > 1e-6 ? (dx * hx + dz * hz) / d : 1; this.nearest = a; }
    });
    return this.contact ? best < CONTACT_OFF && bestCos > AHEAD_OFF : best < CONTACT_ON && bestCos > AHEAD_ON;
  }
}
