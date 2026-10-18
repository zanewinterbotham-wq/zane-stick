import RAPIER_STD from '@dimforge/rapier3d-compat';
import RAPIER_DET from '@dimforge/rapier3d-deterministic-compat';
import { HUMANOID, type Vec3 } from './humanoid';
import { place, type BenchEngine, type BenchWorld, type Quat, type WorldOpts } from './common';

type R = typeof RAPIER_DET;

function makeCollider(R: R, s: (typeof HUMANOID.bodies)[number]['shape']) {
  if (s.type === 'box') return R.ColliderDesc.cuboid(s.half[0], s.half[1], s.half[2]);
  if (s.type === 'capsule') return R.ColliderDesc.capsule(s.hl, s.r);
  return R.ColliderDesc.ball(s.r);
}

function newWorld(R: R, hz: number, iterations?: number) {
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / hz;
  if (iterations) world.numSolverIterations = iterations;
  const ground = world.createCollider(R.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0).setFriction(1));
  return { world, ground };
}

export function rapierEngine(variant: 'std' | 'det', jointKind: 'impulse' | 'multibody'): BenchEngine {
  const R = (variant === 'det' ? RAPIER_DET : RAPIER_STD) as R;
  return {
    name: `rapier-${variant}-${jointKind}`,
    notes: [],
    init: () => R.init(),
    create(o: WorldOpts): BenchWorld {
      const { world } = newWorld(R, o.hz, o.iterations);
      const eq = new R.EventQueue(true);
      const owner = new Map<number, number>(); // collider handle → humanoid
      const bodies: InstanceType<R['RigidBody']>[][] = [];
      o.humanoids.forEach((p, h) => {
        const pl = place(p);
        const hb = HUMANOID.bodies.map((spec, i) => {
          const rb = world.createRigidBody(
            R.RigidBodyDesc.dynamic().setCanSleep(false)
              .setTranslation(...pl.bodies[i])
              .setRotation({ x: pl.q[0], y: pl.q[1], z: pl.q[2], w: pl.q[3] })
              .setCcdEnabled(o.ccd),
          );
          const c = world.createCollider(
            makeCollider(R, spec.shape).setMass(spec.mass).setFriction(1)
              .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0),
            rb,
          );
          owner.set(c.handle, h);
          return rb;
        });
        HUMANOID.joints.forEach((j, ji) => {
          const par = hb[HUMANOID.bodies[j.child].parent], ch = hb[j.child];
          const l = pl.local[ji];
          const a1 = { x: l.parent[0], y: l.parent[1], z: l.parent[2] }, a2 = { x: l.child[0], y: l.child[1], z: l.child[2] };
          let data;
          if (j.type === 'hinge') {
            data = R.JointData.revolute(a1, a2, { x: j.axis![0], y: j.axis![1], z: j.axis![2] });
            data.limitsEnabled = true;
            data.limits = [j.lo!, j.hi!];
          } else data = R.JointData.spherical(a1, a2); // NB: Rapier JS has no per-axis limits for spherical joints
          if (jointKind === 'impulse') world.createImpulseJoint(data, par, ch, true).setContactsEnabled(false);
          else world.createMultibodyJoint(data, par, ch, true).setContactsEnabled(false);
        });
        bodies.push(hb);
      });
      let force = 0;
      return {
        nHumanoids: o.humanoids.length,
        setLinVel: (h, v) => bodies[h].forEach((b) => b.setLinvel({ x: v[0], y: v[1], z: v[2] }, true)),
        applyJointTorque(h, j, t) {
          const js = HUMANOID.joints[j];
          bodies[h][js.child].addTorque({ x: t[0], y: t[1], z: t[2] }, true);
          bodies[h][HUMANOID.bodies[js.child].parent].addTorque({ x: -t[0], y: -t[1], z: -t[2] }, true);
        },
        step() {
          world.step(eq);
          force = 0;
          eq.drainContactForceEvents((e) => {
            const a = owner.get(e.collider1()), b = owner.get(e.collider2());
            if (a !== undefined && b !== undefined && a !== b) force += e.totalForceMagnitude();
          });
          for (const hb of bodies) for (const b of hb) b.resetTorques(false);
        },
        pos: (h, b) => { const t = bodies[h][b].translation(); return [t.x, t.y, t.z]; },
        quat: (h, b) => { const r = bodies[h][b].rotation(); return [r.x, r.y, r.z, r.w] as Quat; },
        speed: (h, b) => { const v = bodies[h][b].linvel(); return Math.hypot(v.x, v.y, v.z); },
        interHumanoidForce: () => force,
        destroy: () => { eq.free(); world.free(); },
      };
    },
    restingForce(hz) {
      const { world, ground } = newWorld(R, hz);
      const eq = new R.EventQueue(true);
      const rb = world.createRigidBody(R.RigidBodyDesc.dynamic().setCanSleep(false).setTranslation(0, 0.25, 0));
      world.createCollider(R.ColliderDesc.cuboid(0.25, 0.25, 0.25).setMass(100)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0), rb);
      let sum = 0, n = 0;
      for (let i = 0; i < hz * 1.5; i++) {
        world.step(eq);
        let f = 0;
        eq.drainContactForceEvents((e) => { if (e.collider1() === ground.handle || e.collider2() === ground.handle) f += e.totalForceMagnitude(); });
        if (i >= hz) { sum += f; n++; }
      }
      eq.free(); world.free();
      return sum / n;
    },
    tunnels(hz, ccd) {
      const { world } = newWorld(R, hz);
      world.gravity = { x: 0, y: 0, z: 0 };
      world.createCollider(R.ColliderDesc.cuboid(0.025, 1, 1).setTranslation(1, 1, 0));
      const rb = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setLinvel(40, 0, 0).setCcdEnabled(ccd));
      world.createCollider(R.ColliderDesc.ball(0.04).setMass(0.5), rb);
      for (let i = 0; i < hz * 0.2; i++) world.step();
      const x = rb.translation().x;
      world.free();
      return x > 1;
    },
    motorSag(hz, limit) {
      const { world } = newWorld(R, hz);
      const base = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, 2, 0));
      const rod = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0.5, 2, 0));
      world.createCollider(R.ColliderDesc.cuboid(0.5, 0.02, 0.02).setMass(10).setCollisionGroups(0x00010001), rod);
      const j = world.createImpulseJoint(R.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: -0.5, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), base, rod, true) as InstanceType<R['RevoluteImpulseJoint']>;
      j.configureMotorPosition(0, 1e5, 1e3);
      j.setMotorMaxForce(limit);
      for (let i = 0; i < hz; i++) world.step();
      const t = rod.translation();
      world.free();
      return Math.atan2(2 - t.y, t.x);
    },
  };
}

export type { Vec3 };
