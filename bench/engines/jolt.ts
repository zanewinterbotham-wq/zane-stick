import initJolt from 'jolt-physics/wasm-compat';
import { HUMANOID } from './humanoid';
import { place, type BenchEngine, type BenchWorld, type Quat, type WorldOpts } from './common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let J: any;

const NON_MOVING = 0, MOVING = 1;

function newSystem(iterations?: number) {
  const s = new J.JoltSettings();
  const olp = new J.ObjectLayerPairFilterTable(2);
  olp.EnableCollision(NON_MOVING, MOVING);
  olp.EnableCollision(MOVING, MOVING);
  const bpi = new J.BroadPhaseLayerInterfaceTable(2, 2);
  bpi.MapObjectToBroadPhaseLayer(NON_MOVING, new J.BroadPhaseLayer(0));
  bpi.MapObjectToBroadPhaseLayer(MOVING, new J.BroadPhaseLayer(1));
  s.mObjectLayerPairFilter = olp;
  s.mBroadPhaseLayerInterface = bpi;
  s.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bpi, 2, olp, 2);
  const jolt = new J.JoltInterface(s);
  J.destroy(s);
  const ps = jolt.GetPhysicsSystem();
  ps.SetGravity(new J.Vec3(0, -9.81, 0));
  if (iterations) {
    const st = ps.GetPhysicsSettings();
    st.mNumVelocitySteps = iterations;
    ps.SetPhysicsSettings(st);
  }
  const bi = ps.GetBodyInterface();
  return { jolt, ps, bi };
}

function addStaticBox(bi: any, half: [number, number, number], pos: [number, number, number]) {
  const cs = new J.BodyCreationSettings(new J.BoxShape(new J.Vec3(...half), 0.02), new J.RVec3(...pos), new J.Quat(0, 0, 0, 1), J.EMotionType_Static, NON_MOVING);
  cs.mFriction = 1;
  const b = bi.CreateBody(cs);
  bi.AddBody(b.GetID(), J.EActivation_DontActivate);
  J.destroy(cs);
  return b;
}

function shapeOf(s: (typeof HUMANOID.bodies)[number]['shape']) {
  if (s.type === 'box') return new J.BoxShape(new J.Vec3(...s.half), 0.01);
  if (s.type === 'capsule') return new J.CapsuleShape(s.hl, s.r);
  return new J.SphereShape(s.r);
}

function addDynamic(bi: any, shape: any, pos: [number, number, number], q: Quat, mass: number, ccd: boolean, group?: any) {
  const cs = new J.BodyCreationSettings(shape, new J.RVec3(...pos), new J.Quat(...q), J.EMotionType_Dynamic, MOVING);
  cs.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia;
  cs.mMassPropertiesOverride.mMass = mass;
  cs.mFriction = 1;
  cs.mAllowSleeping = false;
  if (ccd) cs.mMotionQuality = J.EMotionQuality_LinearCast;
  if (group) cs.mCollisionGroup = group;
  const b = bi.CreateBody(cs);
  bi.AddBody(b.GetID(), J.EActivation_Activate);
  J.destroy(cs);
  return b;
}

export const joltEngine: BenchEngine = {
  name: 'jolt',
  notes: ['Jolt JS bindings expose no solved contact impulses, so contact force reporting is unavailable without estimating it ourselves.'],
  async init() { if (!J) J = await initJolt(); },
  create(o: WorldOpts): BenchWorld {
    const { jolt, ps, bi } = newSystem(o.iterations);
    addStaticBox(bi, [50, 0.5, 50], [0, -0.5, 0]);
    const tv = new J.Vec3(0, 0, 0);
    const bodies: any[][] = [];
    o.humanoids.forEach((p, h) => {
      const pl = place(p);
      const filter = new J.GroupFilterTable(HUMANOID.bodies.length);
      HUMANOID.joints.forEach((j) => filter.DisableCollision(j.child, HUMANOID.bodies[j.child].parent));
      const hb = HUMANOID.bodies.map((spec, i) =>
        addDynamic(bi, shapeOf(spec.shape), pl.bodies[i], pl.q, spec.mass, o.ccd, new J.CollisionGroup(filter, h, i)));
      HUMANOID.joints.forEach((j, ji) => {
        const a = new J.RVec3(...pl.anchors[ji]);
        let c;
        if (j.type === 'hinge') {
          const s = new J.HingeConstraintSettings();
          s.mSpace = J.EConstraintSpace_WorldSpace;
          s.mPoint1 = a; s.mPoint2 = a;
          const ax = new J.Vec3(...pl.axes[ji]!);
          s.mHingeAxis1 = ax; s.mHingeAxis2 = ax;
          const n = new J.Vec3(0, -1, 0);
          s.mNormalAxis1 = n; s.mNormalAxis2 = n;
          s.mLimitsMin = j.lo!; s.mLimitsMax = j.hi!;
          c = s.Create(hb[HUMANOID.bodies[j.child].parent], hb[j.child]);
        } else {
          const s = new J.SwingTwistConstraintSettings();
          s.mSpace = J.EConstraintSpace_WorldSpace;
          s.mPosition1 = a; s.mPosition2 = a;
          const tw = new J.Vec3(0, 1, 0), pa = new J.Vec3(1, 0, 0);
          s.mTwistAxis1 = tw; s.mTwistAxis2 = tw; s.mPlaneAxis1 = pa; s.mPlaneAxis2 = pa;
          s.mNormalHalfConeAngle = j.swing!; s.mPlaneHalfConeAngle = j.swing!;
          s.mTwistMinAngle = -j.twist!; s.mTwistMaxAngle = j.twist!;
          c = s.Create(hb[HUMANOID.bodies[j.child].parent], hb[j.child]);
        }
        ps.AddConstraint(c);
      });
      bodies.push(hb);
    });
    const dt = 1 / o.hz;
    return {
      nHumanoids: o.humanoids.length,
      setLinVel(h, v) { tv.Set(...v); for (const b of bodies[h]) bi.SetLinearVelocity(b.GetID(), tv); },
      applyJointTorque(h, j, t) {
        const js = HUMANOID.joints[j];
        tv.Set(t[0], t[1], t[2]); bodies[h][js.child].AddTorque(tv);
        tv.Set(-t[0], -t[1], -t[2]); bodies[h][HUMANOID.bodies[js.child].parent].AddTorque(tv);
      },
      step() { jolt.Step(dt, 1); },
      pos(h, b) { const p = bodies[h][b].GetPosition(); return [p.GetX(), p.GetY(), p.GetZ()]; },
      quat(h, b) { const q = bodies[h][b].GetRotation(); return [q.GetX(), q.GetY(), q.GetZ(), q.GetW()]; },
      speed(h, b) { const v = bodies[h][b].GetLinearVelocity(); return Math.hypot(v.GetX(), v.GetY(), v.GetZ()); },
      interHumanoidForce: () => NaN,
      destroy() { J.destroy(jolt); },
    };
  },
  restingForce: () => NaN,
  tunnels(hz, ccd) {
    const { jolt, ps, bi } = newSystem();
    ps.SetGravity(new J.Vec3(0, 0, 0));
    addStaticBox(bi, [0.025, 1, 1], [1, 1, 0]);
    const b = addDynamic(bi, new J.SphereShape(0.04), [0, 1, 0], [0, 0, 0, 1], 0.5, ccd);
    bi.SetLinearVelocity(b.GetID(), new J.Vec3(40, 0, 0));
    for (let i = 0; i < hz * 0.2; i++) jolt.Step(1 / hz, 1);
    const x = b.GetPosition().GetX();
    J.destroy(jolt);
    return x > 1;
  },
  motorSag(hz, limit) {
    const { jolt, ps, bi } = newSystem();
    const base = addStaticBox(bi, [0.02, 0.02, 0.02], [0, 3, 0]); // away from the rod so contact can't hold it up
    const rod = addDynamic(bi, new J.BoxShape(new J.Vec3(0.5, 0.02, 0.02), 0.01), [0.5, 2, 0], [0, 0, 0, 1], 10, false);
    const s = new J.HingeConstraintSettings();
    s.mSpace = J.EConstraintSpace_WorldSpace;
    const a = new J.RVec3(0, 2, 0); s.mPoint1 = a; s.mPoint2 = a;
    const ax = new J.Vec3(0, 0, 1); s.mHingeAxis1 = ax; s.mHingeAxis2 = ax;
    const n = new J.Vec3(1, 0, 0); s.mNormalAxis1 = n; s.mNormalAxis2 = n;
    s.mMotorSettings.mSpringSettings.mFrequency = 20;
    s.mMotorSettings.mSpringSettings.mDamping = 1;
    s.mMotorSettings.mMinTorqueLimit = -limit; s.mMotorSettings.mMaxTorqueLimit = limit;
    const c = J.castObject(s.Create(base, rod), J.HingeConstraint);
    ps.AddConstraint(c);
    c.SetMotorState(J.EMotorState_Position);
    c.SetTargetAngle(0);
    for (let i = 0; i < hz; i++) jolt.Step(1 / hz, 1);
    const p = rod.GetPosition();
    const sag = Math.atan2(2 - p.GetY(), p.GetX());
    J.destroy(jolt);
    return sag;
  },
};
