// Thin physics interface. The rest of the sim talks only to this; src/sim/physics/mujoco.ts implements it.
import type { BodyPlan } from '../anatomy/body';
import type { Quat, Vec3 } from '../math';

export interface AthleteDesc { plan: BodyPlan; pos: Vec3; yaw: number }
export interface PropDesc {
  name: string;
  shape: 'ellipsoid' | 'box' | 'capsule';
  size: number[];          // ellipsoid/box: semi-axes; capsule: [r, halfLength] along Y
  mass: number;            // 0 for static
  pos: Vec3;
  quat?: Quat;
  friction?: number;
  soft?: boolean;          // padded (bags, dummies)
  hidden?: boolean;        // collision only, never drawn (the stadium art shows the wall)
}
export interface SceneDesc { hz: number; iterations: number; athletes: AthleteDesc[]; props: PropDesc[]; /** Cleat–turf friction override (tuning panel). */ traction?: number }

/** Who a contact touches. athlete −1 = prop (seg = prop index) or ground (seg = −1). */
export interface LinkRef { athlete: number; seg: number }
export interface ContactReport { a: LinkRef; b: LinkRef; pos: Vec3; normal: Vec3; force: number }

/** Live per-athlete state arrays, refreshed by `read()` after each step. World frame. */
export interface AthleteState {
  q: Float64Array;          // joint angles, plan dof order (rad)
  qd: Float64Array;         // joint angular velocities (rad/s)
  segPos: Float64Array;     // segment body origins (3 × nSeg)
  segQuat: Float64Array;    // segment orientations x y z w (4 × nSeg)
  segCom: Float64Array;     // segment COM positions (3 × nSeg)
  segVel: Float64Array;     // segment COM linear velocities (3 × nSeg)
  segAngVel: Float64Array;  // segment angular velocities (3 × nSeg)
  dofAxis: Float64Array;    // each dof's rotation axis in world (3 × nDof)
  dofAnchor: Float64Array;  // each dof's joint centre in world (3 × nDof)
  com: Vec3;                // whole-body COM
  comVel: Vec3;             // whole-body COM velocity
}

export interface PhysicsScene {
  readonly dt: number;
  readonly athletes: { plan: BodyPlan; nDof: number; state: AthleteState }[];
  step(): void;
  /** Joint torques for the next step, plan dof order (N·m). */
  setTorques(athlete: number, tau: Float64Array): void;
  /** Velocity-proportional muscle torque −kd·qd for the next step (N·m·s/rad), integrated implicitly for
   *  stability; added to the passive joint damping. The muscle model keeps kd·|qd| within strength. */
  setDamping(athlete: number, kd: Float64Array): void;
  /** External force and torque at a segment's COM for the next step (world frame). */
  applyWrench(athlete: number, seg: number, force: Vec3, torque: Vec3): void;
  contacts(): ContactReport[];
  /** Join point `pointWorld` on the hand to link `target` (ball-and-socket). `timeconst` (s) sets its
   *  compliance: a hand grip is soft tissue, not a weld; near-rigid grips also destabilise the wrist. */
  gripOn(athlete: number, hand: 0 | 1, target: LinkRef, pointWorld: Vec3, timeconst: number): void;
  gripOff(athlete: number, hand: 0 | 1): void;
  gripActive(athlete: number, hand: 0 | 1): boolean;
  /** Magnitude of the constraint force holding the grip last step (N). */
  gripForce(athlete: number, hand: 0 | 1): number;
  /** Torque each dof's range-of-motion limit carried last step (N·m, ≥ 0; plan dof order): the load the joint's
   *  passive structures (ligaments, capsule, bone stops) took. Injuries are judged on it. */
  limitTorques(athlete: number): Float64Array;
  /** An injury only (a joint broken mid-rep): change one dof's range of motion (rad). */
  setJointRange(athlete: number, dof: number, lo: number, hi: number): void;
  propPose(prop: number): { pos: Vec3; quat: Quat };
  propVel(prop: number): Vec3;
  /** Setup only (tests): give a whole athlete an initial linear velocity, e.g. to start a run test at speed. */
  setInitialVelocity(athlete: number, v: Vec3): void;
  /** Setup only: set an athlete's joint angles (plan dof order) at rest and refresh kinematics. */
  setJointAngles(athlete: number, q: ArrayLike<number>): void;
  /** Setup only (before a rep starts): place a dynamic prop at rest. Never used during play. */
  placeProp(prop: number, pos: Vec3, quat: Quat): void;
  /** A kick (no kicking leg model) or a ball put in a hand: give a dynamic prop its velocity once, at that moment
   *  (linear in the world frame, angular in the prop's own frame). Everything after it is physics. */
  launchProp(prop: number, vel: Vec3, spin: Vec3): void;
  /** Generalised coordinates (MuJoCo qpos, nq) and velocities (qvel, nv) of the whole scene, for multiplayer
   *  snapshots; `freeQ` lists the qpos address of every free joint (athlete roots, dynamic props): x y z, then the
   *  orientation quaternion w x y z. */
  readonly nq: number; readonly nv: number; readonly freeQ: readonly number[];
  readQ(out: Float32Array | Float64Array): void;
  /** A replica only (a multiplayer guest, which never steps): set every coordinate and velocity (zero when absent),
   *  run the forward pass (kinematics, contacts) and refresh the athlete states. */
  writeQ(q: ArrayLike<number>, qd?: ArrayLike<number>): void;
  /** The velocity (qvel layout: free joints' angular part in the body frame) that moves q0 to q1 in dt s. */
  diffQ(q0: ArrayLike<number>, q1: ArrayLike<number>, dt: number, out: Float64Array): void;
  /** Counts for the overlay and tests. `instabilities` = times the solver diverged and auto-reset (must stay 0). */
  stats(): { contacts: number; bodies: number; instabilities: number };
  destroy(): void;
}

export interface PhysicsEngine {
  init(): Promise<void>;
  createScene(desc: SceneDesc): PhysicsScene;
}
