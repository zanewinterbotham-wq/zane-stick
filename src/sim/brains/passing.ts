// Bots of the QB 1-on-1 mode (docs/passing.md): a quarterback who reads his receiver's separation and throws him
// open with a lead, a receiver who runs his route (a stem, then a plant-and-cut break) and plays the ball in the air,
// and a cornerback in man coverage (pressed: a jam at the line, then trailing on the inside hip; off: a cushion kept
// with a backpedal, turning to run when it is eaten) who plays the ball in the air with his hands. A catch is the
// play's catch rule, the same for everyone; after it the usual roles take over (the carrier runs, the CB tackles).
// They read the world through a reaction delay; difficulty is only that delay and how precise their reads and aim
// are. Same Commands as a human.
import { GAIT_SPEED } from '../control/hand';
import { neutralCommands, type Commands } from '../control/types';
import { clamp, wrapAngle, type Vec3 } from '../math';
import { YD } from '../modes/rules';
import type { Rng } from '../rng';
import { leadPoint, THROW, throwVelocity } from '../throw';
import type { BotDifficulty } from './carrier';
import { catchPoint, fallTime, incoming } from './returner';
import { predict, TacklerBrain, turnRate } from './tackler';
import type { AthleteView, Brain, Perception } from './types';

export type Route = 'go' | 'slant' | 'out' | 'in' | 'curl' | 'post' | 'corner';
/** Route trees (yd; x toward the middle of the field, depth downfield from the receiver's start): the stem to the
 *  break, then where the break heads (the last point is a direction: he runs on along it, or with `settle` stops there
 *  facing the quarterback). Standard depths of the NFL route tree (coaching convention, rounded). */
export const ROUTES: Record<Route, { pts: [number, number][]; settle?: boolean }> = {
  go: { pts: [[0, 60]] },
  slant: { pts: [[0, 1.5], [12, 13.5]] },
  out: { pts: [[0, 10], [-20, 10]] },
  in: { pts: [[0, 10], [25, 10]] },
  curl: { pts: [[0, 12], [1, 10]], settle: true },
  post: { pts: [[0, 12], [15, 35]] },
  corner: { pts: [[0, 12], [-15, 35]] },
};
export const ROUTE_NAMES = Object.keys(ROUTES) as Route[];

const FULL = GAIT_SPEED.sprint;
/** Ball played at chest height (m); hands up when it is this soon (s) or this near (m); a waypoint is reached within
 *  TURN m; a receiver keeps this far (m) inside the sideline. */
const CATCH_H = 1.35, HANDS_T = 0.5, HANDS_D = 3, TURN = 1.2, SIDELINE = 1.5;
/** A receiver cuts a 90° break at BREAK_V m/s (a sharper one too), slowing into it at BRAKE m/s² (assumption: two or
 *  three throttling steps from a sprint; a 90° cut at full speed is beyond what the turf lets a foot push). */
const BREAK_V = 4.5, BRAKE = 5;
/** The hands take the ball this far in front of the chest (the way he runs) and its line passes this far beside his
 *  (m: the arms reaching out for it, the ball over the shoulder: under its line a falling ball strikes the helmet). */
const IN_FRONT = 0.55, OVER_SHOULDER = 0.35;
/** Running to a ball in the air, up to this much faster (m/s) than the flight needs while 5 m or more from the spot. */
const EARLY = 1.5;
/** A seen acceleration is filtered over this long (s). */
const ACC_TAU = 0.15;
/** Plant and cut (as the carrier and tackler do) when the wanted way is PLANT_ANGLE rad off a run faster than
 *  PLANT_RUN m/s; the command is held PLANT_HOLD s, the next waits PLANT_GAP s. */
const PLANT_ANGLE = 0.5, PLANT_RUN = 2.5, PLANT_HOLD = 0.12, PLANT_GAP = 0.6, MOVE_TAU = 0.08;

/** Runs toward a ground velocity: the heading turns no faster than footing allows, a big change at speed is a plant
 *  and cut (the animator's cut). */
class Runner {
  heading = NaN; private mag = 0; private plantUntil = 0; private plantFree = 0; private side: -1 | 1 = 1;
  go(p: Perception, me: AthleteView, vx: number, vz: number, dt: number, c: Commands) {
    const n = Math.hypot(vx, vz), sp = Math.hypot(me.comVel[0], me.comVel[2]);
    if (Number.isNaN(this.heading)) this.heading = sp > 1 ? Math.atan2(me.comVel[0], me.comVel[2]) : me.heading;
    if (n > 1e-3) {
      const d = wrapAngle(Math.atan2(vx, vz) - this.heading);
      if (Math.abs(d) > PLANT_ANGLE && sp > PLANT_RUN && p.time >= this.plantFree) {
        this.heading = wrapAngle(this.heading + d); this.side = d > 0 ? 1 : -1;
        this.plantUntil = p.time + PLANT_HOLD; this.plantFree = p.time + PLANT_GAP;
      } else {
        // slow, the way can be turned at once (the animator slews the velocity at human rates)
        const w = sp > PLANT_RUN ? turnRate(sp) * dt : Math.PI;
        this.heading = wrapAngle(this.heading + clamp(d, -w, w));
      }
    }
    this.mag += (Math.min(1, n / FULL) - this.mag) * (1 - Math.exp(-dt / MOVE_TAU));
    c.move = { x: Math.sin(this.heading) * this.mag, z: Math.cos(this.heading) * this.mag };
    if (p.time < this.plantUntil) c.plantCut = this.side;
  }
}

/** Seen through a reaction delay: the world as it was `reaction` s ago, and how old that is. */
class Eyes {
  private history: Perception[] = [];
  constructor(private reaction: number) {}
  see(p: Perception) {
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.reaction) this.history.shift();
    return { seen: this.history[0], age: p.time - this.history[0].time };
  }
}

/** The ball is in the air (thrown, nobody holding it), not yet down to chest height: where it gets there (with the
 *  read's error, shrinking as it comes) and when (s). */
function ballSpot(b: { pos: Vec3; vel: Vec3 }, err: [number, number]): { at: Vec3; t: number } | null {
  const t = fallTime(b.pos, b.vel, CATCH_H);
  if (t < 0) return null;
  const k = Math.min(1, t);
  return { at: [b.pos[0] + b.vel[0] * t + err[0] * k, CATCH_H, b.pos[2] + b.vel[2] * t + err[1] * k], t };
}

/** Go to where a ball in the air comes down and get the hands to it, eyes on it all the way: arrive with it (the run
 *  timed to the flight, at most a sprint) a step short along its flight, so it comes down in front of him, and both
 *  hands up for it there near the end (the diamond: the catch rule). A ball already below the chest coming at him is
 *  reached for; one on its way down out of reach is chased as a loose ball. */
function playBall(p: Perception, me: AthleteView, run: Runner, chase: TacklerBrain, err: [number, number], dt: number): Commands {
  const b = p.ball!, s = ballSpot(b, err), chest: Vec3 = [me.head[0], me.head[1] - 0.3, me.head[2]];
  const c = neutralCommands();
  c.look = [b.pos[0], b.pos[1], b.pos[2]];
  if (!s) {
    if (b.pos[1] > 0.4 && incoming(b, chest, 3)) { c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = catchPoint(b, chest); return c; }
    return { ...chase.think(p, dt), look: c.look };
  }
  const hv = Math.hypot(b.vel[0], b.vel[2]) || 1, fx = b.vel[0] / hv, fz = b.vel[2] / hv;
  // in front of him: the way he runs, or standing, toward the ball
  const sp = Math.hypot(me.comVel[0], me.comVel[2]), ox = sp > 2 ? me.comVel[0] / sp : -fx, oz = sp > 2 ? me.comVel[2] / sp : -fz;
  // beside its line on the side he is already on, so it comes over his shoulder rather than down onto his helmet
  const side = (me.com[0] - s.at[0]) * fz - (me.com[2] - s.at[2]) * fx > 0 ? OVER_SHOULDER : -OVER_SHOULDER;
  const dx = s.at[0] - ox * IN_FRONT + fz * side - me.com[0], dz = s.at[2] - oz * IN_FRONT - fx * side - me.com[2], t = Math.max(s.t, 0.15);
  // a little faster than the flight needs while far from it, to be under it early rather than late
  const d = Math.hypot(dx, dz) || 1e-6, v = Math.min(FULL, d / t + EARLY * clamp(d / 5, 0, 1));
  run.go(p, me, dx / d * v, dz / d * v, dt, c);
  c.gait = 'sprint';
  const near = Math.hypot(b.pos[0] - chest[0], b.pos[1] - chest[1], b.pos[2] - chest[2]);
  if (s.t < HANDS_T || near < HANDS_D) { c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = catchPoint(b, [chest[0] + ox * IN_FRONT, chest[1], chest[2] + oz * IN_FRONT]); }
  return c;
}

const loose = (p: Perception) => !!p.ball && !p.athletes.some((a) => a.hasBall);

/** The receiver: runs his route from where he lines up, then plays a ball thrown to him. */
export class RouteBrain implements Brain {
  private run = new Runner();
  private chase: TacklerBrain;
  private pts: Vec3[] | null = null;
  private leg = 0;
  private err: [number, number];
  constructor(rng: Rng, diff: BotDifficulty, readonly route: Route) {
    this.chase = new TacklerBrain(rng, diff);
    this.err = [rng.gauss() * diff.noise, rng.gauss() * diff.noise];
  }

  think(p: Perception, dt = 1 / 240): Commands {
    const me = p.athletes[p.self];
    if (me.down) return neutralCommands();
    if (loose(p)) return playBall(p, me, this.run, this.chase, this.err, dt);
    const qb = p.athletes.find((a) => a.hasBall);
    if (!qb || qb.team !== me.team) return this.chase.think(p, dt);
    const R = ROUTES[this.route], D = p.field.dirZ, lim = p.field.halfWidth - SIDELINE;
    if (!this.pts) {
      const x0 = me.com[0], z0 = me.com[2], inward = x0 > 0 ? -1 : 1;
      this.pts = R.pts.map(([x, d]) => [clamp(x0 + inward * x * YD, -lim, lim), 0, z0 + D * d * YD]);
    }
    const c = neutralCommands(), last = this.pts.length - 1;
    let to = this.pts[this.leg];
    if (this.leg < last && Math.hypot(to[0] - me.com[0], to[2] - me.com[2]) < TURN) to = this.pts[++this.leg];
    const dx = to[0] - me.com[0], dz = to[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    if (this.leg === last && (d < TURN || Math.abs(me.com[0]) >= lim)) {
      // the route's end (a curl's spot, or the sideline): settle facing the quarterback
      if (R.settle || d < TURN) {
        const fx = qb.com[0] - me.com[0], fz = qb.com[2] - me.com[2], f = Math.hypot(fx, fz) || 1;
        c.face = { x: fx / f, z: fz / f };
        return c;
      }
      // along the sideline, upfield
      this.run.go(p, me, 0, D * FULL, dt, c);
    } else {
      // flat out, throttled down into a sharp break (a 90° one is cut at BREAK_V) and a curl's spot
      let v = FULL;
      if (this.leg < last) {
        const n = this.pts[this.leg + 1], a = this.pts[this.leg - 1] ?? [me.com[0], 0, me.com[2] - D];
        const turn = Math.abs(wrapAngle(Math.atan2(n[0] - to[0], n[2] - to[2]) - Math.atan2(to[0] - a[0], to[2] - a[2])));
        v = Math.min(FULL, Math.sqrt(Math.max(FULL - (FULL - BREAK_V) * turn / (Math.PI / 2), BREAK_V) ** 2 + 2 * BRAKE * d));
      } else if (R.settle) v = clamp(Math.sqrt(2 * BRAKE * d), 1, FULL);
      this.run.go(p, me, dx / d * v, dz / d * v, dt, c);
    }
    c.gait = 'sprint';
    return c;
  }
}

/** Man coverage on athlete `man` (all assumptions, tuned by eye and by completion rates). Pressed, he jams for JAM s
 *  while his man is within JAM_D m (punching, stepping JAB m/s into him while giving ground at his pace), then runs with
 *  him TRAIL m behind and INSIDE m inside, sprinting once his man releases upfield faster than RELEASE m/s (a press
 *  corner plays the deep ball first). Off, he backpedals at up to PEDAL m/s (under the animator's fastest backpedal)
 *  mirroring him across, and turns to run (bails) when the cushion is down to BAIL m, his man breaks across (BREAK m/s
 *  sideways) or after BAIL_T s; then he runs level with him. Across the field he chases BEHIND m behind him, out of his
 *  path. Position errors close at GAIN 1/s on top of his man's pace: what he saw a reaction ago, carried on by the
 *  acceleration seen over that delay and ANTICIPATE s more (a corner reads the speed coming). */
const BEHIND = 1, JAB = 1, RELEASE = 1, JAM = 0.8, JAM_D = 1.6, TRAIL = 0, INSIDE = 1.3, GAIN = 2.5, PEDAL = 5, BAIL = 2.5, BREAK = 3, BAIL_T = 2.5, ANTICIPATE = 0.3;
export class CoverageBrain implements Brain {
  private eyes: Eyes;
  private run = new Runner();
  private chase: TacklerBrain;
  private err: [number, number];
  private t0 = NaN;
  /** Turned to run with him (off coverage): no more backpedal. */
  bailed = false;
  /** His velocity as last seen, when, and his acceleration (m/s², filtered): a corner reads the release and runs with
   *  it, he does not wait to see the speed it brings. */
  private wv: Vec3 = [0, 0, 0]; private wvT = NaN; private wa: Vec3 = [0, 0, 0];
  constructor(rng: Rng, diff: BotDifficulty, readonly man: number, readonly press: boolean) {
    this.eyes = new Eyes(diff.reaction);
    this.chase = new TacklerBrain(rng, diff);
    this.err = [rng.gauss() * diff.noise * 1.5, rng.gauss() * diff.noise * 1.5];
  }

  think(p: Perception, dt = 1 / 240): Commands {
    const { seen, age } = this.eyes.see(p), me = p.athletes[p.self], c = neutralCommands();
    if (Number.isNaN(this.t0) && p.time >= 0) this.t0 = p.time;
    if (me.down) return c;
    // the ball in the air (as seen a reaction ago: he breaks on the throw late)
    if (loose(seen)) return this.contest({ ...p, ball: seen.ball }, me, p.athletes[this.man], dt);
    const holder = p.athletes.findIndex((a) => a.hasBall);
    if (holder === this.man || (holder >= 0 && p.athletes[holder].team === me.team)) return this.chase.think(p, dt);
    const w = predict(seen.athletes[this.man], age), D = p.field.dirZ, t = Number.isNaN(this.t0) ? 0 : p.time - this.t0;
    if (seen.time !== this.wvT) {
      if (!Number.isNaN(this.wvT) && seen.time > this.wvT) for (let k = 0; k < 3; k += 2) this.wa[k] += ((w.comVel[k] - this.wv[k]) / (seen.time - this.wvT) - this.wa[k]) * Math.min(1, (seen.time - this.wvT) / ACC_TAU);
      this.wv = [...w.comVel]; this.wvT = seen.time;
    }
    // his velocity now and a moment on, from what was seen
    const on = age + ANTICIPATE, wvx = w.comVel[0] + this.wa[0] * on, wvz = w.comVel[2] + this.wa[2] * on;
    const dx = w.com[0] - me.com[0], dz = w.com[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    // how far downfield of him I am
    const ahead = -dz * D;
    if (this.press && t < JAM && d < JAM_D && ahead > -0.3) {
      // the jam: square up and punch him off his release, giving ground with him (he turns to run already moving)
      c.face = { x: dx / d, z: dz / d }; c.contactMode = true; c.shoot = true; c.sink = 0.3; c.gait = 'sprint'; c.driveLegs = 1;
      c.move = { x: (wvx + JAB * dx / d) / FULL, z: (D * Math.max(0, wvz * D) + JAB * dz / d) / FULL };
      return c;
    }
    const inward = w.com[0] > 0 ? -1 : 1, ex = w.com[0] + inward * INSIDE - me.com[0];
    c.gait = 'sprint';
    if (!this.press && !this.bailed) this.bailed = ahead < BAIL || Math.abs(w.comVel[0]) > BREAK || t > BAIL_T;
    if (!this.press && !this.bailed) {
      // backpedal and shuffle, eyes on the quarterback: as fast as he comes on, up to a backpedal's pace
      c.face = { x: 0, z: -D };
      const vx = clamp(wvx + GAIN * ex, -PEDAL, PEDAL), vz = D * clamp(wvz * D, 0, PEDAL);
      c.move = { x: vx / FULL, z: vz / FULL };
      this.run.heading = Math.atan2(vx, vz);
      return c;
    }
    // with him: his pace, level with him on his inside (off, once turned) or in his hip pocket (press); breaking across
    // the field (k → 1) he chases a step behind him instead, not into his path
    const want = this.press ? -TRAIL : 0, sp = Math.hypot(wvx, wvz) || 1, k = clamp(Math.abs(wvx) / BREAK, 0, 1);
    let vx = wvx + GAIN * (ex * (1 - k) + k * (w.com[0] - BEHIND * wvx / sp - me.com[0]));
    let vz = wvz + D * GAIN * clamp(want - ahead, -1, 3) * (1 - k) + k * GAIN * (w.com[2] - BEHIND * wvz / sp - me.com[2]);
    // a press corner plays the deep ball first: once his man releases upfield he sprints with him, not after him
    if (this.press && wvz * D > RELEASE && ahead < 1) vz = D * Math.max(vz * D, FULL);
    const n = Math.hypot(vx, vz);
    if (n > FULL) { vx *= FULL / n; vz *= FULL / n; }
    this.run.go(p, me, vx, vz, dt, c);
    return c;
  }

  /** The ball in the air: first to where it comes down, he goes for it (an interception is a catch); behind his man he
   *  plays through him, flat out to the spot to be on him as it comes, hands up for the ball (a deflection, or the
   *  contact a catch is harder through). */
  private contest(p: Perception, me: AthleteView, w: AthleteView, dt: number): Commands {
    const b = p.ball!, s = ballSpot(b, this.err);
    if (!s || Math.hypot(s.at[0] - me.com[0], s.at[2] - me.com[2]) < Math.hypot(s.at[0] - w.com[0], s.at[2] - w.com[2])) return playBall(p, me, this.run, this.chase, this.err, dt);
    const c = neutralCommands(), t = Math.max(s.t, 0.15), chest: Vec3 = [me.head[0], me.head[1] - 0.3, me.head[2]];
    const dx = s.at[0] - me.com[0], dz = s.at[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    const v = Math.max(FULL * clamp(d / 2, 0, 1), d / t);
    this.run.go(p, me, dx / d * v, dz / d * v, dt, c);
    c.gait = 'sprint'; c.look = [b.pos[0], b.pos[1], b.pos[2]]; c.contactMode = d < 2;
    if (s.t < HANDS_T || d < HANDS_D) { c.armL = c.armR = 1; c.gripL = c.gripR = true; c.aim = catchPoint(b, chest); }
    return c;
  }
}

/** The quarterback: a short drop (DROP s), then reads his receiver (seen through a reaction delay) from READ s. He is
 *  open when the ball, thrown now with a lead, gets to him OPEN s before the defender could get within CB_REACH m of
 *  it (CB_REACT s to see the throw, then from his speed toward it accelerating at CB_ACC m/s² up to CB_V m/s; from
 *  beyond the catch along the throw, round the receiver's body: SHIELD m further, no reach). He reads once the
 *  receiver is at speed (FAST m/s) on the route's last leg (within BROKE rad of it: the play call tells him a bot
 *  receiver's route) or settled at its end (SET m/s; the ball goes to the spot within SPOT m), or from SETTLE s
 *  whatever (a player's route is his own). The lead takes the receiver's acceleration on to his top speed (TOP m/s).
 *  By LATE s the ball is out anyway, a little further from the defender (AWAY m); covered from SCRAMBLE s he drifts up
 *  to ROLL m toward his receiver's side. All assumptions, tuned so a bot quarterback completes about what the coverage
 *  allows. */
const DROP = 0.6, READ = 0.7, OPEN = 0.35, CB_V = 9, CB_ACC = 6, CB_REACT = 0.3, CB_REACH = 1, FAST = 4, SET = 1, BROKE = 0.5, SETTLE = 2.2, LATE = 2.8;
const SCRAMBLE = 1.8, ROLL = 4, AWAY = 0.6, TOP = 9.5, SHIELD = 0.8, SPOT = 3;

/** Time (s) to cover s m from v0 m/s (toward it) at acceleration a up to top speed V. */
export function reachTime(s: number, v0: number, a: number, V: number): number {
  const u = clamp(v0, 0, V), t1 = (V - u) / a, s1 = u * t1 + a * t1 * t1 / 2;
  return s <= s1 ? (-u + Math.sqrt(u * u + 2 * a * s)) / a : t1 + (s - s1) / V;
}

/** Distance (m) covered in T s from v m/s accelerating at a m/s² up to V m/s. */
export function runDist(T: number, v: number, a: number, V: number): number {
  const t1 = a > 1e-6 ? Math.max(0, (V - v) / a) : Infinity;
  return T <= t1 ? v * T + a * T * T / 2 : v * t1 + a * t1 * t1 / 2 + V * (T - t1);
}

export class PasserBrain implements Brain {
  private eyes: Eyes;
  private t0 = NaN; private x0 = NaN;
  private thrownAt = -Infinity;
  /** The receiver's speed as last seen, when, and his acceleration along his run (m/s², filtered). */
  private sp = 0; private spT = NaN; private acc = 0;
  /** The route's last leg (unit ground direction), from where the receiver lined up, and where a route that settles
   *  ends (the ball goes there, not where he is still running). */
  private leg: [number, number] | null = null; private spot: Vec3 | null = null;
  /** Last read (tests): the receiver's lead point, his margin over the defender there (s), the loft. */
  read: { at: Vec3; margin: number; loft: number } | null = null;
  /** `route`: the bot receiver's (null: a player runs his own). */
  constructor(private rng: Rng, private diff: BotDifficulty, readonly wr: number, readonly cb: number, readonly route: Route | null = null) {
    this.eyes = new Eyes(diff.reaction);
  }

  think(p: Perception, dt = 1 / 240): Commands {
    const { seen, age } = this.eyes.see(p), me = p.athletes[p.self], c = neutralCommands();
    if (Number.isNaN(this.t0) && p.time >= 0) {
      this.t0 = p.time; this.x0 = me.com[0];
      const r = this.route && ROUTES[this.route].pts, w0 = p.athletes[this.wr].com, inward = w0[0] > 0 ? -1 : 1;
      if (r) {
        const a = r[r.length - 2] ?? [0, 0], b = r[r.length - 1], lx = inward * (b[0] - a[0]), lz = p.field.dirZ * (b[1] - a[1]), l = Math.hypot(lx, lz);
        this.leg = [lx / l, lz / l];
        if (ROUTES[this.route!].settle) this.spot = [w0[0] + inward * b[0] * YD, CATCH_H, w0[2] + p.field.dirZ * b[1] * YD];
      }
    }
    const t = Number.isNaN(this.t0) ? 0 : p.time - this.t0, D = p.field.dirZ;
    const w = predict(seen.athletes[this.wr], age), d = predict(seen.athletes[this.cb], age);
    const fx = w.com[0] - me.com[0], fz = w.com[2] - me.com[2], f = Math.hypot(fx, fz) || 1;
    c.face = { x: fx / f, z: fz / f };
    const sp = Math.hypot(w.comVel[0], w.comVel[2]);
    if (seen.time !== this.spT) {
      if (!Number.isNaN(this.spT) && seen.time > this.spT) this.acc += ((sp - this.sp) / (seen.time - this.spT) - this.acc) * Math.min(1, (seen.time - this.spT) / ACC_TAU);
      this.sp = sp; this.spT = seen.time;
    }
    if (!me.hasBall || me.down) {
      // thrown: watch it
      if (p.ball) { const bx = p.ball.pos[0] - me.com[0], bz = p.ball.pos[2] - me.com[2], b = Math.hypot(bx, bz) || 1; c.face = { x: bx / b, z: bz / b }; }
      return c;
    }
    if (t < DROP) { c.move = { x: 0, z: -D * 0.5 }; c.gait = 'walk'; return c; }
    // covered for long: drift toward his side, buying time
    if (t > SCRAMBLE) { const side = Math.sign(w.com[0] - this.x0) || 1; if (Math.abs(me.com[0] - this.x0) < ROLL) { c.move = { x: side * 0.6, z: 0 }; c.gait = 'jog'; } }
    const from: Vec3 = [me.head[0], me.head[1] + 0.1, me.head[2]];
    // the defender between him and the receiver (undercutting): over the top
    const ux = fx / f, uz = fz / f, cAlong = (d.com[0] - me.com[0]) * ux + (d.com[2] - me.com[2]) * uz, cSide = Math.abs((d.com[0] - me.com[0]) * uz - (d.com[2] - me.com[2]) * ux);
    const loft = clamp(0.1 + f / 80, 0.1, 0.45) + (cAlong < f && cSide < 1.5 ? 0.25 : 0);
    // lead him on at the speed he is getting to over the flight (running his route's last leg)
    const L = this.leg, settles = !!this.route && !!ROUTES[this.route].settle;
    const onLeg = !L || (w.comVel[0] * L[0] + w.comVel[2] * L[1]) > sp * Math.cos(BROKE), running = sp > FAST && onLeg && !settles;
    const pos: Vec3 = [w.com[0], CATCH_H, w.com[2]], vel: Vec3 = [w.comVel[0], 0, w.comVel[2]];
    // a curl: to its spot, where he is turning back to
    if (settles && this.spot && Math.hypot(this.spot[0] - pos[0], this.spot[2] - pos[2]) < SPOT) { pos[0] = this.spot[0]; pos[2] = this.spot[2]; vel[0] = vel[2] = 0; }
    const first = leadPoint(from, { pos, vel }, loft);
    const T0 = THROW.release + throwVelocity(from, first, loft).time, k = running ? runDist(T0, sp, Math.max(0, this.acc), Math.max(sp, TOP)) / (sp * T0) : 1;
    const at = leadPoint(from, { pos, vel: [vel[0] * k, 0, vel[2] * k] }, loft);
    const ex = at[0] - d.com[0], ez = at[2] - d.com[2], e = Math.hypot(ex, ez) || 1;
    const toward = -(d.comVel[0] * ex + d.comVel[2] * ez) / e;
    // a defender beyond the catch along the throw has the receiver's body between him and the ball: he reaches round
    const lx = at[0] - from[0], lz = at[2] - from[2], ll = Math.hypot(lx, lz) || 1, shielded = -(ex * lx + ez * lz) / ll > 0.3;
    const margin = CB_REACT + reachTime(Math.max(0, e - (shielded ? -SHIELD : CB_REACH)), -toward, CB_ACC, CB_V) - THROW.release - throwVelocity(from, at, loft).time;
    this.read = { at, margin, loft };
    const ready = t > READ && (running || (settles && sp < SET && t > 1.5) || t > SETTLE);
    if (t - this.thrownAt < 1 || !(ready && margin > OPEN) && t < LATE) return c;
    // throw him open: the ball a little further from the defender, and the bot's own aim error
    const n = this.diff.noise;
    at[0] += ex / e * AWAY + this.rng.gauss() * n; at[2] += ez / e * AWAY + this.rng.gauss() * n;
    c.pass = { at, loft };
    this.thrownAt = t;
    return c;
  }
}
