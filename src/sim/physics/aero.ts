// The ball's air loads [S5]: drag along the flow with a coefficient set by the angle between the ball's long axis and
// the flow, and a spiral's stability (its nose follows the flight). Applied to the MuJoCo ball body while it is loose;
// the rest is physics. Also the aim a passer or kicker takes so the ball still gets there through the air.
import { BALL, BALL_AERO } from '../anatomy/equipment';
import type { Vec3 } from '../math';

const G = 9.81;
/** Largest cross-section (m²) and the inertia about the long axis of the prolate ellipsoid (kg·m²). */
export const BALL_AREA = Math.PI * (BALL.diameter / 2) ** 2;
const I_AXIAL = BALL.mass / 5 * 2 * (BALL.diameter / 2) ** 2;

/** Drag coefficient for flow at angle α to the long axis, given cos α: from nose-on to side-on by sin²α. */
export const dragCd = (cosA: number) => BALL_AERO.cdNose + (BALL_AERO.cdSide - BALL_AERO.cdNose) * (1 - cosA * cosA);

/** Air loads on the ball (world frame, N and N·m) for its velocity, long axis (unit) and angular velocity. `free`:
 *  nothing touches it (only then does a spiral's nose turn onto the flight). */
export function ballAir(vel: Vec3, axis: Vec3, spin: Vec3, free: boolean): { force: Vec3; torque: Vec3 } {
  const v = Math.hypot(vel[0], vel[1], vel[2]), torque: Vec3 = [0, 0, 0];
  if (v < 1e-6) return { force: [0, 0, 0], torque };
  const c = (axis[0] * vel[0] + axis[1] * vel[1] + axis[2] * vel[2]) / v;
  const k = 0.5 * BALL_AERO.rho * dragCd(c) * BALL_AREA * v;
  // A spiral: the air's overturning moment on a spinning ball precesses its nose around the flight, which keeps it
  // pointed along a curving path (the yaw of repose). Modelled as the torque that turns its spin's angular momentum
  // toward the flight direction (whichever end leads) at BALL_AERO.follow × the angle between them.
  const ws = spin[0] * axis[0] + spin[1] * axis[1] + spin[2] * axis[2];
  if (free && Math.abs(ws) > BALL_AERO.spiral) {
    const s = Math.sign(c) || 1, L = I_AXIAL * ws * BALL_AERO.follow;
    for (let i = 0; i < 3; i++) torque[i] = L * (s * vel[i] / v - Math.abs(c) * axis[i]);
  }
  return { force: [-k * vel[0], -k * vel[1], -k * vel[2]], torque };
}

/** Where a point ball with drag coefficient `cd` launched at `vel` from `from` is after `T` s (semi-implicit Euler at
 *  `dt`, as the physics steps). */
export function flyWithDrag(from: Vec3, vel: Vec3, T: number, cd: number, dt = 1 / 240): Vec3 {
  const p: Vec3 = [from[0], from[1], from[2]], v: Vec3 = [vel[0], vel[1], vel[2]], kk = 0.5 * BALL_AERO.rho * cd * BALL_AREA / BALL.mass;
  const n = Math.max(1, Math.round(T / dt)), h = T / n;
  for (let s = 0; s < n; s++) {
    const sp = Math.hypot(v[0], v[1], v[2]);
    v[0] -= kk * sp * v[0] * h; v[1] -= (G + kk * sp * v[1]) * h; v[2] -= kk * sp * v[2] * h;
    p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;
  }
  return p;
}

/** The launch velocity that, through the air (drag coefficient `cd`), puts the ball where `vel` would put it in a
 *  vacuum after `T` s: a passer or kicker aims for the air he throws through (the planned flight time stays). */
export function aimThroughAir(from: Vec3, vel: Vec3, T: number, cd: number): Vec3 {
  if (!(T > 0)) return [vel[0], vel[1], vel[2]];
  const want: Vec3 = [from[0] + vel[0] * T, from[1] + vel[1] * T - G * T * T / 2, from[2] + vel[2] * T];
  const v: Vec3 = [vel[0], vel[1], vel[2]];
  for (let it = 0; it < 12; it++) {
    const p = flyWithDrag(from, v, T, cd);
    const e = [want[0] - p[0], want[1] - p[1], want[2] - p[2]];
    if (Math.hypot(e[0], e[1], e[2]) < 1e-3) break;
    for (let i = 0; i < 3; i++) v[i] += e[i] / T;
  }
  return v;
}
