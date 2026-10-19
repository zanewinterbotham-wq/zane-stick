// One play of any mode, under the shared NFL-style rules (no penalties). The play ends when the ball is dead:
// - touchdown: the ball, held by a runner, breaks the plane of the goal line his team attacks (the ball's position,
//   not his body's);
// - down by contact: a runner with any part but hands and feet on the turf while an opponent touches him, or within
//   CONTACT_MEM of one doing so (untouched he may get up and run on, unless he stays on the turf GIVE_UP: he has
//   given himself up, as a kneel does);
// - out of bounds (when the rules say so): a runner touching the turf on or beyond a line, a loose ball on the turf
//   beyond one;
// - dead in a team's own end zone: a touchback when the opponents put the ball there (a kick, their fumble) and it
//   has not left it since, else a safety.
// A ball knocked loose stays live: any athlete recovers it by touching it with his trunk (diving on it) or with a
// raised hand (picking it up, or catching it), then attacks his own way.
import { BALL, BALL_TURF } from '../anatomy/equipment';
import { BlockerBrain } from '../brains/blocker';
import { CarrierBrain } from '../brains/carrier';
import { TacklerBrain } from '../brains/tackler';
import type { Brain } from '../brains/types';
import { neutralCommands } from '../control/types';
import { makeController } from '../drills/controllers';
import type { Vec3 } from '../math';
import type { PhysicsEngine } from '../physics/engine';
import { Rng } from '../rng';
import { World, type AthleteSetup, type WorldSetup } from '../world';
import { attackDir, barrierProps, deadBall, inOwnEndZone, outside, scores } from './rules';
import type { ModeDef, ModeOptions, PlayConfig, PlaySetup, Rules } from './types';

/** Who plays which athlete (multiplayer, docs/multiplayer.md): `human` is the local player's athlete (−1: none, a
 *  spectating host), driven by Play.create's `humanBrain`; `fixed[i]` gives athlete i another fixed brain (a remote
 *  player's HumanBrain). Fixed brains are never replaced; every other athlete is a bot. Default: the human is 0. */
export interface Seats { human?: number; fixed?: readonly (Brain | null | undefined)[] }

/** Stands still: a placeholder brain until the bots get theirs. */
const STILL: Brain = { think: () => neutralCommands() };

export type RepEnd = 'down' | 'touchdown' | 'safety' | 'touchback' | 'out' | 'time' | 'fieldgoal' | (string & {}) | null;

/** Segments that recover a loose ball: the trunk ('trunk' is the minimum body's fused one). */
const TORSO = /^(pelvis|lumbar|thorax|trunk)$/;
/** Catching (owner decision 2026-10-18): a raised hand this close to the loose ball (m, hand surface to ball tip), or
 *  two raised hands with the ball this close to the line between them, catch it (or pick it up): a game reach, the
 *  same for every athlete, standing in for fingers the hand model lacks and a catcher's last-instant adjustments. */
const CATCH_REACH = 0.3;
/** Off the turf this long counts as up (s): a body lying on the turf flickers out of contact for a few steps. */
const UP_TIME = 0.5;
/** A runner going down this soon after an opponent last touched him is down by contact (s): the hit that took his
 *  feet often lets go of him just before he lands. */
const CONTACT_MEM = 1;
/** Untouched on the turf this long (s, flickers shorter than UP_TIME included) he has given himself up: a get-up
 *  takes about 2.5 s. */
const GIVE_UP = 4;
/** A loose ball this low (m, centre) beyond a line is on the turf out of bounds. */
const BALL_ON_TURF = 0.25;

export class Play {
  rep = 0;
  repStart = 0;
  ended: RepEnd = null;
  endTime = 0;
  /** Who scored this play (team, −1: nobody) and how much; `verdict` overrides the result card's title. */
  scorer: -1 | 0 | 1 = -1;
  points = 0;
  verdict = '';
  /** The ball's prop index. */
  readonly ball = 0;
  /** Athlete 1, the first bot: the open-field drill's opponent (tests and automation address him by this). */
  readonly carrier = 1;
  /** Fumbles this play, and who recovered the last one (−1: none yet). */
  fumbles = 0;
  recoveredBy = -1;
  /** The team whose action put the ball where it is: the last to hold it, or a kicking team (a kick mode sets it,
   *  with `ballLoose`, when it launches the ball). Decides touchbacks and safeties. */
  impetus: 0 | 1 = 0;
  /** The athlete who last lost the ball: he can recover it only once it has been clear of his body. */
  private fumbler = -1;
  /** The loose ball was kicked (or a kick blocked): whoever takes it fields the kick, he does not recover a fumble. */
  private kicked = false;
  private clear = false;
  /** The holder: time on the turf (s), time since he last left it (s), last opponent contact (world s), and whether
   *  a dead ball in his own end zone would be a touchback (he got it there from the opponents and has not left). */
  private turfT = 0; private offT = UP_TIME; private touchedAt = -Infinity; private touchback = false;
  private readonly ballRef = { athlete: -1, seg: this.ball };

  /** `brains`: what each athlete thinks with; the world's brains delegate here, so the play can swap a bot's. */
  /** `human`: the local player's athlete (−1: none); `fixed[i]`: athlete i's brain is a player's, never a bot's. */
  private constructor(public world: World, readonly cfg: PlayConfig, readonly mode: PlaySetup, readonly rules: Rules, readonly brains: Brain[], readonly rng: Rng, readonly options: ModeOptions,
    readonly human: number, private readonly fixed: readonly (Brain | null)[]) {}

  static async create(engine: PhysicsEngine, cfg: PlayConfig, def: ModeDef, options: ModeOptions, humanBrain: Brain | null, rep = 0, seats: Seats = {}): Promise<Play> {
    const rng = new Rng(cfg.seed * 7919 + rep * 104729);
    const ps = def.setup(options, rng, cfg), r = ps.rules;
    const b0 = ps.ball, holder = 'holder' in b0 ? b0.holder : -1;
    const botRngs = ps.players.map((_, i) => (i === 0 ? rng : new Rng(rng.next() * 1e9)));
    const me = seats.human ?? 0, fixed = ps.players.map((_, i) => (i === me ? humanBrain : seats.fixed?.[i] ?? null));
    const brains: Brain[] = fixed.map((b) => b ?? STILL);
    // whoever holds the ball keeps it tucked in the right arm (a human's input has no carry button)
    const possess = (i: number): Brain => ({ think: (p, dt) => { const c = brains[i].think(p, dt); if (p.athletes[i].hasBall) c.carry = 2; return c; } });
    const ctl: AthleteSetup['controller'] = (p, m) => makeController(p, m, 'tracking', cfg.gains);
    const team = 'holder' in b0 ? ps.players[holder].team : b0.impetus;
    const setup: WorldSetup = {
      physics: cfg.physics, seed: cfg.seed + rep, assist: cfg.assist, traction: cfg.traction, hitPower: cfg.hitPower,
      field: { halfWidth: r.halfWidth, goalZ: r.goal[team], dirZ: attackDir(team) },
      athletes: ps.players.map((s, i) => ({
        params: s.params ?? (fixed[i] ? cfg.human : cfg.bot), pos: [s.pos[0], 0, s.pos[1]], yaw: s.yaw ?? (s.team === 0 ? 0 : Math.PI), team: s.team,
        controller: ctl, brain: possess(i), hasBall: i === holder, ...(!fixed[i] && { toughness: cfg.toughness }), boneStrength: fixed[i] ? cfg.boneStrength : cfg.aiBoneStrength,
      })),
      // a held ball is parked out of reach above its holder until he has tucked his arm (setup only; under the field the
      // turf shot it up through him)
      props: [{ name: 'ball', shape: 'ellipsoid', size: [BALL.diameter / 2, BALL.diameter / 2, BALL.length / 2], mass: BALL.mass,
        pos: 'holder' in b0 ? [ps.players[holder].pos[0], 6, ps.players[holder].pos[1]] : b0.at, friction: 0.8, turf: BALL_TURF }, ...barrierProps(), ...(ps.props ?? [])],
      support: cfg.support && { ...cfg.support },
    };
    const world = await World.create(engine, setup);
    const play = new Play(world, cfg, ps, r, brains, new Rng(rng.next() * 1e9), options, me, fixed);
    play.rep = rep;
    play.impetus = team;
    for (let i = 0; i < brains.length; i++) if (!fixed[i]) brains[i] = play.roleBrain(i, botRngs[i]);
    play.preroll(holder);
    return play;
  }

  /** Pre-roll: let everyone settle and the ball holder tuck his arm, then put the ball in his hand and grip it. */
  private preroll(holder: number) {
    const w = this.world, bots = this.brains.slice();
    // hold the bots still while the holder tucks (the human brains have no input yet during the pre-roll)
    for (let i = 0; i < bots.length; i++) if (!this.fixed[i]) this.brains[i] = { think: (p, dt) => ({ ...bots[i].think({ ...p, time: -1 }, dt), move: { x: 0, z: 0 }, dive: false }) };
    for (let i = 0; i < Math.round(0.5 / w.dt); i++) w.step();
    for (let i = 0; i < bots.length; i++) this.brains[i] = bots[i];
    if (holder >= 0) this.tuck(holder);
    this.repStart = w.time;
  }

  team(i: number): 0 | 1 { return this.world.athletes[i].setup.team; }
  /** Athlete i thinks with a bot brain (the play may swap it), not a player's. */
  isBot(i: number) { return !this.fixed[i]; }
  get repTime() { return this.world.time - this.repStart; }
  ballPos(): Vec3 { return this.world.scene.propPose(this.ball).pos; }

  /** The bot brain for athlete i now: the mode's, else by role (holder runs, his teammates block, the rest tackle). */
  roleBrain(i: number, rng = this.rng): Brain {
    const m = this.mode.brain?.(this, i, rng);
    if (m) return m;
    const h = this.world.ballCarrier, d = this.cfg.difficulty;
    if (h === i) return new CarrierBrain(rng, d, this.cfg.carrierGait);
    if (h >= 0 && this.team(h) === this.team(i)) return new BlockerBrain(rng, d);
    return new TacklerBrain(rng, this.cfg.defense ?? d);
  }

  /** Every bot thinks again for its new role (possession changed, or a kick came down). */
  reassign() { for (let i = 0; i < this.brains.length; i++) if (!this.fixed[i]) this.brains[i] = this.roleBrain(i); }

  /** Put the ball in athlete ai's right hand and grip it (rep start, and a recovery). */
  private tuck(ai: number) {
    const w = this.world, a = w.athletes[ai], s = w.scene.athletes[ai].state;
    // the right hand, or the left while the right arm is broken
    const h = a.injury.arm[1] ? 0 : 1, hi = a.handSegs[h];
    if (a.grips[h].active) w.releaseGrip(ai, h); // a recovering hand may be holding something else
    const from = this.ballPos()[2], T = a.setup.team;
    // a ball the opponents put in his own end zone is a touchback if it dies there
    this.touchback = this.impetus !== T && inOwnEndZone(this.rules, T, from);
    w.tuckBall(ai, h);
    // moving with the hand: a ball put at rest in a hand swinging up to a catch is struck by it and torn out
    w.scene.launchProp(this.ball, [s.segVel[3 * hi], s.segVel[3 * hi + 1], s.segVel[3 * hi + 2]], [0, 0, 0]);
    this.impetus = T;
    this.turfT = 0; this.offT = UP_TIME; this.touchedAt = -Infinity;
    w.setup.field = { halfWidth: this.rules.halfWidth, goalZ: this.rules.goal[T], dirZ: attackDir(T) };
  }

  step() {
    this.world.step();
    if (this.ended) return;
    const w = this.world, r = this.rules, hi = w.ballCarrier;
    if (hi >= 0) {
      const a = w.athletes[hi], T = a.setup.team, bz = this.ballPos()[2];
      if (a.touching.some((k) => this.team(k) !== T)) this.touchedAt = w.time;
      if (a.downBy) { this.turfT += w.dt; this.offT = 0; } else if ((this.offT += w.dt) >= UP_TIME) this.turfT = 0;
      if (this.touchback && !inOwnEndZone(r, T, bz)) this.touchback = false;
      // checked before the grip: a ball that comes out on the step he lands was still held when he went down
      if (a.downBy && (w.time - this.touchedAt < CONTACT_MEM || this.turfT > GIVE_UP || a.injury.out)) return this.dead(T, bz, 'down');
      if (w.gripping(hi, this.ballRef) < 0) this.fumble(hi);
      else if (scores(r, T, bz)) return this.end('touchdown', T, r.points.touchdown);
      else if (r.outOfBounds && this.runnerOut(hi)) return this.dead(T, bz, 'out');
    }
    if (w.ballCarrier < 0) {
      const b = this.ballPos();
      if (r.outOfBounds && b[1] < BALL_ON_TURF && outside(r, b[0], b[2])) { this.touchback = false; return this.dead(this.impetus, b[2], 'out'); }
      this.loose();
    }
    this.mode.step?.(this);
    if (!this.ended && this.repTime > r.timeLimit) this.end('time');
  }

  /** The ball is dead with `team` responsible for it at z (see deadBall). */
  private dead(team: 0 | 1, z: number, how: 'down' | 'out') {
    const d = deadBall(this.rules, team, z, this.touchback, how);
    this.end(d.end, d.scorer, d.end === 'safety' ? this.rules.points.safety : 0);
  }

  /** The runner touches the turf on or beyond a line. */
  private runnerOut(i: number) {
    for (const c of this.world.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]] as const)
      if (p.athlete === i && o.athlete < 0 && o.seg < 0 && outside(this.rules, c.pos[0], c.pos[2])) return true;
    return false;
  }

  private fumble(ai: number) {
    this.world.ballCarrier = -1;
    this.fumbler = ai; this.clear = false; this.fumbles++; this.kicked = false;
    this.reassign();
  }

  /** A kick mode launches the ball (setup action at the kick): the ball is loose and `team` is its impetus; `kick`
   *  false for one knocked loose (a blocked punt), which is recovered like a fumble. */
  ballLoose(team: 0 | 1, kick = true) {
    const w = this.world, h = w.ballCarrier;
    if (h >= 0) { const g = w.gripping(h, this.ballRef); if (g >= 0) w.releaseGrip(h, g as 0 | 1); }
    w.ballCarrier = -1; this.fumbler = h; this.clear = false; this.impetus = team; this.kicked = kick;
    this.reassign();
  }

  /** Loose ball: the first athlete to get it recovers it, with a trunk touching it (diving on it) or a raised hand
   *  that touches it or is within CATCH_REACH of it (picking it up, or catching it in the air). */
  private loose() {
    const w = this.world, bp = this.ballPos();
    let by = -1, fumblerTouch = false;
    const take = (i: number) => {
      if (i === this.fumbler) fumblerTouch = true;
      return i !== this.fumbler || this.clear;
    };
    w.athletes.forEach((a, i) => {
      const hp = [w.handPoint(a, 0), w.handPoint(a, 1)], tip = BALL.length / 2;
      // both hands up: a ball between them is in the catch too
      const both = w.raised(a, 0) && w.raised(a, 1) && segDist(bp, hp[0], hp[1]) - tip < CATCH_REACH;
      for (const h of [0, 1] as const) {
        const near = both || Math.hypot(hp[h][0] - bp[0], hp[h][1] - bp[1], hp[h][2] - bp[2]) - a.handGeoms[h].half - tip < CATCH_REACH;
        // grips form after the physics step, so one formed on the ball this step has not pulled on it yet
        const held = w.gripping(i, this.ballRef) === h;
        if (held) w.releaseGrip(i, h);
        if (w.raised(a, h) && (near || held) && take(i) && by < 0) by = i; // a hand that is not raised neither catches nor counts as touching
      }
    });
    for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]] as const) {
      if (p.athlete >= 0 || p.seg !== this.ball || o.athlete < 0) continue;
      const a = w.athletes[o.athlete];
      // the trunk, or a raised arm the ball strikes (trapped against the forearms, as a catch often is)
      const name = a.plan.segments[o.seg].name, arm = /^(?:hand|forearm|upperArm)([LR])$/.exec(name);
      const caught = TORSO.test(name) || (!!arm && w.raised(a, arm[1] === 'L' ? 0 : 1));
      if (caught && take(o.athlete) && by < 0) by = o.athlete;
      else if (o.athlete === this.fumbler) fumblerTouch = true;
    }
    this.clear ||= !fumblerTouch;
    if (by < 0) return;
    this.tuck(by);
    if (!this.kicked) this.recoveredBy = by;
    this.reassign();
  }

  /** End the play (the shared rules call it; a mode's step may too, e.g. a field goal). */
  end(reason: Exclude<RepEnd, null>, scorer: -1 | 0 | 1 = -1, points = 0) {
    if (this.ended) return;
    this.ended = reason; this.endTime = this.world.time; this.scorer = scorer; this.points = points;
    this.mode.ended?.(this);
  }

  destroy() { this.world.destroy(); }
}

/** Distance from p to the segment ab (m). */
function segDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-9)));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
}
