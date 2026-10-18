// MuJoCo (official WASM build) implementation of the physics interface. See docs/physics-benchmark.md.
import loadMujoco from '@mujoco/mujoco';
import { CONTACT, TURF } from '../anatomy/equipment';
import { selfCollisionExcludes } from '../anatomy/collision';
import type { GeomPlan, SegmentPlan } from '../anatomy/body';
import { add, qaxis, qrot, sub, type Quat, type Vec3 } from '../math';
import type { AthleteState, ContactReport, LinkRef, PhysicsEngine, PhysicsScene, SceneDesc } from './engine';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let mj: Any = null;

/** Soft end of range [S3]: the limit engages at the active-range norm with low impedance (tissue
 *  stiffening) and becomes nearly rigid ~10� past it (end of passive range). A margin that engages
 *  earlier was unstable at 240 Hz, see git history. */
const LIMIT_SOLIMP = '0.3 0.99 0.17';
const LIMIT_TIMECONST = 0.03;
const FRICTION = { ground: 0.6, body: 0.6, hand: 1.0 }; // [S5]

const f = (v: readonly number[]) => v.map((x) => +x.toFixed(7)).join(' ');

export const mujocoEngine: PhysicsEngine = {
  async init() { if (!mj) mj = await loadMujoco(); },
  createScene: (desc) => new MujocoScene(desc),
};

function geomXml(g: GeomPlan, origin: Vec3, dt: number, name: string) {
  const c = g.role === 'pad' ? CONTACT.pad : g.role === 'helmet' || g.role === 'facemask' ? CONTACT.helmet : CONTACT.body;
  const fr = g.role === 'foot' ? `${TURF.mu} ${TURF.torsional} ${TURF.rolling}` : g.role === 'hand' ? `${FRICTION.hand} 0.005 0.0001` : `${FRICTION.body} 0.005 0.0001`;
  const common = `name="${name}" friction="${fr}" condim="${g.role === 'foot' ? 4 : 3}" solref="${c.timeSteps * dt} ${c.dampRatio}" solimp="0.95 0.99 0.001" margin="0.005"`;
  if (g.type === 'capsule') return `<geom type="capsule" size="${g.size[0]}" fromto="${f(sub(g.fromto![0], origin))} ${f(sub(g.fromto![1], origin))}" ${common}/>`;
  return `<geom type="${g.type}" size="${f(g.size)}" pos="${f(sub(g.pos!, origin))}" ${common}/>`;
}

class MujocoScene implements PhysicsScene {
  readonly dt: number;
  readonly athletes: PhysicsScene['athletes'] = [];
  private m: Any; private d: Any;
  private segBody: Int32Array[] = [];     // athlete → segment → MuJoCo body id
  private dofQ: Int32Array[] = []; private dofV: Int32Array[] = [];
  private rootBody: number[] = [];
  private geomLink: LinkRef[] = [];
  private propBody: number[] = [];
  private gripEq: number[][] = [];        // athlete → hand → equality id
  private cache: ContactReport[] | null = null;
  private forceBuf: Any;
  private xfrc!: Float64Array; private qfrc!: Float64Array;

  constructor(desc: SceneDesc) {
    if (!mj) throw new Error('mujocoEngine.init() must be awaited first');
    this.dt = 1 / desc.hz;
    const dt = this.dt;
    let xml = `<mujoco model="zane-stick"><compiler angle="radian" inertiafromgeom="auto" autolimits="true"/>
<option timestep="${dt}" gravity="0 -9.81 0" integrator="implicitfast" cone="elliptic" iterations="${desc.iterations}"/>
<size memory="32M"/><worldbody>
<geom name="ground" type="plane" size="200 200 0.1" zaxis="0 1 0" friction="${FRICTION.ground} 0.005 0.0001" condim="3"/>`;
    const excludes: string[] = [];
    const equalities: string[] = [];
    desc.athletes.forEach((a, ai) => {
      const q = qaxis([0, 1, 0], a.yaw);
      const P = a.plan;
      const kids = (n: string | null) => P.segments.filter((s) => s.parent === n);
      const body = (s: SegmentPlan): string => {
        const par = s.parent ? P.segments.find((x) => x.name === s.parent)! : null;
        const pos = par ? sub(s.origin, par.origin) : add(qrot(q, s.origin), a.pos);
        let x = `<body name="a${ai}_${s.name}" pos="${f(pos)}"${par ? '' : ` quat="${f([q[3], q[0], q[1], q[2]])}"`}>`;
        if (!par) x += '<freejoint/>';
        const I = s.inertia, c = sub(s.com, s.origin);
        x += `<inertial pos="${f(c)}" mass="${s.mass}" fullinertia="${f([I[0], I[4], I[8], I[1], I[2], I[5]])}"/>`;
        const j = P.joints.find((jj) => jj.child === s.name);
        if (j) for (const dof of j.dofs) {
          x += `<joint name="a${ai}_${j.name}_${dof.name}" type="hinge" axis="${f(dof.axis)}" range="${dof.range[0]} ${dof.range[1]}" solreflimit="${Math.max(LIMIT_TIMECONST, 2 * dt)} 1" solimplimit="${LIMIT_SOLIMP}" damping="${j.damping}"/>`;
        }
        s.geoms.forEach((g, gi) => (x += geomXml(g, s.origin, dt, `a${ai}_${s.name}_${gi}`)));
        for (const k of kids(s.name)) x += body(k);
        return x + '</body>';
      };
      xml += body(kids(null)[0]);
      for (const [s1, s2] of selfCollisionExcludes(P)) excludes.push(`<exclude body1="a${ai}_${s1}" body2="a${ai}_${s2}"/>`);
      for (const h of ['L', 'R'].map((sx) => (P.segments.some((x) => x.name === 'hand' + sx) ? 'hand' : 'forearm') + sx)) equalities.push(`<connect name="a${ai}_grip_${h}" body1="a${ai}_${h}" body2="world" anchor="0 0 0" active="false" solref="0.025 1"/>`);
    });
    desc.props.forEach((p, pi) => {
      const quat = p.quat ? ` quat="${f([p.quat[3], p.quat[0], p.quat[1], p.quat[2]])}"` : '';
      const size = p.shape === 'capsule' ? `${p.size[0]} ${p.size[1]}` : f(p.size);
      const soft = p.soft ? CONTACT.pad : CONTACT.body;
      const geom = `<geom name="prop${pi}" type="${p.shape}" size="${size}"${p.shape === 'capsule' ? ' zaxis="0 1 0"' : ''} friction="${p.friction ?? 0.7} 0.005 0.0001" solref="${soft.timeSteps * dt} 1" solimp="0.95 0.99 0.001" margin="0.005"${p.mass > 0 ? ` mass="${p.mass}"` : ''}/>`;
      xml += p.mass > 0 ? `<body name="prop${pi}" pos="${f(p.pos)}"${quat}><freejoint/>${geom}</body>` : geom.replace('/>', ` pos="${f(p.pos)}"${quat}/>`);
    });
    xml += `</worldbody><contact>${excludes.join('')}</contact><equality>${equalities.join('')}</equality></mujoco>`;

    this.m = mj.MjModel.from_xml_string(xml);
    this.d = new mj.MjData(this.m);
    const m = this.m, id = (type: string, name: string) => mj.mj_name2id(m, mj.mjtObj[type].value, name);
    desc.athletes.forEach((a, ai) => {
      const P = a.plan;
      this.segBody.push(Int32Array.from(P.segments.map((s) => id('mjOBJ_BODY', `a${ai}_${s.name}`))));
      const jids = P.joints.flatMap((j) => j.dofs.map((dof) => id('mjOBJ_JOINT', `a${ai}_${j.name}_${dof.name}`)));
      this.dofQ.push(Int32Array.from(jids.map((j) => m.jnt_qposadr[j])));
      this.dofV.push(Int32Array.from(jids.map((j) => m.jnt_dofadr[j])));
      this.rootBody.push(this.segBody[ai][P.segments.findIndex((s) => s.parent === null)]);
      this.gripEq.push(['handL', 'handR'].map((h) => id('mjOBJ_EQUALITY', `a${ai}_grip_${h}`)));
      const nSeg = P.segments.length, nDof = jids.length;
      const state: AthleteState = {
        q: new Float64Array(nDof), qd: new Float64Array(nDof),
        segPos: new Float64Array(3 * nSeg), segQuat: new Float64Array(4 * nSeg), segCom: new Float64Array(3 * nSeg),
        segVel: new Float64Array(3 * nSeg), segAngVel: new Float64Array(3 * nSeg), com: [0, 0, 0], comVel: [0, 0, 0],
      };
      this.athletes.push({ plan: P, nDof, state });
    });
    this.propBody = desc.props.map((p, pi) => (p.mass > 0 ? id('mjOBJ_BODY', `prop${pi}`) : -1));
    // geom → link table for contact reports
    const bodyLink = new Map<number, LinkRef>();
    this.segBody.forEach((row, ai) => row.forEach((b, si) => bodyLink.set(b, { athlete: ai, seg: si })));
    this.propBody.forEach((b, pi) => b >= 0 && bodyLink.set(b, { athlete: -1, seg: pi }));
    for (let g = 0; g < m.ngeom; g++) {
      const b = m.geom_bodyid[g];
      const name = mj.mj_id2name(m, mj.mjtObj.mjOBJ_GEOM.value, g) as string;
      const staticProp = name?.startsWith('prop') && b === 0 ? { athlete: -1, seg: +name.slice(4) } : null;
      this.geomLink.push(bodyLink.get(b) ?? staticProp ?? { athlete: -1, seg: -1 });
    }
    this.forceBuf = new mj.DoubleBuffer(6);
    mj.mj_forward(m, this.d);
    this.views();
    this.read();
  }

  step() {
    mj.mj_step(this.m, this.d);
    this.views(); // WASM memory can grow, which detaches old typed-array views
    this.xfrc.fill(0);
    this.qfrc.fill(0);
    this.cache = null;
    this.read();
  }

  private views() { this.xfrc = this.d.xfrc_applied; this.qfrc = this.d.qfrc_applied; }

  private read() {
    const d = this.d;
    mj.mj_subtreeVel(this.m, d);
    const qpos = d.qpos, qvel = d.qvel, xpos = d.xpos, xquat = d.xquat, xipos = d.xipos, cvel = d.cvel;
    const subCom = d.subtree_com, subVel = d.subtree_linvel;
    this.athletes.forEach((a, ai) => {
      const s = a.state, dq = this.dofQ[ai], dv = this.dofV[ai];
      for (let i = 0; i < a.nDof; i++) { s.q[i] = qpos[dq[i]]; s.qd[i] = qvel[dv[i]]; }
      const r = this.rootBody[ai];
      const cx = subCom[3 * r], cy = subCom[3 * r + 1], cz = subCom[3 * r + 2];
      s.com[0] = cx; s.com[1] = cy; s.com[2] = cz;
      s.comVel[0] = subVel[3 * r]; s.comVel[1] = subVel[3 * r + 1]; s.comVel[2] = subVel[3 * r + 2];
      this.segBody[ai].forEach((b, i) => {
        for (let k = 0; k < 3; k++) { s.segPos[3 * i + k] = xpos[3 * b + k]; s.segCom[3 * i + k] = xipos[3 * b + k]; }
        s.segQuat[4 * i] = xquat[4 * b + 1]; s.segQuat[4 * i + 1] = xquat[4 * b + 2]; s.segQuat[4 * i + 2] = xquat[4 * b + 3]; s.segQuat[4 * i + 3] = xquat[4 * b];
        // cvel is [ω; v] at the tree's COM (subtree_com of the root) in world orientation.
        const wx = cvel[6 * b], wy = cvel[6 * b + 1], wz = cvel[6 * b + 2];
        const px = xipos[3 * b] - cx, py = xipos[3 * b + 1] - cy, pz = xipos[3 * b + 2] - cz;
        s.segAngVel[3 * i] = wx; s.segAngVel[3 * i + 1] = wy; s.segAngVel[3 * i + 2] = wz;
        s.segVel[3 * i] = cvel[6 * b + 3] + wy * pz - wz * py;
        s.segVel[3 * i + 1] = cvel[6 * b + 4] + wz * px - wx * pz;
        s.segVel[3 * i + 2] = cvel[6 * b + 5] + wx * py - wy * px;
      });
    });
  }

  setTorques(ai: number, tau: Float64Array) {
    const dv = this.dofV[ai];
    for (let i = 0; i < tau.length; i++) this.qfrc[dv[i]] += tau[i];
  }

  applyWrench(ai: number, seg: number, force: Vec3, torque: Vec3) {
    const b = this.segBody[ai][seg] * 6;
    for (let k = 0; k < 3; k++) { this.xfrc[b + k] += force[k]; this.xfrc[b + 3 + k] += torque[k]; }
  }

  contacts(): ContactReport[] {
    if (this.cache) return this.cache;
    const d = this.d, out: ContactReport[] = [];
    const list = d.contact;
    for (let i = 0; i < d.ncon; i++) {
      const c = list.get(i);
      mj.mj_contactForce(this.m, d, i, this.forceBuf);
      const fr = c.frame, p = c.pos;
      out.push({ a: this.geomLink[c.geom1], b: this.geomLink[c.geom2], pos: [p[0], p[1], p[2]], normal: [fr[0], fr[1], fr[2]], force: Math.abs(this.forceBuf.GetView()[0]) });
      c.delete();
    }
    list.delete();
    return (this.cache = out);
  }

  gripOn(ai: number, hand: 0 | 1, target: LinkRef, pointWorld: Vec3, timeconst: number) {
    const e = this.gripEq[ai][hand], m = this.m, d = this.d;
    const hb = this.segBody[ai][this.handSeg(ai, hand)];
    const tb = target.athlete >= 0 ? this.segBody[target.athlete][target.seg] : target.seg >= 0 ? Math.max(0, this.propBody[target.seg]) : 0; // static props live on the world body
    m.eq_obj2id[e] = tb;
    const local = (b: number): Vec3 => {
      const q: Quat = [d.xquat[4 * b + 1], d.xquat[4 * b + 2], d.xquat[4 * b + 3], d.xquat[4 * b]];
      return qrot([-q[0], -q[1], -q[2], q[3]], sub(pointWorld, [d.xpos[3 * b], d.xpos[3 * b + 1], d.xpos[3 * b + 2]]));
    };
    const a1 = local(hb), a2 = local(tb), ed = m.eq_data, o = e * mj.mjNEQDATA;
    for (let k = 0; k < 3; k++) { ed[o + k] = a1[k]; ed[o + 3 + k] = a2[k]; }
    m.eq_solref[2 * e] = Math.max(timeconst, 2 * this.dt);
    d.eq_active[e] = 1;
  }
  gripOff(ai: number, hand: 0 | 1) { this.d.eq_active[this.gripEq[ai][hand]] = 0; }
  gripActive(ai: number, hand: 0 | 1) { return this.d.eq_active[this.gripEq[ai][hand]] === 1; }
  gripForce(ai: number, hand: 0 | 1) {
    const d = this.d, e = this.gripEq[ai][hand], EQ = mj.mjtConstraint.mjCNSTR_EQUALITY.value;
    let s = 0;
    for (let i = 0; i < d.nefc; i++) if (d.efc_type[i] === EQ && d.efc_id[i] === e) s += d.efc_force[i] ** 2;
    return Math.sqrt(s);
  }
  private handSeg(ai: number, hand: 0 | 1) {
    const segs = this.athletes[ai].plan.segments;
    const want = hand === 0 ? ['handL', 'forearmL'] : ['handR', 'forearmR'];
    return segs.findIndex((s) => s.name === want[0]) >= 0 ? segs.findIndex((s) => s.name === want[0]) : segs.findIndex((s) => s.name === want[1]);
  }

  propPose(pi: number) {
    const b = this.propBody[pi], d = this.d;
    return { pos: [d.xpos[3 * b], d.xpos[3 * b + 1], d.xpos[3 * b + 2]] as Vec3, quat: [d.xquat[4 * b + 1], d.xquat[4 * b + 2], d.xquat[4 * b + 3], d.xquat[4 * b]] as Quat };
  }
  propVel(pi: number): Vec3 {
    const b = this.propBody[pi], d = this.d, cv = d.cvel, sc = d.subtree_com;
    const px = d.xipos[3 * b] - sc[3 * b], py = d.xipos[3 * b + 1] - sc[3 * b + 1], pz = d.xipos[3 * b + 2] - sc[3 * b + 2];
    return [cv[6 * b + 3] + cv[6 * b + 1] * pz - cv[6 * b + 2] * py, cv[6 * b + 4] + cv[6 * b + 2] * px - cv[6 * b] * pz, cv[6 * b + 5] + cv[6 * b] * py - cv[6 * b + 1] * px];
  }
  stats() {
    const w = this.d.warning, k = mj.mjtWarning.mjWARN_BADQACC.value;
    return { contacts: this.d.ncon, bodies: this.m.nbody - 1, instabilities: (w.get ? w.get(k) : w[k])?.number ?? 0 };
  }
  destroy() { this.forceBuf.delete(); this.d.delete(); this.m.delete(); }
}
