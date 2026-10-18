import { HUMANOID } from './humanoid';
import { hashWorld, hingeAxisWorld, jointError, torqueDriver, type BenchEngine, type Placement } from './common';

const NB = HUMANOID.bodies.length;
const finite = (x: number) => Number.isFinite(x);

function worst(w: ReturnType<BenchEngine['create']>) {
  let err = 0, speed = 0, ok = true;
  for (let h = 0; h < w.nHumanoids; h++) {
    err = Math.max(err, jointError(w, h));
    for (let b = 0; b < NB; b++) { const s = w.speed(h, b); speed = Math.max(speed, s); if (!finite(s)) ok = false; }
  }
  return { err, speed, ok: ok && finite(err) };
}

/** One humanoid on the ground under strong random joint torques for 5 s. */
export function torqueStability(e: BenchEngine, hz = 240) {
  const w = e.create({ hz, ccd: false, humanoids: [{ offset: [0, 0, 0], yaw: 0 }] });
  const drive = torqueDriver(1, hz, 1);
  let maxErr = 0, maxSpeed = 0, ok = true;
  for (let i = 0; i < hz * 5; i++) {
    drive(w, (h, j) => hingeAxisWorld(w, h, j));
    w.step();
    const r = worst(w);
    maxErr = Math.max(maxErr, r.err); maxSpeed = Math.max(maxSpeed, r.speed); ok &&= r.ok;
  }
  w.destroy();
  return { maxJointErrCm: maxErr * 100, maxSegmentSpeed: maxSpeed, stable: ok && maxSpeed < 50 };
}

/** Two 100 kg humanoids running into each other at 10 m/s each (20 m/s closing), chest to chest. */
export function collision(e: BenchEngine, hz = 240) {
  const hs: Placement[] = [{ offset: [0, 0, -0.6], yaw: 0 }, { offset: [0, 0, 0.6], yaw: Math.PI }];
  const w = e.create({ hz, ccd: true, humanoids: hs });
  w.setLinVel(0, [0, 0, 10]); w.setLinVel(1, [0, 0, -10]);
  let maxErr = 0, peakF = 0, late = 0, ok = true;
  for (let i = 0; i < hz * 1.5; i++) {
    w.step();
    const r = worst(w);
    maxErr = Math.max(maxErr, r.err); ok &&= r.ok;
    if (i > hz * 0.5) late = Math.max(late, r.speed);
    peakF = Math.max(peakF, w.interHumanoidForce());
  }
  w.destroy();
  return { maxJointErrCm: maxErr * 100, peakContactForceN: peakF, maxSpeedAfter0p5s: late, stable: ok && late < 15 };
}

const PERF: Placement[] = [-0.7, 0, 0.7].map((x) => ({ offset: [x, 0, 0], yaw: x * 2 }));

/** Three humanoids packed together under random torques. Returns wall ms per simulated second. */
export function perf(e: BenchEngine, hz: number, seconds = 3, now = () => performance.now()) {
  const w = e.create({ hz, ccd: true, humanoids: PERF });
  const drive = torqueDriver(7, hz, 3);
  const steps = Math.round(hz * seconds);
  for (let i = 0; i < hz * 0.2; i++) { drive(w, (h, j) => hingeAxisWorld(w, h, j)); w.step(); } // warm-up
  const t0 = now();
  for (let i = 0; i < steps; i++) { drive(w, (h, j) => hingeAxisWorld(w, h, j)); w.step(); }
  const ms = now() - t0;
  w.destroy();
  return { hz, msPerSimSecond: (ms / seconds), msPerStep: ms / steps };
}

export function determinism(e: BenchEngine, hz = 240) {
  const run = () => {
    const w = e.create({ hz, ccd: true, humanoids: PERF });
    const drive = torqueDriver(11, hz, 3);
    for (let i = 0; i < hz * 2; i++) { drive(w, (h, j) => hingeAxisWorld(w, h, j)); w.step(); }
    const hsh = hashWorld(w);
    w.destroy();
    return hsh;
  };
  const a = run(), b = run();
  return { hashA: a, hashB: b, identical: a === b };
}

export function features(e: BenchEngine, hz = 240) {
  return {
    restingForceN_expect981: e.restingForce(hz),
    tunnelsWithoutCcd: e.tunnels(hz, false),
    tunnelsWithCcd: e.tunnels(hz, true),
    motorSagRad_limit30Nm_needs49: e.motorSag(hz, 30),
    motorSagRad_limit80Nm: e.motorSag(hz, 80),
  };
}
