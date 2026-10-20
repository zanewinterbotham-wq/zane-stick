// Bot blocker: protects his team's ball carrier, or, while nobody holds the ball (a kick in the air, a snap), the
// ball itself. He takes the most dangerous opponent that no teammate is better placed to block, runs to the spot on
// the line from that man to the carrier a body's depth in front of him, breaks down there (sinks, chops the feet,
// mirrors him), then strikes: hands on his chest, a fistful of jersey (holding is no foul here: no penalties), legs
// driving, steering him away from the carrier while staying between them. Reads the world through a reaction delay;
// difficulty is only that delay and aim noise. Same Commands as a human; whether the block holds is physics.
// While a kick is in the air he protects where it comes down: a man still far from there is met from a wall WALL m
// in front of the returner (a man already on him, a gunner he lines up over, is jammed at once).
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type Commands } from '../control/types';
import { clamp, type Vec3 } from '../math';
import type { Rng } from '../rng';
import type { BotDifficulty } from './carrier';
import { landing } from './football/sense';
import { fallTime } from './returner';
import { Steer } from './steer';
import { predict } from './tackler';
import type { AthleteView, Brain, Perception } from './types';

/** Speed of a threat the danger estimate assumes (m/s): his time to the carrier. A threat behind the carrier (along
 *  the carrier's run) is BEHIND s less urgent: he is chasing, not in the way. */
const THREAT_V = 8, BEHIND = 1.5;
/** Re-pick the man every PICK s; a new man must be SWITCH s more urgent; never leave a man I am locked on to. */
const PICK = 0.25, SWITCH = 0.3, LOCKED = 1.3;
/** The block point: GAP m in front of him toward the carrier, led by his velocity up to LEAD s. */
const GAP = 0.9, LEAD = 0.5;
/** Break down inside BREAK m of him (closing at BREAK_V m/s on top of his speed toward me), strike inside STRIKE. */
const BREAK = 3.5, BREAK_V = 2.5, STRIKE = 1.6;
/** Drive: how hard the push goes away from the carrier vs. straight into him, and the correction (1/s) that slides
 *  me back onto the line between them. */
const AWAY = 0.6, ONLINE = 2.5, DRIVE_V = 4;
/** Escort: with nobody to block, run this far ahead of the carrier, on his run. */
const ESCORT = 3;
/** Kick return wall: WALL m in front of the landing spot, toward my man, until he is within ENGAGE m of the spot or
 *  JAM m of me; the kick is played at CATCH_H m; the run stops on the wall spot at BRAKE m/s². */
const WALL = 12, ENGAGE = 25, JAM = 5, CATCH_H = 1.2, BRAKE = 4;
/** A way to go more than a right angle off the run is run at this share of its speed until the turn is made. */
const FULL = GAIT_SPEED.sprint, REVERSE = 0.2;

export type BlockPhase = 'escort' | 'wall' | 'approach' | 'breakdown' | 'drive';

export class BlockerBrain implements Brain {
  private history: Perception[] = [];
  private steer = new Steer();
  private aimErr = 0; private aimUntil = 0;
  /** The man I block (athlete index, −1: none) and when to look again. */
  target = -1;
  private pickAt = 0;
  phase: BlockPhase = 'escort';
  constructor(private rng: Rng, private diff: BotDifficulty) {}

  think(p: Perception, dt = 1 / 240): Commands {
    const c = neutralCommands();
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    const seen = this.history[0], age = p.time - seen.time, me = p.athletes[p.self];
    if (me.down || me.hasBall) return c;
    const ci = seen.athletes.findIndex((a) => a.hasBall && a.team === me.team);
    const carrier = ci >= 0 ? predict(seen.athletes[ci], age) : null;
    const b = seen.ball, fall = !carrier && b ? fallTime(b.pos, b.vel, CATCH_H) : -1;
    const prot: Vec3 | null = carrier ? carrier.com : fall >= 0 ? landing(b!, CATCH_H) : b ? b.pos : null;
    if (!prot) return c;
    // the carrier's run (unit, ground); none before anyone has the ball
    const cv = carrier ? Math.hypot(carrier.comVel[0], carrier.comVel[2]) : 0;
    const run: [number, number] = carrier && cv > 1 ? [carrier.comVel[0] / cv, carrier.comVel[2] / cv] : carrier ? [0, p.field.dirZ] : [0, 0];
    if (p.time >= this.pickAt || this.target < 0 || seen.athletes[this.target]?.down) { this.pick(seen, p.self, me, prot, run); this.pickAt = p.time + PICK; }
    if (p.time >= this.aimUntil) { this.aimErr = this.rng.gauss() * this.diff.noise * 0.5; this.aimUntil = p.time + 0.5; }
    if (this.target < 0) return this.escort(me, carrier, run, dt, c);
    const t = predict(seen.athletes[this.target], age);
    if (fall >= 0 && Math.hypot(t.com[0] - prot[0], t.com[2] - prot[2]) > ENGAGE && Math.hypot(t.com[0] - me.com[0], t.com[2] - me.com[2]) > JAM) return this.wall(me, t, prot, dt, c);
    this.block(me, t, prot, dt, c);
    return c;
  }

  /** Time (s) a threat needs to reach the protected point, plus BEHIND if he is behind the carrier's run. */
  private danger(t: AthleteView, prot: Vec3, run: [number, number]) {
    const dx = prot[0] - t.com[0], dz = prot[2] - t.com[2];
    return Math.hypot(dx, dz) / THREAT_V + ((t.com[0] - prot[0]) * run[0] + (t.com[2] - prot[2]) * run[1] < -1 ? BEHIND : 0);
  }

  /** Threats from most to least urgent; each goes to the nearest free blocker (the same rule on every teammate's
   *  view, so they share the men out). Left over, I double the most urgent one. Hysteresis keeps my man. */
  private pick(seen: Perception, self: number, me: AthleteView, prot: Vec3, run: [number, number]) {
    const threats = seen.athletes.map((a, i) => ({ a, i })).filter(({ a }) => a.team !== me.team && !a.down && !a.hasBall)
      .map((x) => ({ ...x, d: this.danger(x.a, prot, run) })).sort((a, b) => a.d - b.d);
    if (!threats.length) { this.target = -1; return; }
    const cur = threats.find((x) => x.i === this.target);
    if (cur && Math.hypot(cur.a.com[0] - me.com[0], cur.a.com[2] - me.com[2]) < LOCKED) return;
    const free = new Set(seen.athletes.map((a, i) => ({ a, i })).filter(({ a }) => a.team === me.team && !a.hasBall && !a.down).map(({ i }) => i));
    free.add(self);
    let mine = threats[0];
    for (const th of threats) {
      let best = -1, bd = Infinity;
      for (const k of free) { const a = k === self ? me : seen.athletes[k], d = Math.hypot(a.com[0] - th.a.com[0], a.com[2] - th.a.com[2]); if (d < bd) { bd = d; best = k; } }
      free.delete(best);
      if (best === self) { mine = th; break; }
      if (!free.size) break;
    }
    if (cur && cur.i !== mine.i && cur.d < mine.d + SWITCH) return;
    this.target = mine.i;
  }

  private block(me: AthleteView, t: AthleteView, prot: Vec3, dt: number, c: Commands) {
    const dx = t.com[0] - me.com[0], dz = t.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    // the line from him to what I protect, and where on it I want to be
    const lx = prot[0] - t.com[0], lz = prot[2] - t.com[2], ln = Math.hypot(lx, lz) || 1e-6, ux = lx / ln, uz = lz / ln;
    const lead = Math.min(LEAD, d / FULL), gap = Math.min(GAP, ln * 0.5);
    // aim error across the line, fading in close
    const k = Math.min(1, d / 4), ex = -uz * this.aimErr * k, ez = ux * this.aimErr * k;
    const bx = t.com[0] + t.comVel[0] * lead + ux * gap + ex - me.com[0], bz = t.com[2] + t.comVel[2] * lead + uz * gap + ez - me.com[2];
    const bd = Math.hypot(bx, bz) || 1e-6;
    c.gait = 'sprint';
    c.contactMode = d < 4;
    c.face = { x: dx / d, z: dz / d };
    this.phase = d < STRIKE ? 'drive' : d < BREAK ? 'breakdown' : 'approach';
    if (this.phase === 'approach') {
      // flat out to the block point, easing in so the breakdown starts under control
      const v = Math.min(FULL, 2 + 1.5 * bd);
      this.run(me, bx / bd * v, bz / bd * v, dt, c);
      if (bd > 6) c.face = null;
      return;
    }
    // how far off the line between him and the carrier I am (+: to the line's left)
    const off = (me.com[0] - t.com[0]) * uz - (me.com[2] - t.com[2]) * ux;
    const sx = -off * uz * ONLINE, sz = off * ux * ONLINE;
    if (this.phase === 'breakdown') {
      // mirror him: match his velocity, close at BREAK_V, slide onto the line
      const vx = t.comVel[0] + dx / d * BREAK_V + sx, vz = t.comVel[2] + dz / d * BREAK_V + sz;
      this.run(me, vx, vz, dt, c, true);
      c.chopFeet = true; c.sink = 0.4; c.lean.fwd = 0.2;
      c.armL = c.armR = 0.6; c.aim = [t.pelvis[0], t.pelvis[1] + 0.45, t.pelvis[2]];
      return;
    }
    // drive: into his chest and away from the carrier, staying on the line
    const px = dx / d * (1 - AWAY) - ux * AWAY, pz = dz / d * (1 - AWAY) - uz * AWAY, pn = Math.hypot(px, pz) || 1e-6;
    this.run(me, px / pn * DRIVE_V + sx, pz / pn * DRIVE_V + sz, dt, c, true);
    c.sink = 0.35; c.lean.fwd = 0.35; c.driveLegs = 1;
    c.armL = c.armR = 1; c.gripL = c.gripR = true;
    c.aim = [t.pelvis[0], t.pelvis[1] + 0.45, t.pelvis[2]];
  }

  /** A kick in the air and my man still far off: set up WALL m in front of where it comes down, toward him, and
   *  wait for him there squared up. */
  private wall(me: AthleteView, t: AthleteView, prot: Vec3, dt: number, c: Commands) {
    this.phase = 'wall';
    const lx = t.com[0] - prot[0], lz = t.com[2] - prot[2], ln = Math.hypot(lx, lz) || 1e-6;
    const gx = prot[0] + lx / ln * WALL - me.com[0], gz = prot[2] + lz / ln * WALL - me.com[2], g = Math.hypot(gx, gz) || 1e-6;
    const v = g < 0.3 ? 0 : clamp(Math.sqrt(2 * BRAKE * g), 0, FULL);
    this.run(me, gx / g * v, gz / g * v, dt, c, g < 3);
    c.gait = v > 6 ? 'sprint' : 'jog';
    const dx = t.com[0] - me.com[0], dz = t.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    if (g < 4) c.face = { x: dx / d, z: dz / d };
    return c;
  }

  /** Nobody to block: lead the carrier's run a few metres ahead of him (or wait by the ball). */
  private escort(me: AthleteView, carrier: AthleteView | null, run: [number, number], dt: number, c: Commands) {
    this.phase = 'escort';
    if (!carrier) return c;
    const gx = carrier.com[0] + run[0] * ESCORT - me.com[0], gz = carrier.com[2] + run[1] * ESCORT - me.com[2], g = Math.hypot(gx, gz) || 1e-6;
    const v = clamp(1.5 * g, 0, FULL);
    this.run(me, gx / g * v, gz / g * v, dt, c);
    c.gait = v > 6 ? 'sprint' : 'jog';
    return c;
  }

  /** Move toward a ground velocity (m/s, world): the heading turns no faster than footing allows at this speed (in
   *  close, contact steps go any way at once), and the magnitude is filtered so the command does not chatter. */
  private run(me: AthleteView, vx: number, vz: number, dt: number, c: Commands, close = false) {
    this.steer.run(me, vx, vz, dt, c, close ? 8 : undefined, false, close ? 1 : REVERSE);
  }
}
