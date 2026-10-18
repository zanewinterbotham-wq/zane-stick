// Sound cues read from the world after each step: footsteps, cuts, falls, slides, get-ups, dives, arm swings,
// breaths, the ball, and injuries (bone cracks, screams, knockouts, moans on the turf). Presentation only: reads the sim, never writes to it. Hits come from HitMeter (feel.ts).
import type { Vec3 } from '../sim/math';
import { Rng } from '../sim/rng';
import type { World } from '../sim/world';

export interface Cue { cat: string; loud: number; pos?: Vec3 }

/** Sprint footsteps from this ground speed up (m/s); jog below. */
const SPRINT_STEP = 5.5;
/** A foot must be off the turf this long before its touchdown is a step (s): contact flicker is not a step. */
const STEP_AIR = 0.06;
/** Plant skid: braking or sideways velocity change this far from the 0.25 s average (m/s, about 4 m/s² held),
 *  from at least this ground speed (m/s). A cut brakes hard before it turns, so braking counts as well. */
const SKID_DV = 1, SKID_SPEED = 2.5, SKID_TAU = 0.25;
/** Arm whoosh: hand speed relative to the body COM (m/s) that starts one, and the speed it must drop below again. */
const WHOOSH_ON = 7, WHOOSH_OFF = 5;
/** A downed body sliding faster than this (m/s) scrapes the turf. */
const SLIDE_SPEED = 2;
/** Contact must have been broken this long before touching again is a new fall (s): a body on the turf, or a
 *  rolling ball, flickers in and out of contact every few steps. */
const FALL_GAP = 0.5, BALL_GAP = 0.1;
/** An athlete out of play moans on the turf: first this long after the injury (s; a knockout comes round later),
 *  then every MOAN.every s (range). */
const MOAN = { after: 1.5, afterKo: 3, every: [2.5, 5] as const };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

interface Track {
  downAt: number; touching: boolean[]; air: number[]; clip: string; dive: string; flightAt: number;
  thrust: boolean; handFast: boolean[]; vAvg: [number, number]; skidAt: number; skidArmed: boolean; breathIn: number; moanAt: number;
}

export class SoundCues {
  private tr: Track[] = [];
  private ballHeld = false;
  private ballAt = new Map<number, number>(); // when the ball last touched each athlete (index) or the turf (−1)
  private ballVel: ArrayLike<number> = [0, 0, 0];
  private rng = new Rng(0xb1ea7);
  private injuriesSeen = 0;

  /** `ball`: the ball's prop index. */
  constructor(private ball: number) {}

  step(w: World): Cue[] {
    const out: Cue[] = [], dt = w.dt, t = w.time;
    w.athletes.forEach((a, i) => {
      const s = w.scene.athletes[i].state, seg = (name: string): Vec3 => { const k = a.segIndex.get(name) ?? 0; return [s.segPos[3 * k], s.segPos[3 * k + 1], s.segPos[3 * k + 2]]; };
      const vx = s.comVel[0], vz = s.comVel[2], speed = Math.hypot(vx, vz), down = a.downBy !== null;
      const clip = String(a.controller.debug?.().clip ?? ''), dive = a.controller.root?.()?.dive ?? 'none';
      const tr = this.tr[i] ??= { downAt: down ? t : -Infinity, touching: a.feet.map((f) => f.touching), air: [0, 0], clip, dive, flightAt: -Infinity,
        thrust: a.cmd.thrustHips, handFast: [false, false], vAvg: [vx, vz], skidAt: 0, skidArmed: false, breathIn: 1, moanAt: Infinity };
      const grounded = a.feet[0].touching || a.feet[1].touching;

      a.feet.forEach((f, k) => {
        if (f.touching && !tr.touching[k] && tr.air[k] > STEP_AIR && !down && speed > 0.3)
          out.push({ cat: speed > SPRINT_STEP ? 'foot_sprint' : 'foot_jog', loud: clamp01(0.2 + speed / 9), pos: seg(k ? 'footR' : 'footL') });
        tr.air[k] = f.touching ? 0 : tr.air[k] + dt;
        tr.touching[k] = f.touching;
      });

      // velocity change against the recent average, without the forward part (speeding up is not a plant)
      const al = Math.min(1, dt / SKID_TAU), va = tr.vAvg;
      va[0] += (vx - va[0]) * al; va[1] += (vz - va[1]) * al;
      const sa = Math.hypot(va[0], va[1]), ux = va[0] / (sa || 1), uz = va[1] / (sa || 1);
      const dx = vx - va[0], dz = vz - va[1], fwd = Math.max(0, dx * ux + dz * uz), turn = Math.hypot(dx - fwd * ux, dz - fwd * uz);
      // one skid per plant: a long hard curve re-arms only once it eases off
      if (turn < 0.5 * SKID_DV) tr.skidArmed = true;
      if (tr.skidArmed && grounded && !down && !a.playerContact && sa > SKID_SPEED && turn > SKID_DV && t > tr.skidAt) {
        out.push({ cat: 'foot_plant_skid', loud: clamp01(0.3 + turn / 4), pos: seg(a.feet[0].touching ? 'footL' : 'footR') });
        tr.skidAt = t + 0.5; tr.skidArmed = false;
      }

      a.handSegs.forEach((h, k) => {
        const rel = Math.hypot(s.segVel[3 * h] - s.comVel[0], s.segVel[3 * h + 1] - s.comVel[1], s.segVel[3 * h + 2] - s.comVel[2]);
        if (!tr.handFast[k] && rel > WHOOSH_ON) out.push({ cat: 'air_whoosh', loud: clamp01((rel - 5) / 6), pos: [s.segPos[3 * h], s.segPos[3 * h + 1], s.segPos[3 * h + 2]] });
        tr.handFast[k] = rel > (tr.handFast[k] ? WHOOSH_OFF : WHOOSH_ON);
      });

      if (dive === 'launch' && tr.dive !== 'launch') out.push({ cat: 'air_whoosh', loud: 0.9, pos: s.com }, { cat: 'voice_grunt', loud: 0.9, pos: seg('head') });
      if (dive === 'flight') tr.flightAt = t;
      if (a.cmd.thrustHips && !tr.thrust) out.push({ cat: 'voice_grunt', loud: 0.8, pos: seg('head') });
      if (down && t - tr.downAt > FALL_GAP) out.push({ cat: t - tr.flightAt < 1 ? 'body_dive_land' : 'body_turf_tackle', loud: clamp01(0.3 + Math.hypot(vx, s.comVel[1], vz) / 6), pos: s.com });
      if (down && speed > SLIDE_SPEED) out.push({ cat: 'body_turf_slide', loud: clamp01(speed / 6), pos: s.com });
      if (clip === 'getup' && tr.clip !== 'getup') out.push({ cat: 'body_getup', loud: 0.8, pos: s.com });

      // breathing hard: an exhale every couple of seconds at a sprint
      if (a.cmd.gait === 'sprint' && speed > SPRINT_STEP && !down && (tr.breathIn -= dt) <= 0) {
        out.push({ cat: 'voice_exhale', loud: 0.7, pos: seg('head') });
        tr.breathIn = this.rng.range(1.2, 2.6);
      }
      if (a.injury.out && down && t >= tr.moanAt) { out.push({ cat: 'pain_moan', loud: 0.8, pos: seg('head') }); tr.moanAt = t + this.rng.range(...MOAN.every); }
      if (down) tr.downAt = t;
      Object.assign(tr, { clip, dive, thrust: a.cmd.thrustHips });
    });

    // injuries: the break cracks at the joint and he screams; a knockout lands with a thud and a ringing; then moans
    for (const e of w.injuries.slice(this.injuriesSeen)) {
      const s = w.scene.athletes[e.athlete].state, hi = w.athletes[e.athlete].segIndex.get('head') ?? 0, head: Vec3 = [s.segPos[3 * hi], s.segPos[3 * hi + 1], s.segPos[3 * hi + 2]];
      if (e.kind === 'break') out.push({ cat: 'bone_crack', loud: clamp01(0.7 + e.load / 2000), pos: e.pos }, { cat: 'pain_scream', loud: 1, pos: head });
      else out.push({ cat: 'ko_thud', loud: 1, pos: head }, { cat: 'ko_ring', loud: 0.7, pos: head });
      const tr = this.tr[e.athlete];
      if (tr) tr.moanAt = Math.min(tr.moanAt, t + (e.kind === 'ko' ? MOAN.afterKo : MOAN.after));
    }
    this.injuriesSeen = w.injuries.length;

    // the ball: held while the ball carrier's hand grips it (attached at rep start and on a recovery)
    const held = w.ballCarrier >= 0 && w.gripping(w.ballCarrier, { athlete: -1, seg: this.ball }) >= 0;
    // impact speed: the ball's velocity the step before the touch
    const bp = w.scene.propPose(this.ball).pos, bv = this.ballVel, bs = Math.hypot(bv[0], bv[1], bv[2]);
    if (held && !this.ballHeld) out.push({ cat: 'ball_catch', loud: 0.8, pos: bp });
    for (const c of w.scene.contacts()) for (const [p, o] of [[c.a, c.b], [c.b, c.a]]) {
      if (p.athlete >= 0 || p.seg !== this.ball || (o.athlete < 0 && o.seg >= 0)) continue;
      const k = o.athlete;
      if (!held && bs > 0.7 && t - (this.ballAt.get(k) ?? -Infinity) > BALL_GAP)
        out.push(k < 0 ? { cat: 'ball_bounce', loud: clamp01(bs / 7), pos: bp } : { cat: 'ball_hit_body', loud: clamp01(bs / 6), pos: bp });
      this.ballAt.set(k, t);
    }
    this.ballVel = w.scene.propVel(this.ball); this.ballHeld = held;
    return out;
  }
}
