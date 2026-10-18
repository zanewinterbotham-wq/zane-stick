// Kinematic stand-in for the physics when testing the animator: the body reaches every pose exactly and the
// pelvis moves where the root target says, at a prescribed ground velocity. No MuJoCo needed.
import { buildBody, DEFAULT_ATHLETE, type Detail } from '../anatomy/body';
import { newFrame, type AnimFrame, type SupportState } from './types';
import { forwardKinematics, pointOn, rootQuat, type Pose } from './kinematics';
import { ProceduralAnimator } from './procedural';
import type { AthleteState } from '../physics/engine';
import { neutralCommands, type BodyView, type Commands } from '../control/types';
import { MuscleSet } from '../muscles';
import type { Quat, Vec3 } from '../math';

export function kinematicRig(detail: Detail = 'standard', dt = 1 / 240) {
  const plan = buildBody(DEFAULT_ATHLETE, detail), muscles = new MuscleSet(plan);
  const nS = plan.segments.length, n = muscles.n;
  const state: AthleteState = {
    q: new Float64Array(n), qd: new Float64Array(n), segPos: new Float64Array(3 * nS), segQuat: new Float64Array(4 * nS),
    segCom: new Float64Array(3 * nS), segVel: new Float64Array(3 * nS), segAngVel: new Float64Array(3 * nS),
    dofAxis: new Float64Array(3 * n), dofAnchor: new Float64Array(3 * n), com: [0, 1, 0], comVel: [0, 0, 0],
  };
  const view: BodyView = { plan, muscles, state, dt, time: 0, feet: [{ force: 0, cop: [0, 0, 0], touching: true }, { force: 0, cop: [0, 0, 0], touching: true }], playerContact: false };
  const anim = new ProceduralAnimator(plan, muscles);
  const frame: AnimFrame = newFrame(n);
  const support: SupportState = { posture: 1, carry: 1, down: false };
  const cmd: Commands = neutralCommands();
  const pelvis: Vec3 = [0, plan.standHeight, 0];
  /** Set to hold the pelvis at a fixed height and orientation (a body lying on the turf). */
  const lie: { on: boolean; height: number; quat: Quat } = { on: false, height: 0.12, quat: [0, 0, 0, 1] };
  let pose: Pose = forwardKinematics(plan, state.q, pelvis, rootQuat(0, 0, 0));
  const writePose = () => {
    pose = lie.on
      ? forwardKinematics(plan, frame.q, [pelvis[0], lie.height, pelvis[2]], lie.quat)
      : forwardKinematics(plan, frame.q, [pelvis[0], frame.root.height, pelvis[2]], rootQuat(frame.root.heading, frame.root.pitch, frame.root.roll));
    pose.pos.forEach((p, i) => { state.segPos.set(p, 3 * i); state.segQuat.set(pose.quat[i], 4 * i); });
    state.q.set(frame.q);
  };
  writePose();
  return {
    plan, muscles, anim, frame, cmd, support, state, pelvis, lie,
    get pose() { return pose; },
    /** One step with the body moving at ground velocity `vel` (world x, z). */
    step(vel: [number, number]) {
      state.comVel[0] = vel[0]; state.comVel[2] = vel[1];
      anim.update(view, cmd, support, frame);
      pelvis[0] += vel[0] * dt; pelvis[2] += vel[1] * dt;
      view.time += dt;
      writePose();
    },
    /** World positions of the heel and ball of a foot (0 left, 1 right). */
    foot(k: 0 | 1): { heel: Vec3; ball: Vec3 } {
      const sx = k === 0 ? 'L' : 'R';
      const geoms = plan.segments.flatMap((s) => s.geoms);
      const fg = geoms.find((g) => g.name === 'foot' + sx)!, tg = geoms.find((g) => g.name === 'toes' + sx)!;
      const heel: Vec3 = [fg.pos![0], 0, fg.pos![2] - fg.size[2]];
      const ball: Vec3 = [tg.pos![0], 0, tg.pos![2] - tg.size[2]];
      return { heel: pointOn(plan, pose, 'foot' + sx, heel), ball: pointOn(plan, pose, 'foot' + sx, ball) };
    },
  };
}
