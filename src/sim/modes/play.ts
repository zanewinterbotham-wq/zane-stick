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
// - a forward pass (docs/passing.md; a mode with a line of scrimmage): one, from behind the line; it is incomplete
//   (dead, the rep over) when it touches the turf, a wall or a post before anyone holds it, an interception when the
//   other team catches it (he runs it back), a completion when the passing team does; then the rules above.
// A ball knocked loose stays live: any athlete recovers it by touching it with his trunk (diving on it) or with a
// raised hand (picking it up, or catching it), then attacks his own way. A ball in the air is caught by chance
// (catchTry); one that is muffed bounces off him physically and stays loose.
import { catchTuning, type CatchTuning } from './catching';
import { BALL, BALL_TURF } from '../anatomy/equipment';
import { BlockerBrain } from '../brains/blocker';
import { CarrierBrain } from '../brains/carrier';
import { TacklerBrain } from '../brains/tackler';
import type { Brain } from '../brains/types';
import { neutralCommands, type PassCmd } from '../control/types';
import { makeController } from '../drills/controllers';
import { clamp, qrot, type Quat, type Vec3 } from '../math';
import type { PhysicsEngine } from '../physics/engine';
import { Rng } from '../rng';
import type { PassRecord } from '../throw';
import { World, type AthleteSetup, type WorldSetup } from '../world';
import { attackDir, barrierProps, deadBall, inOwnEndZone, outside, scores } from './rules';
import type { ModeDef, ModeOptions, PlayConfig, PlaySetup, Rules } from './types';

/** Who plays which athlete (multiplayer, docs/multiplayer.md): `human` is the local player's athlete (−1: none, a
 *  spectating host), driven by Play.create's `humanBrain`; `fixed[i]` gives athlete i another fixed brain (a remote
 *  player's HumanBrain). Fixed brains are never replaced; every other athlete is a bot. Default: the human is 0. */
export interface Seats { human?: number; fixed?: readonly (Brain | null | undefined)[] }

/** Stands still: a placeholder brain until the bots get theirs. */
const STILL: Brain = { think: () => neutralCommands() };

export type RepEnd = 'down' | 'touchdown' | 'safety' | 'touchback' | 'out' | 'time' | 'fieldgoal' | 'incomplete' | (string & {}) | null;
/** A play's forward pass: not thrown, in the air, caught by the passing team, by the other, or dead on the turf. */
export type PassState = 'none' | 'air' | 'complete' | 'intercepted' | 'incomplete';
export const PASS_STATES: readonly PassState[] = ['none', 'air', 'complete', 'intercepted', 'incomplete'];

/** Segments that recover a loose ball: the trunk ('trunk' is the minimum body's fused one). */
const TORSO = /^(pelvis|lumbar|thorax|trunk)$/;
/** Catch chance (owner decision 2026-10-18, an arcade rule like the hand snap; every number a game-design assumption,
 *  not a measurement): base chance by the hands the ball comes to [trunk only, one hand, both hands: the diamond];
 *  how far (m) its path may pass from the hand (or the line between both) and still meet the hands squarely;
 *  ball-to-hands speed (m/s) up to which it is soft and at which it is hardest, and the factor there; own ground
 *  speed (m/s) where running starts to cost and where it costs most, and that factor; in the air (both feet off the
 *  turf longer than `flight` s) or laid out (diving: the trunk further than `layout` (cos) off upright, or down on the
 *  turf); touching or held by an opponent; the gaze factor for a ball he does not look at (head forward vs the ball,
 *  full from cos 0.5, least from cos -0.2); and the factor at full knock and at full stun. A ball off the turf this
 *  recently (s) is picked up, not caught. */
// the tunable numbers (base chances, reach and the factors) are CatchTuning (catching.ts, PlayConfig.catching)
const CATCH = { centre: 0.1, soft: 20, hard: 35, run: [4, 9], flight: 0.1, layout: Math.SQRT1_2, look: [0.5, -0.2], knock: 0.5, stun: 0.4, turf: 0.05 };
/** The last catch decided: who, when (world s), the chance, the factors it is the product of, and whether he held it. */
export interface CatchTry { athlete: number; time: number; chance: number; factors: Record<string, number>; caught: boolean }
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
  /** Mode state the HUD shows that only the simulating side knows ('BLOCKED'); snapshots carry it to guests. */
  note = '';
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
  /** The loose ball was kicked (or a kick blocked) or thrown back (a lateral): whoever takes it fields it, he does not
   *  recover a fumble. */
  private kicked = false;
  /** A forward pass has been thrown this play (one per play, NFL). */
  private forward = false;
  private clear = false;
  /** The holder: time on the turf (s), time since he last left it (s), last opponent contact (world s), and whether
   *  a dead ball in his own end zone would be a touchback (he got it there from the opponents and has not left). */
  private turfT = 0; private offT = UP_TIME; private touchedAt = -Infinity; private touchback = false;
  private readonly ballRef = { athlete: -1, seg: this.ball };
  /** The last catch attempt (HUD, tests). */
  lastCatch: CatchTry | null = null;
  /** The catch numbers this play (catching.ts: the defaults with the config's overrides). */
  private catching!: CatchTuning;
  /** This play's forward pass (docs/passing.md): its state, the passer (−1: none yet) and the throw. */
  pass: PassState = 'none';
  passer = -1;
  lastPass: PassRecord | null = null;
  /** Athletes whose catch of this pass failed: no new try until the ball leaves their reach or bounces. */
  private muffed = new Set<number>();
  /** When the loose ball last touched the turf or a barrier (world s). */
  private turfAt = -Infinity;

  /** `brains`: what each athlete thinks with; the world's brains delegate here, so the play can swap a bot's. */
  /** `human`: the local player's athlete (−1: none); `fixed[i]`: athlete i's brain is a player's, never a bot's. */
  private constructor(public world: World, readonly cfg: PlayConfig, readonly mode: PlaySetup, readonly rules: Rules, readonly brains: Brain[], readonly rng: Rng, readonly options: ModeOptions,
    readonly human: number, private readonly fixed: (Brain | null)[]) {
    this.catching = catchTuning(cfg.catching);
  }

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
        controller: ctl, brain: possess(i), hasBall: i === holder, ...(fixed[i] ? { player: true } : { toughness: cfg.toughness }), boneStrength: fixed[i] ? cfg.boneStrength : cfg.aiBoneStrength,
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
    world.passAllowed = (i, cmd) => play.passOk(i, cmd);
    world.onPass = (rec) => play.passed(rec);
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

  /** A remote player left mid-play: athlete i is a bot from now on, with the role brain for the moment (his body
   *  stays the one he was built with). The local human's athlete stays his. */
  toBot(i: number) {
    if (i === this.human || !this.fixed[i]) return;
    this.fixed[i] = null;
    this.brains[i] = this.roleBrain(i);
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
      if (r.outOfBounds && b[1] < BALL_ON_TURF && outside(r, b[0], b[2])) {
        if (this.pass === 'air') return this.incomplete();
        this.touchback = false; return this.dead(this.impetus, b[2], 'out');
      }
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
    this.fumbler = ai; this.clear = false; this.fumbles++; this.kicked = false; this.muffed.clear();
    this.reassign();
  }

  /** A kick mode launches the ball (setup action at the kick): the ball is loose and `team` is its impetus; `kick`
   *  false for one knocked loose (a blocked punt), which is recovered like a fumble. */
  ballLoose(team: 0 | 1, kick = true) {
    const w = this.world, h = w.ballCarrier;
    if (h >= 0) { const g = w.gripping(h, this.ballRef); if (g >= 0) w.releaseGrip(h, g as 0 | 1); }
    w.ballCarrier = -1; this.fumbler = h; this.clear = false; this.impetus = team; this.kicked = kick; this.muffed.clear();
    this.reassign();
  }

  /** Whether a throw toward `cmd` (or a forward pass, without one) by athlete i is allowed now (NFL, in every mode): a
   *  lateral (toward or behind his own goal side) any time; one forward pass a play, from behind the line of
   *  scrimmage where the mode has one (a mode without one allows it from anywhere). */
  passOk(i: number, cmd?: PassCmd): boolean {
    if (this.ended) return false;
    if (cmd && !this.isForward(i, cmd.at)) return true;
    const los = this.mode.los;
    return !this.forward && (los === undefined || (los - this.ballPos()[2]) * attackDir(this.team(i)) >= 0);
  }
  /** A throw toward `at` goes forward: toward the goal athlete i's team attacks, past where the ball is. */
  private isForward(i: number, at: Vec3) { return (at[2] - this.ballPos()[2]) * attackDir(this.team(i)) > 0; }

  /** The ball left the passer's hand (World.onPass): it is in the air, his team's, and he may not take it back until
   *  it has been clear of him. */
  private passed(rec: PassRecord) {
    this.lastPass = rec;
    // a lateral is a live ball like a fumble (no incompletion), but caught or picked up it is fielded, not recovered
    if (!this.isForward(rec.athlete, rec.at)) { this.ballLoose(this.team(rec.athlete)); this.fumbler = rec.athlete; return; }
    this.forward = true;
    this.passer = rec.athlete; this.pass = 'air';
    this.fumbler = rec.athlete; this.clear = false; this.kicked = false; this.muffed.clear(); this.impetus = this.team(rec.athlete);
    this.reassign();
  }

  /** A pass on the turf (or a wall, a post, out of bounds) before anyone held it: dead, the rep over. */
  private incomplete() { this.pass = 'incomplete'; this.end('incomplete'); }

  /** Loose ball: the first athlete to get it recovers it, with a trunk touching it (diving on it) or a raised hand
   *  (not on a broken arm) that touches it or is within the catch reach (CatchTuning.reach) of it (picking it up, or catching it in the air:
   *  by chance, catchTry). */
  private loose() {
    const w = this.world, bp = this.ballPos(), tip = BALL.length / 2;
    let fumblerTouch = false;
    /** Who could take it this step, in order, with the hands it comes to (none: his trunk). */
    const takers = new Map<number, Set<0 | 1>>();
    const add = (i: number, h?: 0 | 1) => {
      if (i === this.fumbler) fumblerTouch = true;
      if (i === this.fumbler && !this.clear) return;
      const t = takers.get(i) ?? new Set<0 | 1>();
      if (h !== undefined) t.add(h);
      takers.set(i, t);
    };
    const ok = (i: number, h: 0 | 1) => w.raised(w.athletes[i], h) && !w.athletes[i].injury.arm[h]; // a hand that is not raised neither catches nor counts as touching
    w.athletes.forEach((a, i) => {
      const hp = [w.handPoint(a, 0), w.handPoint(a, 1)];
      // both hands up: a ball between them is in the catch too
      const reach = this.catching.reach, both = ok(i, 0) && ok(i, 1) && segDist(bp, hp[0], hp[1]) - tip < reach;
      const gap = hp.map((p, h) => Math.hypot(p[0] - bp[0], p[1] - bp[1], p[2] - bp[2]) - a.handGeoms[h].half - tip);
      const hands = ([0, 1] as const).filter((h) => {
        // grips form after the physics step, so one formed on the ball this step has not pulled on it yet
        const held = w.gripping(i, this.ballRef) === h;
        if (held) w.releaseGrip(i, h);
        return ok(i, h) && (both || gap[h] < reach || held);
      });
      // the other raised hand close by joins the catch (the diamond: the ball reaches one hand a moment before both)
      const o = 1 - (hands[0] ?? 0) as 0 | 1;
      if (hands.length === 1 && ok(i, o) && gap[o] < 2 * reach) hands.push(o);
      for (const h of hands) add(i, h);
    });
    for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]] as const) {
      if (p.athlete >= 0 || p.seg !== this.ball) continue;
      if (o.athlete < 0 && this.pass === 'air') return this.incomplete();
      if (o.athlete < 0) { this.turfAt = w.time; this.muffed.clear(); continue; } // a bounce: everyone may try again
      // the trunk, or a raised arm the ball strikes (trapped against the forearms, as a catch often is)
      const name = w.athletes[o.athlete].plan.segments[o.seg].name, arm = /^(?:hand|forearm|upperArm)([LR])$/.exec(name), h = arm?.[1] === 'L' ? 0 : 1;
      if (TORSO.test(name)) add(o.athlete);
      else if (arm && ok(o.athlete, h)) add(o.athlete, h);
      else if (o.athlete === this.fumbler) fumblerTouch = true;
    }
    this.clear ||= !fumblerTouch;
    for (const i of this.muffed) if (!takers.has(i)) this.muffed.delete(i); // it has left his reach
    const air = w.time - this.turfAt > CATCH.turf;
    let by = -1;
    for (const [i, hands] of takers) {
      if (this.muffed.has(i)) continue;
      if (!air || this.catchTry(i, hands)) { by = i; break; }
      this.muffed.add(i);
    }
    if (by < 0) return;
    this.tuck(by);
    // a caught pass is a completion or an interception, not a recovery
    if (this.pass === 'air') this.pass = this.team(by) === this.team(this.passer) ? 'complete' : 'intercepted';
    else if (!this.kicked) this.recoveredBy = by;
    this.reassign();
  }

  /** Catching (owner decision 2026-10-18): whether athlete i holds a ball in the air that has come to `hands` (none:
   *  his trunk), decided once as it comes, with the world's seeded RNG. The chance is the base for the hands times
   *  factors (CATCH): how centred it comes (full if it meets the hands squarely, CatchTuning.edge at the edge of the reach),
   *  how fast it comes at them, his own speed, being in the air or on the turf, an opponent touching or holding him,
   *  whether he looks at it, and his knock and stun. The same rule for every athlete. */
  private catchTry(i: number, hands: ReadonlySet<0 | 1>): boolean {
    const w = this.world, a = w.athletes[i], s = w.scene.athletes[i].state, bp = this.ballPos(), bv = w.scene.propVel(this.ball);
    const hs = [...hands], n = hs.length || 1, cp: Vec3 = [0, 0, 0], cv: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      cp[k] = hs.length ? hs.reduce<number>((x, h) => x + w.handPoint(a, h)[k], 0) / n : s.com[k];
      cv[k] = hs.length ? hs.reduce<number>((x, h) => x + s.segVel[3 * a.handSegs[h] + k], 0) / n : s.comVel[k];
    }
    const r = [bp[0] - cp[0], bp[1] - cp[1], bp[2] - cp[2]], u = [bv[0] - cv[0], bv[1] - cv[1], bv[2] - cv[2]], uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
    // how centred: the ball's own path's closest approach to the hand, or to the line between the two (the diamond's
    // middle); the hands' moment-to-moment motion is theirs to adjust, so it counts only in the speed
    const vv = bv[0] * bv[0] + bv[1] * bv[1] + bv[2] * bv[2], t = Math.max(0, -(r[0] * bv[0] + r[1] * bv[1] + r[2] * bv[2]) / (vv || 1e-9));
    const at: Vec3 = [bp[0] + bv[0] * t, bp[1] + bv[1] * t, bp[2] + bv[2] * t];
    const miss = hs.length === 2 ? segDist(at, w.handPoint(a, 0), w.handPoint(a, 1)) : Math.hypot(at[0] - cp[0], at[1] - cp[1], at[2] - cp[2]), speed = Math.sqrt(uu);
    const q = s.segQuat, axis = (k: number, v: Vec3) => qrot([q[4 * k], q[4 * k + 1], q[4 * k + 2], q[4 * k + 3]] as Quat, v);
    const hi = a.segIndex.get('head')!, fwd = axis(hi, [0, 0, 1]), up = axis(a.segIndex.get('thorax') ?? a.segIndex.get('trunk')!, [0, 1, 0]);
    const d = [bp[0] - s.segPos[3 * hi], bp[1] - s.segPos[3 * hi + 1], bp[2] - s.segPos[3 * hi + 2]], dn = Math.hypot(d[0], d[1], d[2]) || 1;
    // a ball high above him is one he looks up at: the head's tilt is not modelled, so steep elevation counts as seen
    const look = Math.max((fwd[0] * d[0] + fwd[2] * d[2]) / ((Math.hypot(fwd[0], fwd[2]) || 1) * (Math.hypot(d[0], d[2]) || 1e-9)), 2 * d[1] / dn - 1);
    const C = CATCH, T = this.catching, f: Record<string, number> = {
      hands: [T.body, T.oneHand, T.twoHands][Math.min(hs.length, 2)],
      centred: hs.length ? 1 - (1 - T.edge) * clamp((miss - C.centre) / Math.max(1e-3, T.reach - C.centre), 0, 1) ** 2 : 1,
      speed: 1 - (1 - T.hard) * clamp((speed - C.soft) / (C.hard - C.soft), 0, 1),
      running: 1 - (1 - T.moving) * clamp((Math.hypot(s.comVel[0], s.comVel[2]) - C.run[0]) / (C.run[1] - C.run[0]), 0, 1),
      air: a.airT > C.flight || a.downBy || up[1] < C.layout ? T.air : 1, // off the turf longer than a stride's flight (a jump), or laid out
      contact: a.touching.some((k) => this.team(k) !== a.setup.team) || a.heldT > 0 ? T.contact : 1,
      look: T.blind + (1 - T.blind) * clamp((look - C.look[1]) / (C.look[0] - C.look[1]), 0, 1),
      knock: (1 - C.knock * a.knock) * (1 - C.stun * a.stun) * (a.injury.out ? 0 : 1),
    };
    const chance = Object.values(f).reduce((x, y) => x * y, 1), caught = w.rng.next() < chance;
    this.lastCatch = { athlete: i, time: w.time, chance, factors: f, caught };
    return caught;
  }

  /** End the play (the shared rules call it; a mode's step may too, e.g. a field goal). */
  end(reason: Exclude<RepEnd, null>, scorer: -1 | 0 | 1 = -1, points = 0) {
    if (this.ended) return;
    this.ended = reason; this.endTime = this.world.time; this.scorer = scorer; this.points = points;
    this.mode.ended?.(this);
    if (!this.verdict && this.mode.verdict) this.verdict = this.verdictFor(this.human >= 0 ? this.team(this.human) : 0);
  }

  /** The result in words from a team's side: the mode's own words for it, else the shared verdict. */
  verdictFor(team: 0 | 1) { return this.mode.verdict?.(this, team) || this.verdict; }

  destroy() { this.world.destroy(); }
}

/** Distance from p to the segment ab (m). */
function segDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-9)));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
}
