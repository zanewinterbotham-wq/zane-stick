import { describe, expect, it } from 'vitest';
import { buildBody, DEFAULT_ATHLETE, type Detail } from '../src/sim/anatomy/body';
import { legFK, legIK } from '../src/sim/anim/ik';
import { forwardKinematics, rootQuat } from '../src/sim/anim/kinematics';
import { kinematicRig } from '../src/sim/anim/rig';
import { neutralCommands, type Commands } from '../src/sim/control/types';
import { MuscleSet } from '../src/sim/muscles';

type Rig = ReturnType<typeof kinematicRig>;
const DT = 1 / 240;
const DETAILS: Detail[] = ['standard', 'minimum'];

/** Run a command script with the body following the root target exactly (ideal support). */
function run(r: Rig, seconds: number, script: (t: number, c: Commands) => void, each?: (t: number) => void, t0 = 0) {
  let body: [number, number] = [r.frame.root.vel[0], r.frame.root.vel[2]];
  for (let t = t0; t < t0 + seconds - 1e-9; t += DT) {
    Object.assign(r.cmd, neutralCommands());
    script(t, r.cmd);
    r.step(body);
    body = r.support.down ? [0, 0] : [r.frame.root.vel[0], r.frame.root.vel[2]];
    each?.(t);
  }
}

/** Gait measurements with the body held at ground speed v (m/s) along +Z. */
function gait(detail: Detail, v: number, seconds = 6) {
  const r = kinematicRig(detail);
  r.cmd.move = { x: 0, z: v > 0 ? 1 : 0 }; r.cmd.gait = 'sprint';
  const prev: ({ heel: number[]; ball: number[] } | null)[] = [null, null], was = [true, true];
  let slipMax = 0, slipSum = 0, n = 0, pivotY = 0, touchdowns = 0, flight = 0, steps = 0, swingMinY = Infinity;
  for (let i = 0; i < 240 * (seconds + 1); i++) {
    r.step([0, v]);
    const meas = i >= 240;
    if (meas) { steps++; if (!r.frame.planted[0] && !r.frame.planted[1]) flight++; }
    for (const k of [0, 1] as const) {
      const f = r.foot(k);
      if (meas && r.frame.planted[k]) {
        if (!was[k]) touchdowns++;
        else if (prev[k]) {
          // the planted pivot (heel or ball, whichever the foot rolls about) must not move
          const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]) / DT;
          const s = Math.min(d(f.heel, prev[k]!.heel), d(f.ball, prev[k]!.ball));
          slipMax = Math.max(slipMax, s); slipSum += s; n++;
          pivotY = Math.max(pivotY, Math.abs(Math.min(f.heel[1], f.ball[1])));
        }
      } else if (meas) swingMinY = Math.min(swingMinY, f.heel[1], f.ball[1]);
      prev[k] = f; was[k] = r.frame.planted[k];
    }
  }
  return { slipMax, slipMean: slipSum / Math.max(1, n), pivotY, cadence: touchdowns / seconds, flight: flight / steps, swingMinY };
}

describe('leg IK', () => {
  it('round-trips through its forward kinematics', () => {
    let worst = 0;
    for (const side of [1, -1] as const) for (const flex of [-0.3, 0.3, 1.1]) for (const abd of [-0.3, 0.2, 0.6]) for (const knee of [0.2, 1.0, 2.0]) for (const rot of [-0.5, 0, 0.5]) {
      const L = { side, L1: 0.435, L2: 0.454 };
      const p = legFK(L, flex, abd, knee, rot);
      const [f, a, k] = legIK(L, p, rot);
      const q = legFK(L, f, a, k, rot);
      worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    expect(worst).toBeLessThan(0.005);
  });

  it('matches the body plan’s own joint axes (so IK targets land where the physics puts the foot)', () => {
    for (const detail of DETAILS) {
      const plan = buildBody(DEFAULT_ATHLETE, detail), ms = new MuscleSet(plan);
      for (const sx of ['L', 'R'] as const) {
        const side = sx === 'L' ? 1 : -1;
        const hip = plan.joints.find((j) => j.name === 'hip' + sx)!, knee = plan.joints.find((j) => j.name === 'knee' + sx)!, ank = plan.joints.find((j) => j.name === 'ankle' + sx)!;
        const L = { side: side as 1 | -1, L1: hip.pos[1] - knee.pos[1], L2: knee.pos[1] - ank.pos[1] };
        const q = new Float64Array(ms.n);
        const set = (n: string, v: number) => { q[ms.index(n)] = v; };
        set(`hip${sx}.flex`, 0.7); set(`hip${sx}.abd`, 0.25); set(`hip${sx}.intRot`, 0.3); set(`knee${sx}.flex`, 1.1);
        const pose = forwardKinematics(plan, q, [0, plan.standHeight, 0], rootQuat(0, 0, 0));
        const a = pose.pos[plan.segments.findIndex((s) => s.name === 'foot' + sx)];
        const h = pose.pos[plan.segments.findIndex((s) => s.name === 'thigh' + sx)];
        const p = legFK(L, 0.7, 0.25, 1.1, 0.3);
        expect(Math.hypot(a[0] - h[0] - p[0], a[1] - h[1] - p[1], a[2] - h[2] - p[2])).toBeLessThan(1e-9);
      }
    }
  });
});

describe('procedural animator', () => {
  const scripts: [string, (t: number, c: Commands) => void][] = [
    ['idle', () => {}],
    ['walk', (_t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'walk'; }],
    ['jog diagonal', (_t, c) => { c.move = { x: 0.7, z: 0.7 }; c.gait = 'jog'; }],
    ['sprint', (_t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; }],
    ['sprint turning', (t, c) => { c.move = { x: Math.sin(2 * t), z: Math.cos(2 * t) }; c.gait = 'sprint'; }],
    ['backpedal', (_t, c) => { c.face = { x: 0, z: 1 }; c.move = { x: 0, z: -1 }; c.gait = 'sprint'; }],
    ['shuffle', (_t, c) => { c.face = { x: 0, z: 1 }; c.move = { x: -1, z: 0 }; c.gait = 'jog'; }],
    ['cut', (t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; c.plantCut = t > 1 && t < 1.1 ? -1 : 0; }],
    ['stance deep', (_t, c) => { c.contactMode = true; c.sink = 1; }],
    ['contact overlays', (t, c) => {
      c.contactMode = true; c.sink = 0.5; c.armL = 1; c.armR = 0.5; c.wrap = t > 0.5; c.shoot = t > 1; c.thrustHips = t > 0.8; c.driveLegs = 1;
      c.lean = { fwd: 1, side: -1 }; c.headTuck = true; c.move = { x: 0, z: 0.4 }; c.aim = [0.5, 1.5, 2];
    }],
    ['chop + carry', (_t, c) => { c.chopFeet = true; c.carry = 2; c.move = { x: 0.2, z: 0.3 }; }],
    ['dive', (t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; c.dive = t > 1; }],
    ['jump', (t, c) => { c.jump = t > 0.3 && t < 0.4; c.armL = 1; c.aim = [0, 3, 1]; }],
    ['running jump', (t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; c.jump = t > 1; }],
  ];

  it('keeps every target inside the joint limits and every gain in 0..1, at both detail levels', () => {
    for (const detail of DETAILS) for (const [name, script] of scripts) {
      const r = kinematicRig(detail), { lo, hi } = r.muscles;
      let bad = '';
      run(r, 2, script, (t) => {
        for (let i = 0; i < r.muscles.n; i++) {
          const q = r.frame.q[i], g = r.frame.gain[i];
          if (!(q >= lo[i] - 1e-9 && q <= hi[i] + 1e-9) || !(g >= 0 && g <= 1) || !Number.isFinite(r.frame.qd[i])) bad ||= `${detail} ${name} t=${t.toFixed(3)} ${r.muscles.names[i]} q=${q}`;
        }
        const R = r.frame.root;
        if (![R.height, R.heading, R.pitch, R.roll, R.vel[0], R.vel[2]].every(Number.isFinite)) bad ||= `${detail} ${name} root not finite`;
      });
      expect(bad).toBe('');
    }
  });

  it('is deterministic: the same inputs give bit-identical frames', () => {
    const frames = [0, 1].map(() => {
      const r = kinematicRig(), out: number[] = [];
      run(r, 1.5, scripts[9][1], () => out.push(...r.frame.q, r.frame.root.height, r.frame.root.vel[2]));
      return out;
    });
    expect(frames[0]).toEqual(frames[1]);
  });

  it('is continuous through clip changes (no pops), from idle through sprint, cut, backpedal, shuffle, stance, contact, dive, down and get-up', () => {
    for (const detail of DETAILS) {
      const r = kinematicRig(detail), ms = r.muscles;
      const prev = new Float64Array(ms.n), prevRoot = [0, 0, 0];
      const clips: string[] = [];
      let worst = 0, worstRoot = 0, first = true;
      run(r, 17, (t, c) => {
        if (t > 1 && t < 4.5) { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; }
        if (t > 3.5 && t < 3.6) c.plantCut = 1;
        if (t > 4.5 && t < 6) { c.face = { x: 0, z: 1 }; c.move = { x: 0, z: -1 }; c.gait = 'jog'; }
        if (t > 6 && t < 7.5) { c.face = { x: 0, z: 1 }; c.move = { x: 1, z: 0 }; c.gait = 'jog'; }
        if (t > 7.5 && t < 10) { c.contactMode = true; c.sink = 0.7; }
        if (t > 9 && t < 10) { c.armL = 1; c.armR = t > 9.3 ? 1 : 0; c.wrap = t > 9.5; c.shoot = t > 9.7; c.headTuck = true; c.driveLegs = t > 9.6 ? 1 : 0; c.thrustHips = t > 9.8; c.move = { x: 0, z: 0.3 }; }
        if (t > 10 && t < 11.5) { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; c.carry = 1; c.chopFeet = t < 10.4; }
        if (t > 11.2 && t < 11.6) c.dive = true;
        r.support.down = t > 11.6 && t < 13.2;
        // lying still on the turf while down (the kinematic rig would otherwise follow the root target)
        r.lie.on = t > 11.6 && t < 12.2; r.lie.quat = rootQuat(r.frame.root.heading, Math.PI / 2, 0);
      }, () => {
        if (clips[clips.length - 1] !== r.frame.clip) clips.push(r.frame.clip);
        if (!first) {
          for (let i = 0; i < ms.n; i++) worst = Math.max(worst, Math.abs(r.frame.q[i] - prev[i]) / (ms.wMax[i] * DT));
          const R = r.frame.root;
          worstRoot = Math.max(worstRoot, Math.abs(R.height - prevRoot[0]), Math.abs(R.pitch - prevRoot[1]), Math.abs(R.roll - prevRoot[2]));
        }
        first = false;
        prev.set(r.frame.q); prevRoot[0] = r.frame.root.height; prevRoot[1] = r.frame.root.pitch; prevRoot[2] = r.frame.root.roll;
      });
      for (const c of ['idle', 'walk', 'run', 'cut', 'backpedal', 'shuffle', 'stance', 'chop', 'dive', 'down', 'getup']) expect(clips).toContain(c);
      expect(clips[clips.length - 1]).toBe('idle');
      // a target never moves more than a few times what the muscle's top speed covers in one step
      expect(worst).toBeLessThan(4);
      expect(worstRoot).toBeLessThan(0.05);
    }
  });

  it('keeps the stance foot still on the turf (no foot sliding) at 2, 5 and 9 m/s', () => {
    for (const detail of DETAILS) for (const v of [2, 5, 9]) {
      const g = gait(detail, v, 4);
      expect(g.slipMean, `${detail} ${v} m/s mean slip`).toBeLessThan(0.02 * v);
      expect(g.slipMax, `${detail} ${v} m/s max slip`).toBeLessThan(0.05 * v);
      expect(g.pivotY, `${detail} ${v} m/s pivot height`).toBeLessThan(0.01);
      expect(g.swingMinY, `${detail} ${v} m/s swing clearance`).toBeGreaterThan(-0.01);
    }
  });

  it('follows sprint biomechanics: cadence, flight phase and stride from walk to 10 m/s', () => {
    const walk = gait('standard', 1.6), jog = gait('standard', 5), sprint = gait('standard', 10);
    expect(walk.cadence).toBeGreaterThan(1.6); expect(walk.cadence).toBeLessThan(2.2);
    expect(walk.flight).toBe(0);
    expect(jog.flight).toBeGreaterThan(0.2);
    expect(sprint.cadence).toBeGreaterThan(4.2); expect(sprint.cadence).toBeLessThan(5.0);
    expect(sprint.cadence).toBeGreaterThan(jog.cadence);
  });

  it('runs on legs that bend like a runner’s: knee ~20° at touchdown, 35–50° at most in stance, the hips bobbing 3–6 cm', () => {
    for (const v of [4, 7, 10]) {
      const r = kinematicRig(), kn = r.muscles.index('kneeL.flex'), deg = 180 / Math.PI;
      r.cmd.move = { x: 0, z: 1 }; r.cmd.gait = v < 4.3 ? 'jog' : 'sprint';
      let was = true, td: number[] = [], st = 0, hi = 0, lo = 9;
      for (let i = 0; i < 240 * 5; i++) {
        r.step([0, v]);
        if (i < 240 * 3) continue;
        const p = r.frame.planted[0], q = r.frame.q[kn] * deg;
        if (p && !was) td.push(q);
        if (p) st = Math.max(st, q);
        hi = Math.max(hi, r.frame.root.height); lo = Math.min(lo, r.frame.root.height);
        was = p;
      }
      const tdMean = td.reduce((a, b) => a + b, 0) / td.length;
      expect(tdMean, `${v} m/s touchdown knee`).toBeGreaterThan(12); expect(tdMean).toBeLessThan(30);
      expect(st, `${v} m/s stance knee`).toBeGreaterThan(35); expect(st).toBeLessThan(50);
      expect(hi - lo, `${v} m/s bob`).toBeGreaterThan(0.03); expect(hi - lo).toBeLessThan(0.06);
    }
  });

  it('sinks fast: the hips reach 90 % of a full sink in ~0.25 s (no faster than a fall), and rise out of it more slowly', () => {
    const r = kinematicRig();
    run(r, 1, () => {});
    const h0 = r.frame.root.height, down: number[] = [], up: number[] = [];
    run(r, 1, (_t, c) => { c.contactMode = true; c.sink = 1; }, () => down.push(h0 - r.frame.root.height), 1);
    const depth = down[down.length - 1], t90 = down.findIndex((d) => d >= 0.9 * depth) * DT;
    expect(depth).toBeGreaterThan(0.25);
    expect(t90).toBeLessThan(0.28);
    // the hips never drop faster than free fall from rest would take them
    expect(down.every((d, k) => d <= 0.5 * 9.81 * ((k + 1) * DT) ** 2 + 1e-3)).toBe(true);
    run(r, 1, () => {}, () => up.push(r.frame.root.height), 2);
    expect(up.findIndex((h) => h - (h0 - depth) >= 0.9 * depth) * DT).toBeGreaterThan(t90);
  });

  it('a full forward lean brings the trunk level with the turf, hips back and down on bent knees; half a lean is in between', () => {
    const lean = (fwd: number) => {
      const r = kinematicRig(), i = (n: string) => r.muscles.index(n);
      run(r, 1.5, (_t, c) => { c.contactMode = true; c.lean = { fwd, side: 0 }; });
      return { pitch: r.frame.root.pitch, drop: r.plan.standHeight - r.frame.root.height, knee: r.frame.q[i('kneeL.flex')], spine: r.frame.q[i('lumbar.flex')] + r.frame.q[i('thoracic.flex')] };
    };
    const none = lean(0), half = lean(0.5), full = lean(1);
    expect(full.pitch).toBeGreaterThan(1.4);                 // ~83°: shoulders level with the hips
    expect(full.drop).toBeGreaterThan(0.15);
    expect(full.knee).toBeGreaterThan(0.9);
    expect(full.spine).toBeGreaterThan(0.6 * full.pitch);    // the pelvis turns through only part of the lean
    expect(half.pitch).toBeGreaterThan(none.pitch + 0.1); expect(half.pitch).toBeLessThan(full.pitch - 0.5);
  });

  it('accelerates the root target like a sprinter to ~10 m/s and turns at a bounded rate', () => {
    const r = kinematicRig();
    let peakA = 0, prevV = 0, t10 = NaN, prevH = 0, peakTurn = 0;
    run(r, 4, (t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; if (t > 3) c.move = { x: 1, z: 0 }; }, (t) => {
      const v = Math.hypot(r.frame.root.vel[0], r.frame.root.vel[2]);
      if (t < 3) peakA = Math.max(peakA, (v - prevV) / DT);
      if (Number.isNaN(t10) && v >= 10) t10 = t;
      if (t > 0) peakTurn = Math.max(peakTurn, Math.abs(Math.atan2(Math.sin(r.frame.root.heading - prevH), Math.cos(r.frame.root.heading - prevH))) / DT);
      prevV = v; prevH = r.frame.root.heading;
    });
    expect(peakA).toBeLessThan(7.01);
    expect(peakA).toBeGreaterThan(6);
    expect(t10).toBeLessThan(2);
    expect(peakTurn).toBeLessThan(12.01);
    expect(peakTurn).toBeGreaterThan(11);
    // root target at speed 1.0: the sprint gait speed
    const top = kinematicRig();
    run(top, 3, (_t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; });
    expect(top.frame.root.vel[2]).toBeGreaterThan(10);
    expect(top.frame.clip).toBe('run');
  });

  it('plants and cuts: the velocity turns sharply toward the cut and the body leans into it', () => {
    const r = kinematicRig();
    let minRoll = 0;
    run(r, 3, (_t, c) => { c.move = { x: 0, z: 0.6 }; c.gait = 'sprint'; }); // ~6 m/s
    run(r, 0.5, (t, c) => { c.move = { x: 0, z: 0.6 }; c.gait = 'sprint'; c.plantCut = t < 3.1 ? -1 : 0; }, () => { minRoll = Math.min(minRoll, r.frame.root.roll); }, 3);
    const dir = Math.atan2(r.frame.root.vel[0], r.frame.root.vel[2]);
    expect(dir).toBeLessThan(-0.8);       // cut right = toward −X
    expect(minRoll).toBeLessThan(-0.2);   // leaning right
  });

  it('gets up the right way for face down and face up', () => {
    for (const faceDown of [true, false]) {
      const r = kinematicRig();
      r.lie.on = true; r.lie.quat = rootQuat(0, faceDown ? Math.PI / 2 : -Math.PI / 2, 0);
      const clips: string[] = [];
      let pitchAt = NaN;
      run(r, 4, (t) => { r.support.down = t < 0.8; r.lie.on = t < 0.6; }, (t) => {
        if (clips[clips.length - 1] !== r.frame.clip) clips.push(r.frame.clip);
        if (r.frame.clip === 'getup' && Number.isNaN(pitchAt) && r.frame.phase >= 0.3) pitchAt = r.frame.root.pitch;
        void t;
      });
      expect(clips).toEqual(['down', 'getup', 'idle']);
      // pushed up on the hands (trunk still leaning far forward) vs sitting up (trunk near upright)
      if (faceDown) expect(pitchAt).toBeGreaterThan(0.8); else expect(pitchAt).toBeLessThan(0.6);
      expect(r.frame.planted).toEqual([true, true]);
      expect(r.frame.root.height).toBeGreaterThan(r.plan.standHeight - 0.05);
    }
  });

  it('dives on the press: load, launch, flight; holding the button changes nothing', () => {
    const runs = [0.05, 2].map((hold) => {
      const r = kinematicRig(), out: number[] = [], stages: string[] = [];
      run(r, 2.5, (t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; c.dive = t > 1 && t < 1 + hold; }, () => {
        out.push(...r.frame.q, r.frame.root.height, r.frame.root.pitch, r.frame.root.vel[1]);
        if (stages[stages.length - 1] !== r.frame.root.dive) stages.push(r.frame.root.dive);
      });
      return { out, stages };
    });
    expect(runs[0].stages).toEqual(['none', 'load', 'launch', 'flight']);
    expect(runs[1].out).toEqual(runs[0].out);
  });

  it('one press runs a whole hip thrust: upright it rises onto the balls of the feet, from lowered pads it keeps their angle and the hips low; the arms cock back so the pads lead; holding changes nothing', () => {
    const sunk = (c: Commands) => { c.contactMode = true; c.sink = 1; c.lean.fwd = 1; };
    const press = (hold: number, low: boolean) => {
      const r = kinematicRig(), i = (n: string) => r.muscles.index(n), out: number[] = [];
      run(r, 1, (_t, c) => { if (low) sunk(c); });
      const at = { h0: r.frame.root.height, p0: r.frame.root.pitch, k0: r.frame.q[i('kneeL.flex')], thrust: 0, h: 0, p: 0, k: 0, sh: 0 };
      run(r, 2, (t, c) => { if (low) sunk(c); c.thrustHips = t < 1 + hold; }, (t) => {
        out.push(...r.frame.q, r.frame.root.height, r.frame.root.vel[2]);
        // late in the thrust: the lunge is over and the hips have extended
        if (Math.abs(t - 1.75) < DT / 2) Object.assign(at, { thrust: r.frame.root.thrust, h: r.frame.root.height, p: r.frame.root.pitch, k: r.frame.q[i('kneeL.flex')], sh: r.frame.q[i('shoulderL.flex')] });
      }, 1);
      return { ...at, end: r.frame.root.thrust, out, stand: r.plan.standHeight };
    };
    const up = press(0.05, false), tap = press(0.05, true), held = press(2, true);
    console.log('thrust upright', { h: up.h, p: up.p }, 'from lowered pads', { h0: tap.h0, h: tap.h, p0: tap.p0, p: tap.p, k0: tap.k0, k: tap.k, sh: tap.sh, stand: tap.stand });
    expect(up.h).toBeGreaterThan(up.stand);      // upright: up on the balls of the feet, as before
    expect(up.p).toBeLessThan(0.2);
    expect(tap.thrust).toBeGreaterThan(0.95);
    expect(tap.h).toBeGreaterThan(tap.h0 + 0.1); // the hips extend out of the crouch...
    expect(tap.h).toBeLessThan(tap.stand - 0.1); // ...but stay low behind the pads
    expect(tap.p).toBeGreaterThan(0.45);         // the trunk keeps the pads' angle (capped, rising a little)
    expect(tap.k).toBeLessThan(tap.k0 - 0.3);
    expect(tap.sh).toBeLessThan(0);              // arms cocked back, out of the hit
    expect(tap.end).toBeLessThan(0.05);          // over by itself
    expect(held.out).toEqual(tap.out);
  });

  it('a dive launches along the way the player steers, not the way he was running', () => {
    const r = kinematicRig();
    let dir = NaN;
    run(r, 2, (t, c) => { c.gait = 'sprint'; c.move = t < 1 ? { x: 0, z: 1 } : { x: 1, z: 0 }; c.dive = t >= 1; }, () => {
      if (Number.isNaN(dir) && r.frame.root.dive === 'launch') dir = Math.atan2(r.frame.root.vel[0], r.frame.root.vel[2]);
    });
    expect(dir).toBeCloseTo(Math.PI / 2, 1);
  });

  it('layers contact overlays on the arms and relaxes the arms while running', () => {
    const r = kinematicRig(), i = (n: string) => r.muscles.index(n);
    run(r, 2, (_t, c) => { c.move = { x: 0, z: 1 }; c.gait = 'sprint'; });
    expect(r.frame.gain[i('shoulderL.flex')]).toBeCloseTo(0.5, 2);
    run(r, 1, (_t, c) => { c.contactMode = true; c.armL = 1; c.carry = 2; });
    expect(r.frame.q[i('shoulderL.flex')]).toBeGreaterThan(1.3);   // reaching forward
    expect(r.frame.q[i('elbowL.flex')]).toBeLessThan(0.4);
    expect(r.frame.q[i('elbowR.flex')]).toBeGreaterThan(1.8);      // ball tucked
    expect(r.frame.gain[i('shoulderL.flex')]).toBeCloseTo(1, 3);
    run(r, 1, (_t, c) => { c.contactMode = true; c.wrap = true; });
    expect(r.frame.q[i('shoulderR.intRot')]).toBeGreaterThan(0.7);
  });
});
