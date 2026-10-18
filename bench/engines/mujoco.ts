import loadMujoco from '@mujoco/mujoco';
import { HUMANOID } from './humanoid';
import { place, sub, type BenchEngine, type BenchWorld, type Quat, type WorldOpts } from './common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;

const f = (v: number[]) => v.map((x) => +x.toFixed(6)).join(' ');
const geomXml = (s: (typeof HUMANOID.bodies)[number]['shape'], mass: number) =>
  s.type === 'box' ? `<geom type="box" size="${f(s.half)}" mass="${mass}"/>`
  : s.type === 'capsule' ? `<geom type="capsule" size="${s.r} ${s.hl}" zaxis="0 1 0" mass="${mass}"/>`
  : `<geom type="sphere" size="${s.r}" mass="${mass}"/>`;

let jointDefaults = '';
function header(hz: number, iterations?: number, gravity = '0 -9.81 0') {
  return `<mujoco><compiler angle="radian"/>
<option timestep="${1 / hz}" gravity="${gravity}" integrator="implicitfast"${iterations ? ` iterations="${iterations}"` : ''}/>
<default><geom friction="1 0.005 0.0001"/>${jointDefaults}</default><worldbody>
<geom name="ground" type="plane" size="50 50 0.1" zaxis="0 1 0"/>`;
}

function humanoidXml(h: number, pl: ReturnType<typeof place>) {
  const kids = (i: number) => HUMANOID.bodies.map((b, k) => ({ b, k })).filter((x) => x.b.parent === i);
  const jointsOf = (i: number) => HUMANOID.joints.map((j, ji) => ({ j, ji })).filter((x) => x.j.child === i);
  const body = (i: number): string => {
    const spec = HUMANOID.bodies[i];
    const rel = spec.parent < 0 ? null : sub(spec.pos, HUMANOID.bodies[spec.parent].pos);
    const attrs = rel ? `pos="${f(rel)}"` : `pos="${f(pl.bodies[i])}" quat="${f([pl.q[3], pl.q[0], pl.q[1], pl.q[2]])}"`;
    let xml = `<body name="h${h}_${i}" ${attrs}>`;
    if (spec.parent < 0) xml += '<freejoint/>';
    for (const { j, ji } of jointsOf(i)) {
      const p = f(pl.local[ji].child);
      if (j.type === 'hinge') xml += `<joint type="hinge" pos="${p}" axis="${f(j.axis!)}" range="${j.lo} ${j.hi}" limited="true"/>`;
      else for (const [ax, r] of [['1 0 0', j.swing], ['0 1 0', j.twist], ['0 0 1', j.swing]] as const)
        xml += `<joint type="hinge" pos="${p}" axis="${ax}" range="${-r!} ${r}" limited="true"/>`;
    }
    xml += geomXml(spec.shape, spec.mass);
    for (const k of kids(i)) xml += body(k.k);
    return xml + '</body>';
  };
  return body(0);
}

function sumNormalForce(m: any, d: any, pred: (b1: number, b2: number) => boolean) {
  const buf = new mj.DoubleBuffer(6);
  const contacts = d.contact;
  let total = 0;
  for (let i = 0; i < d.ncon; i++) {
    const c = contacts.get(i);
    if (pred(m.geom_bodyid[c.geom1], m.geom_bodyid[c.geom2])) {
      mj.mj_contactForce(m, d, i, buf);
      total += Math.abs(buf.GetView()[0]);
    }
    c.delete?.();
  }
  contacts.delete();
  buf.delete();
  return total;
}

export const mujocoEngine = (variant: '' | 'damped' | 'armature' = ''): BenchEngine => ({
  name: 'mujoco' + (variant ? '-' + variant : ''),
  notes: ['No continuous collision detection; relies on small timesteps and contact margins.',
    'Generalized (reduced) coordinates: joints cannot separate by construction.'],
  async init() {
    if (!mj) mj = await loadMujoco();
    // damped: passive joint viscosity 1 N·m·s/rad; armature: + 0.01 kg·m² reflected inertia per joint axis
    jointDefaults = variant === 'damped' ? '<joint damping="1"/>' : variant === 'armature' ? '<joint damping="1" armature="0.01"/>' : '';
  },
  create(o: WorldOpts): BenchWorld {
    let xml = header(o.hz, o.iterations);
    o.humanoids.forEach((p, h) => (xml += humanoidXml(h, place(p))));
    xml += '</worldbody></mujoco>';
    const m = mj.MjModel.from_xml_string(xml);
    const d = new mj.MjData(m);
    mj.mj_forward(m, d); // xpos is zero until the first forward pass
    const id = (h: number, b: number) => mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, `h${h}_${b}`);
    const ids = o.humanoids.map((_, h) => HUMANOID.bodies.map((__, b) => id(h, b)));
    const owner = new Int32Array(m.nbody).fill(-1);
    ids.forEach((row, h) => row.forEach((bid) => (owner[bid] = h)));
    const rootDof = ids.map((row) => m.jnt_dofadr[m.body_jntadr[row[0]]]);
    const xfrc = d.xfrc_applied, xpos = d.xpos, xquat = d.xquat;
    let prev = Float64Array.from(xpos);
    const dt = 1 / o.hz;
    return {
      nHumanoids: o.humanoids.length,
      setLinVel(h, v) { const qv = d.qvel; for (let k = 0; k < 3; k++) qv[rootDof[h] + k] = v[k]; },
      applyJointTorque(h, j, t) {
        const js = HUMANOID.joints[j], c = ids[h][js.child], p = ids[h][HUMANOID.bodies[js.child].parent];
        for (let k = 0; k < 3; k++) { xfrc[c * 6 + 3 + k] += t[k]; xfrc[p * 6 + 3 + k] -= t[k]; }
      },
      step() {
        prev = Float64Array.from(xpos);
        mj.mj_step(m, d);
        xfrc.fill(0);
      },
      pos: (h, b) => { const i = ids[h][b] * 3; return [xpos[i], xpos[i + 1], xpos[i + 2]]; },
      quat: (h, b) => { const i = ids[h][b] * 4; return [xquat[i + 1], xquat[i + 2], xquat[i + 3], xquat[i]] as Quat; },
      speed: (h, b) => { const i = ids[h][b] * 3; return Math.hypot(xpos[i] - prev[i], xpos[i + 1] - prev[i + 1], xpos[i + 2] - prev[i + 2]) / dt; },
      interHumanoidForce: () => sumNormalForce(m, d, (a, b) => owner[a] >= 0 && owner[b] >= 0 && owner[a] !== owner[b]),
      destroy() { d.delete(); m.delete(); },
    };
  },
  restingForce(hz) {
    const m = mj.MjModel.from_xml_string(header(hz) + `<body pos="0 0.25 0"><freejoint/><geom type="box" size=".25 .25 .25" mass="100"/></body></worldbody></mujoco>`);
    const d = new mj.MjData(m);
    let sum = 0, n = 0;
    for (let i = 0; i < hz * 1.5; i++) {
      mj.mj_step(m, d);
      if (i >= hz) { sum += sumNormalForce(m, d, (a, b) => a === 0 || b === 0); n++; }
    }
    d.delete(); m.delete();
    return sum / n;
  },
  tunnels(hz) {
    const m = mj.MjModel.from_xml_string(header(hz, undefined, '0 0 0') +
      `<geom type="box" size=".025 1 1" pos="1 1 0"/><body pos="0 1 0"><freejoint/><geom type="sphere" size=".04" mass=".5"/></body></worldbody></mujoco>`);
    const d = new mj.MjData(m);
    d.qvel[0] = 40;
    for (let i = 0; i < hz * 0.2; i++) mj.mj_step(m, d);
    const x = d.qpos[0];
    d.delete(); m.delete();
    return x > 1;
  },
  motorSag(hz, limit) {
    const m = mj.MjModel.from_xml_string(header(hz) +
      `<body pos="0 2 0"><joint name="h" type="hinge" axis="0 0 1"/><geom type="box" size=".5 .02 .02" pos=".5 0 0" mass="10" contype="0" conaffinity="0"/></body></worldbody>
       <actuator><position joint="h" kp="20000" kv="200" forcerange="${-limit} ${limit}" forcelimited="true"/></actuator></mujoco>`);
    const d = new mj.MjData(m);
    d.ctrl[0] = 0;
    for (let i = 0; i < hz; i++) mj.mj_step(m, d);
    const sag = -d.qpos[0];
    d.delete(); m.delete();
    return sag;
  },
});
