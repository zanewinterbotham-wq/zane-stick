// Bot receiver (docs/passing.md "AI built for 11 on 11"): runs the route his assignment names (routes.ts) from where
// he lines up. Against press he releases (a jab one way, then past the defender on the other side with a rip of the
// near arm); he sells the stem at full speed, throttles down just enough to take the break in one plant (a plant cut,
// as a carrier's juke), and keeps his room to the sideline. An option route breaks at its depth by the coverage: away
// from a man defender's leverage, or settles in the hole of a zone. When a pass comes down near him (he is the nearest
// of his team to it) he attacks the earliest point of its flight he can reach in time (back to the ball against an
// undercut; a ball from behind in stride, over the shoulder), his eyes on it all the way (Commands.look), raises both
// hands (the diamond) to where it passes, high-points it with a jump and lays out for one falling short. With the ball
// he is a carrier (CarrierBrain); a pass to a team mate, or a team mate with the ball, he blocks for (BlockerBrain);
// the defense's ball he tackles (TacklerBrain). He reads the field (the defenders, the ball) through his reaction
// delay like every bot; difficulty is that delay and his precision. Same Commands as a human. Nothing assumes one
// receiver or one defender: every read goes over the whole Perception.
import { GAIT_SPEED } from '../../control/hand';
import { neutralCommands, type Commands } from '../../control/types';
import { clamp, wrapAngle, type Vec3 } from '../../math';
import type { Rng } from '../../rng';
import { BlockerBrain } from '../blocker';
import { CarrierBrain, type BotDifficulty } from '../carrier';
import { predict, TacklerBrain } from '../tackler';
import { leadShoulder, type AthleteView, type Brain, type Perception } from '../types';
import { ballAt, BREAK_V, handsPoint, inFlight, JUKE_REACH, LAT, meetPoint, opponents, passIsMine, PLANT_ANGLE, rel } from './sense';
import { optionPath, routePath, type RoutePath } from './routes';
import type { PlayCall, RouteAssign } from './types';

const FULL = GAIT_SPEED.sprint, MOVE_TAU = 0.08;
/** Path following: a corner counts as reached inside ADVANCE m (or once passed); the run aims LOOK s of speed ahead
 *  along the path (at least LOOK_MIN m), never past the next corner. */
const ADVANCE = 0.5, LOOK = 0.4, LOOK_MIN = 2.5;
/** A break sharper than PLANT_ANGLE rad is a plant cut; one plant takes up to JUKE_REACH / speed rad (sense.ts), so
 *  the run throttles down before it to that speed (never below BREAK_V m/s: sharper breaks pivot), braking at most
 *  DECEL m/s² (the last three steps); the command is held PLANT_HOLD s, and the next waits PLANT_GAP s (the cut lasts
 *  0.45 s). */
const DECEL = 4, PLANT_HOLD = 0.12, PLANT_GAP = 0.6;
/** Settling at a route's end: braking (m/s²), and there he faces the QB. */
const SETTLE_BRAKE = 4;
/** A run is slowed by asking for at most this much under its speed (m/s): a sudden stop mid-cut tripped him. */
const EASE = 2;
/** Slower than this (m/s) he jogs (the sprint's long stride at a jog's pace tripped him). */
const JOG_MAX = 6;
/** Press: a defender within PRESS m in front at the snap (and within PRESS_SIDE m across) is met with a release: a
 *  jab JAB s one way, then past him RELEASE_SIDE m on the other side to RELEASE_PAST m beyond him (at most
 *  RELEASE_MAX s). */
const PRESS = 2.5, PRESS_SIDE = 1.5, JAB = 0.2, RELEASE_SIDE = 1.2, RELEASE_PAST = 0.5, RELEASE_MAX = 1.6;
/** Option read inside OPTION_AT m of the break: the nearest defender within MAN_D m is in man when his velocity
 *  follows mine (share MAN_FOLLOW of my speed along my run); a zone hole is looked for HOLE m to each side. */
const OPTION_AT = 2, MAN_D = 7, MAN_FOLLOW = 0.4, HOLE = 6;
/** Team mates closer than SPACE m are kept off (m/s per m inside it): two routes never run into each other. */
const SPACE = 2.5, SPACE_K = 2;
/** The ball (sense.ts: a pass in the air, the catch window, where to meet it): hands up HANDS_T s before it arrives
 *  (or inside HANDS_D m); jump JUMP_LEAD s before a ball above his standing reach (running; standing JUMP_STAND); lay
 *  out DIVE_T s before one he cannot get to that will be within DIVE_D m along his run. Keep a pass mine unless a team
 *  mate is MINE m nearer its landing. */
const HANDS_T = 0.6, HANDS_D = 3, JUMP_LEAD = 0.55, JUMP_STAND = 1.0;
/** Highest a ball is taken without stretching: this far above the head's centre (m, the hands in front of the face),
 *  and how long before it arrives he wants to be there (s). */
const FACE = -0.35, EARLY = 0.15;
/** The hands' reach above the head's centre on the feet (m: up in front of him; a full overhead stretch, returner.ts
 *  OVERHEAD, is too slow to get to a pass), above which he jumps. */
const REACH = 0.3;
/** The eyes lead the ball this much (s: the head's turn follows a look in ~0.08 s, anim/procedural.ts LOOK). */
const LOOK_LEAD = 0.1;
/** Shoulders this far below the head's centre (m). */
const SHOULDER = 0.25;
/** The hands take the ball this far in front of the chest (m, along its flight). */
const HANDS_FWD = 0.5;
/** Square up to the ball while slower than OPEN_V (m/s), or this long before he meets it (s), unless running on to
 *  where it comes down ahead of him. */
const OPEN_T = 0.6, OPEN_V = 3;
/** A ball met lower than this (m) is laid out for. */
const KNEE = 0.6;
const DIVE_T = 0.4, DIVE_D: [number, number] = [0.8, 2.8], MINE = 2;

export type ReceiverPhase = 'stance' | 'release' | 'route' | 'settle' | 'ball' | 'carry' | 'block' | 'tackle';

export class ReceiverBrain implements Brain {
  private history: Perception[] = [];
  private path: RoutePath | null = null;
  private leg = 1;
  private heading = NaN; private mag = 0;
  private plantUntil = 0; private plantSide: -1 | 1 = 1;
  private optioned = false; private thrown = false; private mine = false; private jumped = false; private dived = false;
  private release: { by: number; side: number; until: number; jabUntil: number } | null = null;
  private err: [number, number] = [0, 0];
  private carrier: CarrierBrain; private blocker: BlockerBrain; private tackler: TacklerBrain;
  readonly route: RouteAssign | null;
  phase: ReceiverPhase = 'stance';
  /** When he reached the break (world s) and how far from the drawn break point he went by it (m): tests, HUD. */
  breakAt = { time: NaN, miss: NaN };
  /** The option read made at the break (tests, HUD). */
  read: 'man' | 'zone' | null = null;

  constructor(private rng: Rng, private diff: BotDifficulty, private call: PlayCall, private self: number) {
    const a = call.assign[self];
    this.route = a?.kind === 'route' ? a : null;
    this.carrier = new CarrierBrain(rng, diff, 'sprint');
    this.blocker = new BlockerBrain(rng, diff);
    this.tackler = new TacklerBrain(rng, diff);
  }

  /** The path he runs (drawn at the snap from where he stands), for tests and the shell's route preview. */
  get routePath() { return this.path; }

  think(p: Perception, dt = 1 / 240): Commands {
    this.history.push(p);
    while (this.history.length > 1 && p.time - this.history[1].time >= this.diff.reaction) this.history.shift();
    const seen = this.history[0], age = p.time - seen.time, me = p.athletes[p.self], f = this.call.frame;
    const holder = seen.athletes.findIndex((a) => a.hasBall);
    if (me.hasBall) { this.phase = 'carry'; return this.carrier.think(p, dt); }
    if (holder >= 0 && seen.athletes[holder].team !== me.team) { this.phase = 'tackle'; return this.tackler.think(p, dt); }
    if (inFlight(seen)) this.thrown = true;
    // a team mate has it after the throw (or ran it past the line): block for him; a loose ball after the throw that
    // is not a pass in the air is anyone's: go get it
    if (!this.route || (holder >= 0 && (this.thrown || rel(f, seen.athletes[holder].com).depth > 0.5))) { this.phase = 'block'; return this.blocker.think(p, dt); }
    if (this.thrown && holder < 0) {
      if (!inFlight(seen)) { this.phase = 'tackle'; return this.tackler.think(p, dt); }
      const b = { pos: ballAt(seen.ball!, age).pos, vel: ballAt(seen.ball!, age).vel };
      if (!this.isMine(seen, b, me)) { this.phase = 'block'; return this.blocker.think(p, dt); }
      return this.playBall(p, me, b, dt);
    }
    const c = neutralCommands();
    if (p.time < f.snapTime || me.down) { this.phase = me.down ? this.phase : 'stance'; return c; }
    if (!this.path) this.start(seen, me);
    if (this.release) this.runRelease(p, seen, me, age, dt, c);
    else this.runRoute(p, seen, me, age, dt, c);
    return c;
  }

  /** At the snap: draw the route (the precision noise moves the break point), and look for a press man. */
  private start(seen: Perception, me: AthleteView) {
    const f = this.call.frame, a = this.route!;
    this.path = routePath(a, me.com, f);
    this.err = [this.rng.gauss() * this.diff.noise * 0.5, this.rng.gauss() * this.diff.noise * 0.5];
    const b = this.path.pts[this.path.brk];
    b[0] += this.err[0]; b[2] += this.err[1];
    const r = rel(f, me.com);
    let press = -1, pd = PRESS;
    for (const j of opponents(seen, this.self)) {
      const o = rel(f, seen.athletes[j].com), ahead = o.depth - r.depth;
      if (!seen.athletes[j].down && ahead > 0 && ahead < pd && Math.abs(o.x - r.x) < PRESS_SIDE) { press = j; pd = ahead; }
    }
    if (press < 0) return;
    // release away from his leverage (head up: to the side the route breaks), unless the assignment names it
    const o = seen.athletes[press], inX = this.path.inX, lev = (o.com[0] - me.com[0]) * inX;
    const brkIn = (this.path.pts[this.path.brk + 1]?.[0] ?? b[0]) - b[0];
    const side = a.release === 'outside' ? -inX : a.release === 'inside' ? inX : Math.abs(lev) > 0.2 ? -Math.sign(lev) * inX : (brkIn * inX > 0.3 ? inX : -inX);
    this.release = { by: press, side, until: seen.time + RELEASE_MAX, jabUntil: seen.time + JAB };
    this.phase = 'release';
  }

  /** Off the press man: a jab step away from the release side, then past him on it, the near arm ripping through. */
  private runRelease(p: Perception, seen: Perception, me: AthleteView, age: number, dt: number, c: Commands) {
    const r = this.release!, f = this.call.frame, o = predict(seen.athletes[r.by], age);
    const od = rel(f, o.com).depth, md = rel(f, me.com).depth;
    if (md > od + RELEASE_PAST || p.time > r.until || o.down) { this.release = null; this.phase = 'route'; this.runRoute(p, seen, me, age, dt, c); return; }
    const jab = p.time < r.jabUntil;
    const gx = (jab ? me.com[0] - r.side * 0.6 : o.com[0] + r.side * RELEASE_SIDE) - me.com[0];
    const gz = (jab ? me.com[2] + f.dir * 0.6 : o.com[2] + f.dir * (RELEASE_PAST + 0.5)) - me.com[2];
    const g = Math.hypot(gx, gz) || 1e-6, v = jab ? 2 : FULL;
    this.run(me, gx / g * v, gz / g * v, dt, c, !jab && p.time - r.jabUntil < dt * 1.5);
    if (!jab && p.time - r.jabUntil < PLANT_HOLD) c.plantCut = r.side * f.dir > 0 ? 1 : -1;
    c.gait = 'sprint'; c.contactMode = true; c.lean.fwd = 0.3; c.sink = 0.25;
    // the arm on his side swipes him off (a rip: no grip, it only clears the hands)
    const near = leadShoulder(me, o);
    if (!jab) { if (near >= 0) c.armL = 1; else c.armR = 1; c.aim = [o.com[0], o.pelvis[1] + 0.5, o.com[2]]; }
  }

  /** Run the path: aim ahead along it, throttle down for a sharp break and plant at it, settle at its end. */
  private runRoute(p: Perception, seen: Perception, me: AthleteView, age: number, dt: number, c: Commands) {
    let path = this.path!, pts = path.pts;
    const sp = Math.hypot(me.comVel[0], me.comVel[2]);
    this.phase = 'route';
    // passed the corner (or close): on to the next leg, planting if it turns sharply
    while (this.leg < pts.length) {
      const a = pts[this.leg - 1], b = pts[this.leg], sx = b[0] - a[0], sz = b[2] - a[2], L = Math.hypot(sx, sz) || 1e-6;
      const along = ((me.com[0] - a[0]) * sx + (me.com[2] - a[2]) * sz) / L, d = Math.hypot(b[0] - me.com[0], b[2] - me.com[2]);
      if (this.leg === path.brk && this.route!.option && !this.optioned && d < OPTION_AT) { this.option(seen, me, age); path = this.path!; pts = path.pts; continue; }
      if (d > ADVANCE && along < L) break;
      if (this.leg === path.brk) this.breakAt = { time: p.time, miss: d };
      this.leg++;
      const n = pts[this.leg];
      if (!n) break;
      const turn = wrapAngle(Math.atan2(n[0] - b[0], n[2] - b[2]) - Math.atan2(sx, sz));
      if (Math.abs(turn) > PLANT_ANGLE && sp > 1) {
        this.plantSide = turn > 0 ? 1 : -1; this.plantUntil = p.time + PLANT_HOLD;
        // the plant takes the turn (the run was throttled for it); a sharper one than it can take is pivoted
        this.heading = wrapAngle(this.heading + turn);
      }
    }
    c.gait = 'sprint';
    if (p.time < this.plantUntil) c.plantCut = this.plantSide;
    const end = this.leg >= pts.length;
    if (end && path.settle) return this.settle(p, me, pts[pts.length - 1], dt, c);
    // the leg being run (past the last corner of a run-on route: on along the last leg)
    const k = Math.min(this.leg, pts.length - 1), a = pts[k - 1], b = pts[k];
    const sx = b[0] - a[0], sz = b[2] - a[2], L = Math.hypot(sx, sz) || 1e-6, ux = sx / L, uz = sz / L;
    const along = ((me.com[0] - a[0]) * ux + (me.com[2] - a[2]) * uz);
    const ahead = Math.max(LOOK_MIN, LOOK * sp), s = end ? along + ahead : Math.min(L, along + ahead);
    let vx = a[0] + ux * s - me.com[0], vz = a[2] + uz * s - me.com[2];
    const vn = Math.hypot(vx, vz) || 1e-6;
    // speed: flat out, throttled to take the next break in one plant (none for the last leg of a run-on route)
    let v = FULL;
    const n = pts[k + 1];
    if (!end && n) {
      const turn = Math.abs(wrapAngle(Math.atan2(n[0] - b[0], n[2] - b[2]) - Math.atan2(sx, sz)));
      if (turn > PLANT_ANGLE) {
        const vb = Math.max(BREAK_V, Math.min(FULL, JUKE_REACH / turn)), d = Math.hypot(b[0] - me.com[0], b[2] - me.com[2]);
        v = Math.min(FULL, Math.sqrt(vb * vb + 2 * DECEL * d));
      }
    } else if (!end && path.settle && k === pts.length - 1) {
      const d = Math.hypot(b[0] - me.com[0], b[2] - me.com[2]);
      v = Math.min(FULL, Math.sqrt(2 * SETTLE_BRAKE * d) + 0.5);
    }
    vx = vx / vn * v; vz = vz / vn * v;
    [vx, vz] = this.space(seen, me, age, vx, vz);
    this.run(me, vx, vz, dt, c);
  }

  /** The option read at the break: man (break away from his leverage) or zone (settle in the hole). */
  private option(seen: Perception, me: AthleteView, age: number) {
    this.optioned = true;
    const path = this.path!, b = path.pts[path.brk], sp = Math.hypot(me.comVel[0], me.comVel[2]) || 1e-6;
    const ds = opponents(seen, this.self).map((j) => predict(seen.athletes[j], age)).filter((o) => !o.down);
    let near: AthleteView | null = null, nd = MAN_D;
    for (const o of ds) { const d = Math.hypot(o.com[0] - me.com[0], o.com[2] - me.com[2]); if (d < nd) { nd = d; near = o; } }
    const follow = near ? (near.comVel[0] * me.comVel[0] + near.comVel[2] * me.comVel[2]) / (sp * sp) : 0;
    if (near && follow > MAN_FOLLOW) {
      this.read = 'man';
      this.path = optionPath(path, { man: true, leverage: (near.com[0] - me.com[0]) * path.inX > 0 ? 'inside' : 'outside' }, this.call.frame.halfWidth);
      return;
    }
    // zone: along the break's depth, the spot farthest from every defender (seen half a second on), near the break
    this.read = 'zone';
    let hole = b[0], hs = -Infinity;
    for (let x = b[0] - HOLE; x <= b[0] + HOLE + 1e-9; x += 0.5) {
      let m = 10;
      for (const o of ds) m = Math.min(m, Math.hypot(o.com[0] + o.comVel[0] * 0.5 - x, o.com[2] + o.comVel[2] * 0.5 - b[2]));
      const s = m - 0.15 * Math.abs(x - b[0]);
      if (s > hs) { hs = s; hole = x; }
    }
    this.path = optionPath(path, { man: false, hole }, this.call.frame.halfWidth);
  }

  /** Settle at a route's end: brake onto the spot, then sit facing the QB (the team mate with the ball, else the
   *  line's middle). */
  private settle(p: Perception, me: AthleteView, at: Vec3, dt: number, c: Commands) {
    this.phase = 'settle';
    const dx = at[0] - me.com[0], dz = at[2] - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    const v = d < 0.3 ? 0 : clamp(Math.sqrt(2 * SETTLE_BRAKE * d), 0.5, FULL);
    this.run(me, dx / d * v, dz / d * v, dt, c, Math.hypot(me.comVel[0], me.comVel[2]) < 2.5);
    const q = p.athletes.find((a) => a.hasBall && a.team === me.team), f = this.call.frame;
    const qx = (q ? q.com[0] : 0) - me.com[0], qz = (q ? q.com[2] : f.los - f.dir * 5) - me.com[2], qd = Math.hypot(qx, qz) || 1;
    if (Math.hypot(me.comVel[0], me.comVel[2]) < 3) { c.face = { x: qx / qd, z: qz / qd }; c.sink = 0.2; }
    c.gait = v > JOG_MAX ? 'sprint' : 'jog';
  }

  /** The pass is mine (sense.passIsMine: no team mate nearer where it comes down; kept unless one is MINE m nearer). */
  private isMine(seen: Perception, b: { pos: Vec3; vel: Vec3 }, me: AthleteView) {
    return (this.mine = passIsMine(seen, b, this.self, this.mine ? MINE : 0, me.com));
  }

  /** Attack the ball: run to meet it at the earliest point he can, both hands up to it, jump for a high one, lay
   *  out for one falling short. */
  private playBall(p: Perception, me: AthleteView, b: { pos: Vec3; vel: Vec3 }, dt: number): Commands {
    this.phase = 'ball';
    const c = neutralCommands(), sp = Math.hypot(me.comVel[0], me.comVel[2]);
    // eyes on it all the way in (the trunk and neck turn to it: the catch rule's gaze reads the head), over the shoulder
    // on a deep ball while the legs run on: on where it will be LOOK_LEAD s on, the turn's lag
    c.look = ballAt(b, LOOK_LEAD).pos;
    const reach = me.head[1] + REACH, m = meetPoint(b, me, me.head[1] + FACE, reach);
    // nothing left to play (it is about to hit the turf): run on, easing off
    if (!m) { this.run(me, me.comVel[0] * 0.8, me.comVel[2] * 0.8, dt, c); c.gait = sp > JOG_MAX ? 'sprint' : 'jog'; return c; }
    // his chest goes HANDS_FWD behind where it meets the ball along its flight (the hands take it in front of him);
    // the misjudgement shrinks as the ball comes in
    const bv = ballAt(b, m.t).vel, bh = Math.hypot(bv[0], bv[2]) || 1, k = Math.min(1, m.t);
    const tx = m.at[0] - bv[0] / bh * HANDS_FWD + this.err[0] * k, tz = m.at[2] - bv[2] / bh * HANDS_FWD + this.err[1] * k;
    const dx = tx - me.com[0], dz = tz - me.com[2], d = Math.hypot(dx, dz) || 1e-6;
    // a ball from behind him on his run (over the shoulder) is caught in stride, getting there with it; else he is there
    // EARLY s before it (set, the hands waiting) and no sooner (a run on to the spot keeps its speed); late: flat out
    // (braking no harder than a stride allows: the command never drops more than EASE m/s under his speed)
    const over = sp > OPEN_V && b.vel[0] * me.comVel[0] + b.vel[2] * me.comVel[2] > 0;
    const v = m.late > 0 ? FULL : Math.max(d < 0.2 ? 0 : clamp(d / Math.max(m.t - (over ? 0 : EARLY), 0.05), 1, FULL), sp - EASE);
    const off = sp > 1 && (me.comVel[0] * dx + me.comVel[2] * dz) / (sp * d) < Math.cos(0.6);
    // a way to the ball well off his run: plant and cut onto it (the most one plant takes at this speed, as a
    // carrier's juke), once the last cut is over; slow, he simply turns
    if (off && sp > BREAK_V && p.time >= this.plantUntil + PLANT_GAP) {
      const turn = wrapAngle(Math.atan2(dx, dz) - this.heading), jump = clamp(JUKE_REACH / sp, PLANT_ANGLE, 1.3);
      this.plantSide = turn > 0 ? 1 : -1; this.plantUntil = p.time + PLANT_HOLD;
      this.heading = wrapAngle(this.heading + clamp(turn, -jump, jump));
    }
    if (p.time < this.plantUntil) c.plantCut = this.plantSide;
    this.run(me, dx / d * v, dz / d * v, dt, c, sp <= BREAK_V);
    // running on under it he stays in his sprint stride (a jog's command is a share of the jog's speed, far below his)
    c.gait = v > JOG_MAX || over ? 'sprint' : 'jog';
    const bd = Math.hypot(b.pos[0] - me.com[0], b.pos[1] - me.head[1], b.pos[2] - me.com[2]);
    // set (slow) or with the ball not coming down ahead of his run, he squares up to it (it comes into his hands from
    // in front); running on under it (over the shoulder) it drops into hands held out in front, where it leaves their
    // reach
    const hx = b.pos[0] - me.com[0], hz = b.pos[2] - me.com[2], hd = Math.hypot(hx, hz) || 1;
    const ahead = sp > OPEN_V && (dx * me.comVel[0] + dz * me.comVel[2]) / sp > 0.3;
    if (!ahead && !over && (sp < OPEN_V || m.t < OPEN_T)) c.face = { x: hx / hd, z: hz / hd };
    if (m.t < HANDS_T || bd < HANDS_D) {
      // the arms point at where the ball's flight comes within an arm's length of his shoulders (as he moves on), so
      // the hands are on its path when it gets there
      c.armL = c.armR = 1; c.gripL = c.gripR = true;
      const a = handsPoint(b, [me.com[0], me.head[1] - SHOULDER, me.com[2]], me.comVel, over);
      c.aim = [a[0] + this.err[0] * k, a[1], a[2] + this.err[1] * k];
    }
    // high-point it: a ball above his standing reach, jumped for in time to meet it near the top
    if (!this.jumped && m.jump && m.late <= 0 && m.t < (sp > 3 ? JUMP_LEAD : JUMP_STAND) && d < 2.5) { c.jump = true; this.jumped = true; }
    // falling short of him (or coming in below the knees, too low for the hands running): lay out along the run
    if (!this.dived && (m.late > 0.05 || m.at[1] < KNEE) && m.t < DIVE_T && sp > 2) {
      const ux = me.comVel[0] / sp, uz = me.comVel[2] / sp, along = dx * ux + dz * uz, side = Math.abs(dx * uz - dz * ux);
      if (along > DIVE_D[0] && along < DIVE_D[1] && side < 1) { c.dive = true; this.dived = true; }
    }
    return c;
  }

  /** Keep off team mates running their own routes (the ball holder excepted). */
  private space(seen: Perception, me: AthleteView, age: number, vx: number, vz: number): [number, number] {
    seen.athletes.forEach((a0, i) => {
      if (i === this.self || a0.team !== me.team || a0.hasBall || a0.down) return;
      const a = predict(a0, age), dx = me.com[0] - a.com[0], dz = me.com[2] - a.com[2], d = Math.hypot(dx, dz);
      if (d < SPACE && d > 1e-6) { vx += dx / d * (SPACE - d) * SPACE_K; vz += dz / d * (SPACE - d) * SPACE_K; }
    });
    return [vx, vz];
  }

  /** Toward a ground velocity: the heading turns no faster than footing allows at this speed (pivoting at once when
   *  `pivot`), the magnitude filtered so the command does not chatter. */
  private run(me: AthleteView, vx: number, vz: number, dt: number, c: Commands, pivot = false) {
    const n = Math.hypot(vx, vz);
    if (Number.isNaN(this.heading)) this.heading = me.heading;
    if (n > 1e-3) {
      const d = wrapAngle(Math.atan2(vx, vz) - this.heading), w = (pivot ? 8 : Math.min(6, LAT / Math.max(1, Math.hypot(me.comVel[0], me.comVel[2])))) * dt;
      this.heading = wrapAngle(this.heading + clamp(d, -w, w));
    }
    this.mag += (Math.min(1, n / FULL) - this.mag) * (1 - Math.exp(-dt / MOVE_TAU));
    c.move = { x: Math.sin(this.heading) * this.mag, z: Math.cos(this.heading) * this.mag };
  }
}
