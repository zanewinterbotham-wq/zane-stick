// MuJoCo (official WASM build) implementation of the physics interface. See docs/physics-benchmark.md.
import loadMujoco from '@mujoco/mujoco';
import { CONTACT, TURF } from '../anatomy/equipment';
import { selfCollisionExcludes } from '../anatomy/collision';
import type { BodyPlan, GeomPlan, SegmentPlan } from '../anatomy/body';
import { add, qaxis, qconj, qlog, qmul, qrot, sub, type Quat, type Vec3 } from '../math';
import type { AthleteState, ContactReport, LinkRef, PhysicsEngine, PhysicsScene, SceneDesc } from './engine';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let mj: Any = null;

/** Soft end of range [S3]: the limit engages at the active-range norm with low impedance (tissue
 *  stiffening) and becomes nearly rigid ~10° past it (end of passive range). A margin that engages
 *  earlier was unstable at 240 Hz, see git history. */
const LIMIT_SOLIMP = '0.3 0.99 0.17';
const LIMIT_TIMECONST = 0.03;
/** Shoulder gimbal lock. The shoulder is three hinges in one body (flexion, abduction, internal rotation), so at 90°
 *  abduction the flexion and rotation axes line up and the mass matrix is singular: any difference between the two
 *  torques gives an unbounded acceleration and MuJoCo resets (a kickoff return diverged this way, 2026-10-21). Within
 *  `window` (rad) of 90° the three hinges get an armature (kg·m², rotor inertia: no mass added) growing to `armature`
 *  at 90°, which bounds it, as MuJoCo's own humanoid's armature does (0.02 on every joint there); 0.002 is under 1% of
 *  the arm's inertia about the shoulder. Zero elsewhere, so every other pose steps exactly as before. */
const GIMBAL = { window: 0.26, armature: 0.002 };
/** Divergence recovery: an older good state every BACK s, restored after STUCK divergences in a row. */
const BACK = 0.2, STUCK = 3;
const FRICTION = { ground: 0.6, body: 0.6, hand: 1.0 }; // [S5]

/** Fast contact reads (MujocoScene.contacts()): byte offsets of the fields in this MuJoCo build's mjContact and its
 *  size, and how many more reads are checked against the binding's slow path (−1: the layout did not match, always
 *  the slow path). One build per page, so measured and checked once for every scene. */
let CON: { pos: number; frame: number; geom: number; efc: number; dim: number; size: number; check: [number, number] } | null = null;

/** mjContact field offsets from the views of the binding's copy of a contact. efc_address and dim have no view:
 *  their places in the 3.x struct (after vert[2] and exclude, its last field; before geom1 and geom2, which precede
 *  geom[2]); the struct is padded to 8 bytes. */
function contactLayout(list: Any): NonNullable<typeof CON> {
  const c = list.get(0), at = (v: { byteOffset: number }) => v.byteOffset, b0 = at(c.pos) - 8; // pos follows dist (one double)
  const efc = at(c.vert) - b0 + 12;
  const lay = { pos: 8, frame: at(c.frame) - b0, geom: at(c.geom) - b0, efc, dim: at(c.geom) - b0 - 12, size: (efc + 4 + 7) & ~7, check: [50, 50] as [number, number] }; // per cone: the pyramid's force decode reads dim
  c.delete();
  return lay;
}

/** The segment a hand's grip holds by: the hand, or the forearm where the detail level fuses the two. */
const handOf = (P: BodyPlan, sx: string) => (P.segments.some((x) => x.name === 'hand' + sx) ? 'hand' : 'forearm') + sx;

const f = (v: readonly number[]) => v.map((x) => +x.toFixed(7)).join(' ');

export const mujocoEngine: PhysicsEngine = {
  async init() { if (!mj) mj = await loadMujoco(); },
  createScene: (desc) => new MujocoScene(desc),
};

function geomXml(g: GeomPlan, origin: Vec3, dt: number, name: string, traction = TURF.mu) {
  const c = g.role === 'pad' ? CONTACT.pad : CONTACT.body;
  const fr = g.role === 'foot' ? `${traction} ${TURF.torsional} ${TURF.rolling}` : g.role === 'hand' ? `${FRICTION.hand} 0.005 0.0001` : `${FRICTION.body} 0.005 0.0001`;
  const common = `name="${name}" friction="${fr}" condim="${g.role === 'foot' ? 4 : 3}" solref="${Math.max(c.timeconst, 2 * dt)} ${c.dampRatio}" solimp="0.95 0.99 0.001" margin="0.005"`;
  if (g.type === 'capsule') return `<geom type="capsule" size="${g.size[0]}" fromto="${f(sub(g.fromto![0], origin))} ${f(sub(g.fromto![1], origin))}" ${common}/>`;
  return `<geom type="${g.type}" size="${f(g.size)}" pos="${f(sub(g.pos!, origin))}" ${common}/>`;
}

class MujocoScene implements PhysicsScene {
  readonly dt: number;
  readonly athletes: PhysicsScene['athletes'] = [];
  readonly nq: number; readonly nv: number; readonly freeQ: number[] = [];
  /** Every joint: free (qpos address, qvel address) and the others (hinges: one coordinate each). */
  private freeV: number[] = []; private hingeQ: number[] = []; private hingeV: number[] = [];
  private m: Any; private d: Any;
  private segBody: Int32Array[] = [];     // athlete → segment → MuJoCo body id
  private dofQ: Int32Array[] = []; private dofV: Int32Array[] = []; private dofJ: Int32Array[] = [];
  private rootBody: number[] = [];
  private passiveDamp: Float64Array[] = [];
  private geomLink: LinkRef[] = [];
  private propBody: number[] = [];
  private gripEq: number[][] = [];        // athlete → hand → equality id
  private handBody: number[][] = [];      // athlete → hand → MuJoCo body the grip holds by
  private cache: ContactReport[] | null = null;
  /** Limit torques per athlete, refilled on the first read after a step. */
  private limits: Float64Array[] = []; private limitsStale = true;
  /** MuJoCo joint id → [athlete, dof]. */
  private jointDof = new Map<number, [number, number]>();
  private forceBuf: Any;
  private xfrc!: Float64Array; private qfrc!: Float64Array;
  /** The state before the current step, restored if it diverges; divergence count and bookkeeping. */
  private good!: { qpos: Float64Array; qvel: Float64Array; eq: Uint8Array; time: number };
  private instab = 0; private steps = 0; private lastBad = -9; private streak = 0;
  /** An older good state (taken every BACK s while nothing diverges), for a state that diverges every time it is stepped. */
  private back!: { qpos: Float64Array; qvel: Float64Array; set: boolean };
  private pyramidal = false;
  /** Per shoulder: its abduction's qpos address and its three hinges' dof addresses (GIMBAL). */
  private shoulders: { abd: number; dofs: number[] }[] = [];
  private heap: { f64: Float64Array; i32: Int32Array } | null = null;

  constructor(desc: SceneDesc) {
    if (!mj) throw new Error('mujocoEngine.init() must be awaited first');
    this.dt = 1 / desc.hz;
    const dt = this.dt, o = desc.opts ?? {};
    this.pyramidal = o.cone === 'pyramidal';
    // only the options a preset sets: absent ones leave the model (and its results) exactly as before
    const opt = o.tolerance !== undefined ? ` tolerance="${o.tolerance}"` : '';
    let xml = `<mujoco model="zane-stick"><compiler angle="radian" inertiafromgeom="auto" autolimits="true"/>
<option timestep="${dt}" gravity="0 -9.81 0" integrator="implicitfast" cone="${o.cone ?? 'elliptic'}" iterations="${desc.iterations}"${opt}/>
<size memory="32M"/><worldbody>
<geom name="ground" type="plane" size="200 200 0.1" zaxis="0 1 0" friction="${FRICTION.ground} 0.005 0.0001" condim="3"/>`;
    const excludes: string[] = [];
    const equalities: string[] = [];
    const pairs: string[] = [];
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
        s.geoms.forEach((g, gi) => (x += geomXml(g, s.origin, dt, `a${ai}_${s.name}_${gi}`, desc.traction)));
        for (const k of kids(s.name)) x += body(k);
        return x + '</body>';
      };
      xml += body(kids(null)[0]);
      for (const [s1, s2] of selfCollisionExcludes(P)) excludes.push(`<exclude body1="a${ai}_${s1}" body2="a${ai}_${s2}"/>`);
      for (const sx of ["L", "R"]) { const h = handOf(P, sx); equalities.push(`<connect name="a${ai}_grip_${sx}" body1="a${ai}_${h}" body2="world" anchor="0 0 0" active="false" solref="0.025 1"/>`); }
    });
    desc.props.forEach((p, pi) => {
      const quat = p.quat ? ` quat="${f([p.quat[3], p.quat[0], p.quat[1], p.quat[2]])}"` : '';
      const size = p.shape === 'capsule' ? `${p.size[0]} ${p.size[1]}` : f(p.size);
      const soft = p.soft ? CONTACT.pad : CONTACT.body;
      const geom = `<geom name="prop${pi}" type="${p.shape}" size="${size}"${p.shape === 'capsule' ? ' zaxis="0 1 0"' : ''} friction="${p.friction ?? 0.7} 0.005 0.0001" solref="${Math.max(soft.timeconst, 2 * dt)} 1" solimp="0.95 0.99 0.001" margin="0.005"${p.mass > 0 ? ` mass="${p.mass}"` : ''}/>`;
      xml += p.mass > 0 ? `<body name="prop${pi}" pos="${f(p.pos)}"${quat}><freejoint/>${geom}</body>` : geom.replace('/>', ` pos="${f(p.pos)}"${quat}/>`);
      // an explicit pair: only this prop's turf contact changes (hands, bodies and posts keep the blended defaults)
      const t = p.turf, fr = p.friction ?? 0.7;
      if (t) pairs.push(`<pair geom1="ground" geom2="prop${pi}" condim="6" friction="${fr} ${fr} ${t.torsional} ${t.rolling} ${t.rolling}" solref="${2 * dt} ${t.dampRatio}" solimp="0.99 0.99 0.001" margin="0.005"/>`);
    });
    xml += `</worldbody><contact>${pairs.join('')}${excludes.join('')}</contact><equality>${equalities.join('')}</equality></mujoco>`;

    this.m = mj.MjModel.from_xml_string(xml);
    this.d = new mj.MjData(this.m);
    const m = this.m, id = (type: string, name: string) => mj.mj_name2id(m, mj.mjtObj[type].value, name);
    desc.athletes.forEach((a, ai) => {
      const P = a.plan;
      this.segBody.push(Int32Array.from(P.segments.map((s) => id('mjOBJ_BODY', `a${ai}_${s.name}`))));
      const jids = P.joints.flatMap((j) => j.dofs.map((dof) => id('mjOBJ_JOINT', `a${ai}_${j.name}_${dof.name}`)));
      this.dofJ.push(Int32Array.from(jids));
      jids.forEach((j, k) => this.jointDof.set(j, [ai, k]));
      this.dofQ.push(Int32Array.from(jids.map((j) => m.jnt_qposadr[j])));
      this.dofV.push(Int32Array.from(jids.map((j) => m.jnt_dofadr[j])));
      this.passiveDamp.push(Float64Array.from(jids.map((j) => m.dof_damping[m.jnt_dofadr[j]])));
      this.rootBody.push(this.segBody[ai][P.segments.findIndex((s) => s.parent === null)]);
      this.gripEq.push(['L', 'R'].map((sx) => id('mjOBJ_EQUALITY', `a${ai}_grip_${sx}`)));
      this.handBody.push(['L', 'R'].map((sx) => id('mjOBJ_BODY', `a${ai}_${handOf(P, sx)}`)));
      const nSeg = P.segments.length, nDof = jids.length;
      const state: AthleteState = {
        q: new Float64Array(nDof), qd: new Float64Array(nDof),
        segPos: new Float64Array(3 * nSeg), segQuat: new Float64Array(4 * nSeg), segCom: new Float64Array(3 * nSeg),
        segVel: new Float64Array(3 * nSeg), segAngVel: new Float64Array(3 * nSeg),
        dofAxis: new Float64Array(3 * nDof), dofAnchor: new Float64Array(3 * nDof), com: [0, 0, 0], comVel: [0, 0, 0],
      };
      this.athletes.push({ plan: P, nDof, state });
      for (const sx of ['L', 'R']) {
        const j = ['flex', 'abd', 'intRot'].map((n) => id('mjOBJ_JOINT', `a${ai}_shoulder${sx}_${n}`));
        if (j.every((x) => x >= 0)) this.shoulders.push({ abd: m.jnt_qposadr[j[1]], dofs: j.map((x) => m.jnt_dofadr[x]) });
      }
    });
    this.limits = this.athletes.map((a) => new Float64Array(a.nDof));
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
    this.nq = m.nq; this.nv = m.nv;
    for (let j = 0; j < m.njnt; j++) {
      const free = m.jnt_type[j] === mj.mjtJoint.mjJNT_FREE.value;
      (free ? this.freeQ : this.hingeQ).push(m.jnt_qposadr[j]); (free ? this.freeV : this.hingeV).push(m.jnt_dofadr[j]);
    }
    this.forceBuf = new mj.DoubleBuffer(6);
    mj.mj_forward(m, this.d);
    this.views();
    this.good = { qpos: new Float64Array(m.nq), qvel: new Float64Array(m.nv), eq: new Uint8Array(m.neq), time: 0 };
    this.back = { qpos: new Float64Array(m.nq), qvel: new Float64Array(m.nv), set: false };
    this.read();
  }

  step() {
    this.views();
    const d = this.d, { qpos, qvel } = this.v, eq = d.eq_active as Uint8Array;
    this.good.qpos.set(qpos); this.good.qvel.set(qvel); this.good.eq.set(eq); this.good.time = d.time;
    const K = Math.max(1, Math.round(BACK / this.dt));
    if (this.steps % K === 0 && this.steps - this.lastBad > K) { const b = this.back; b.qpos.set(qpos); b.qvel.set(qvel); b.set = true; }
    for (const sh of this.shoulders) {
      const x = Math.abs(Math.abs(qpos[sh.abd]) - Math.PI / 2), arm = x < GIMBAL.window ? GIMBAL.armature * (1 - x / GIMBAL.window) : 0;
      for (const k of sh.dofs) this.v.dof_armature[k] = arm;
    }
    mj.mj_step(this.m, d);
    // a diverged solve makes MuJoCo reset everyone to the spawn pose (a mid-rep teleport, injuries kept): undo it,
    // back to the last good state with the motion damped out (halved; stopped if it diverges again at once). A reset
    // sets the clock back to 0 before the step advances it, so the clock not moving on is the sign. (The warning
    // counters cannot tell: a reset clears them and sets the one that fired to 1, every time.) Only on the first step,
    // from 0, do a reset and a good step both end at dt: there the counters, which start at 0, decide.
    if (d.time <= this.good.time || (this.good.time === 0 && this.warnings() > 0)) {
      this.views();
      this.streak = this.lastBad === this.steps - 1 ? this.streak + 1 : 1;
      const k = this.streak > 1 ? 0 : 0.5;
      // the last good state itself cannot be stepped (it diverged STUCK times running): go back to the older one, at rest
      const g = this.streak >= STUCK && this.back.set ? this.back : this.good;
      if (g === this.back) this.streak = 0;
      this.lastBad = this.steps; this.instab++;
      this.v.qpos.set(g.qpos); this.v.qvel.set(g.qvel); (d.eq_active as Uint8Array).set(this.good.eq); // the grips World set stay
      for (let i = 0; i < this.v.qvel.length; i++) this.v.qvel[i] *= k;
      d.qacc_warmstart.fill(0); d.time = this.good.time + this.dt;
      mj.mj_forward(this.m, d);
    }
    this.steps++;
    this.views(); // WASM memory can grow, which detaches old typed-array views
    this.xfrc.fill(0);
    this.qfrc.fill(0);
    this.cache = null; this.limitsStale = true;
    this.read();
  }

  /** Typed-array views into MuJoCo memory. Each property access allocates a new view, so they are cached
   *  and only re-fetched when WASM memory has grown (which detaches old views: byteLength 0). */
  private v: Record<'qpos' | 'qvel' | 'xpos' | 'xquat' | 'xipos' | 'cvel' | 'subtree_com' | 'subtree_linvel' | 'xaxis' | 'xanchor' | 'dof_damping' | 'dof_armature', Float64Array> = {} as never;
  private views() {
    if (this.qfrc && this.qfrc.byteLength > 0 && this.qfrc.buffer === this.v.qpos?.buffer) return;
    const d = this.d;
    this.xfrc = d.xfrc_applied; this.qfrc = d.qfrc_applied;
    this.v = { qpos: d.qpos, qvel: d.qvel, xpos: d.xpos, xquat: d.xquat, xipos: d.xipos, cvel: d.cvel, subtree_com: d.subtree_com,
      subtree_linvel: d.subtree_linvel, xaxis: d.xaxis, xanchor: d.xanchor, dof_damping: this.m.dof_damping, dof_armature: this.m.dof_armature };
  }

  private read() {
    const d = this.d;
    mj.mj_subtreeVel(this.m, d);
    this.views();
    const { qpos, qvel, xpos, xquat, xipos, cvel, subtree_com: subCom, subtree_linvel: subVel, xaxis, xanchor } = this.v;
    this.athletes.forEach((a, ai) => {
      const s = a.state, dq = this.dofQ[ai], dv = this.dofV[ai], dj = this.dofJ[ai];
      for (let i = 0; i < a.nDof; i++) {
        s.q[i] = qpos[dq[i]]; s.qd[i] = qvel[dv[i]];
        const j = dj[i];
        for (let k = 0; k < 3; k++) { s.dofAxis[3 * i + k] = xaxis[3 * j + k]; s.dofAnchor[3 * i + k] = xanchor[3 * j + k]; }
      }
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

  setDamping(ai: number, kd: Float64Array) {
    this.views();
    const dv = this.dofV[ai], base = this.passiveDamp[ai], dd = this.v.dof_damping;
    for (let i = 0; i < kd.length; i++) dd[dv[i]] = base[i] + kd[i];
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
    const d = this.d, n = d.ncon;
    if (n === 0) return (this.cache = []);
    const list = d.contact;
    CON ??= contactLayout(list);
    // Fast path: the contacts are one array of mjContact structs at the start of MuJoCo's arena, so their fields are
    // read off the heap and the normal force off efc_force (what mj_contactForce returns), instead of a binding copy of
    // each, two views and a WASM call per contact. The first reads are compared with the slow path; a mismatch (a
    // MuJoCo build with another layout) turns the fast path off for good.
    let out: ContactReport[] | null = null;
    const k = +this.pyramidal;
    if (CON.check[k] >= 0) {
      out = this.fastContacts((d.arena as Uint8Array).byteOffset, n);
      if (CON.check[k] > 0) {
        CON.check[k]--;
        const slow = this.slowContacts(list, n);
        if (JSON.stringify(slow) !== JSON.stringify(out)) { CON.check[k] = -1; out = slow; }
      }
    }
    out ??= this.slowContacts(list, n);
    list.delete();
    return (this.cache = out);
  }

  private slowContacts(list: Any, n: number): ContactReport[] {
    const d = this.d, out: ContactReport[] = [];
    for (let i = 0; i < n; i++) {
      const c = list.get(i);
      mj.mj_contactForce(this.m, d, i, this.forceBuf);
      const fr = c.frame, p = c.pos;
      out.push({ a: this.geomLink[c.geom1], b: this.geomLink[c.geom2], pos: [p[0], p[1], p[2]], normal: [fr[0], fr[1], fr[2]], force: Math.abs(this.forceBuf.GetView()[0]) });
      c.delete();
    }
    return out;
  }

  private fastContacts(base: number, n: number): ContactReport[] {
    const ef = this.d.efc_force as Float64Array, C = CON!;
    if (this.heap?.f64.buffer !== ef.buffer) this.heap = { f64: new Float64Array(ef.buffer), i32: new Int32Array(ef.buffer) };
    const { f64, i32 } = this.heap, e0 = ef.byteOffset >> 3, out: ContactReport[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = base + i * C.size, p = (b + C.pos) >> 3, fr = (b + C.frame) >> 3, g = (b + C.geom) >> 2, e = i32[(b + C.efc) >> 2];
      // mj_contactForce's normal force: none for an excluded contact, an elliptic cone's first row, or a pyramid's
      // edges summed in mju_decodePyramid's order
      let force = 0;
      if (e >= 0) {
        const dim = i32[(b + C.dim) >> 2];
        if (!this.pyramidal || dim === 1) force = f64[e0 + e];
        else for (let k = 0; k < 2 * (dim - 1); k++) force += f64[e0 + e + k];
      }
      out[i] = { a: this.geomLink[i32[g]], b: this.geomLink[i32[g + 1]], pos: [f64[p], f64[p + 1], f64[p + 2]], normal: [f64[fr], f64[fr + 1], f64[fr + 2]], force: Math.abs(force) };
    }
    return out;
  }

  gripOn(ai: number, hand: 0 | 1, target: LinkRef, pointWorld: Vec3, timeconst: number) {
    const e = this.gripEq[ai][hand], m = this.m;
    this.views();
    const { xpos, xquat } = this.v, hb = this.handBody[ai][hand];
    const tb = target.athlete >= 0 ? this.segBody[target.athlete][target.seg] : target.seg >= 0 ? Math.max(0, this.propBody[target.seg]) : 0; // static props live on the world body
    m.eq_obj2id[e] = tb;
    const local = (b: number): Vec3 => {
      const q: Quat = [xquat[4 * b + 1], xquat[4 * b + 2], xquat[4 * b + 3], xquat[4 * b]];
      return qrot([-q[0], -q[1], -q[2], q[3]], sub(pointWorld, [xpos[3 * b], xpos[3 * b + 1], xpos[3 * b + 2]]));
    };
    const a1 = local(hb), a2 = local(tb), ed = m.eq_data, o = e * mj.mjNEQDATA;
    for (let k = 0; k < 3; k++) { ed[o + k] = a1[k]; ed[o + 3 + k] = a2[k]; }
    m.eq_solref[2 * e] = Math.max(timeconst, 2 * this.dt);
    this.d.eq_active[e] = 1;
  }
  gripOff(ai: number, hand: 0 | 1) { this.d.eq_active[this.gripEq[ai][hand]] = 0; }
  gripActive(ai: number, hand: 0 | 1) { return this.d.eq_active[this.gripEq[ai][hand]] === 1; }
  gripForce(ai: number, hand: 0 | 1) {
    const d = this.d, e = this.gripEq[ai][hand], EQ = mj.mjtConstraint.mjCNSTR_EQUALITY.value;
    const type = d.efc_type, id = d.efc_id, force = d.efc_force; // each read is a new view: once, as in limitTorques
    let s = 0;
    for (let i = 0, n = d.nefc; i < n; i++) if (type[i] === EQ && id[i] === e) s += force[i] ** 2;
    return Math.sqrt(s);
  }

  limitTorques(ai: number) {
    if (this.limitsStale) {
      const d = this.d, LIM = mj.mjtConstraint.mjCNSTR_LIMIT_JOINT.value, type = d.efc_type, id = d.efc_id, force = d.efc_force;
      this.limitsStale = false;
      for (const l of this.limits) l.fill(0);
      for (let i = 0, n = d.nefc; i < n; i++) {
        if (type[i] !== LIM) continue;
        const k = this.jointDof.get(id[i]);
        if (k) this.limits[k[0]][k[1]] += Math.abs(force[i]);
      }
    }
    return this.limits[ai];
  }
  setJointRange(ai: number, dof: number, lo: number, hi: number) {
    const r = this.m.jnt_range, j = this.dofJ[ai][dof];
    r[2 * j] = lo; r[2 * j + 1] = hi;
  }
  propPose(pi: number) {
    this.views();
    const b = this.propBody[pi], { xpos, xquat } = this.v;
    return { pos: [xpos[3 * b], xpos[3 * b + 1], xpos[3 * b + 2]] as Vec3, quat: [xquat[4 * b + 1], xquat[4 * b + 2], xquat[4 * b + 3], xquat[4 * b]] as Quat };
  }
  setInitialVelocity(ai: number, vel: Vec3) {
    const m = this.m, b = this.rootBody[ai], va = m.jnt_dofadr[m.body_jntadr[b]], qv = this.d.qvel;
    for (let k = 0; k < 3; k++) qv[va + k] = vel[k];
    mj.mj_forward(m, this.d);
    this.views();
    this.read();
  }
  setJointAngles(ai: number, q: ArrayLike<number>) {
    const qp = this.d.qpos, qv = this.d.qvel, dq = this.dofQ[ai], dv = this.dofV[ai];
    for (let i = 0; i < dq.length; i++) { qp[dq[i]] = q[i]; qv[dv[i]] = 0; }
    mj.mj_forward(this.m, this.d);
    this.views();
    this.read();
  }
  placeProp(pi: number, pos: Vec3, quat: Quat) {
    const b = this.propBody[pi], m = this.m, d = this.d;
    const qa = m.jnt_qposadr[m.body_jntadr[b]], va = m.jnt_dofadr[m.body_jntadr[b]];
    const qp = d.qpos, qv = d.qvel;
    qp[qa] = pos[0]; qp[qa + 1] = pos[1]; qp[qa + 2] = pos[2];
    qp[qa + 3] = quat[3]; qp[qa + 4] = quat[0]; qp[qa + 5] = quat[1]; qp[qa + 6] = quat[2];
    for (let k = 0; k < 6; k++) qv[va + k] = 0;
    mj.mj_forward(m, d);
    this.views();
    this.read();
  }
  launchProp(pi: number, vel: Vec3, spin: Vec3) {
    const b = this.propBody[pi], m = this.m, va = m.jnt_dofadr[m.body_jntadr[b]], qv = this.d.qvel;
    // a free joint's velocity: linear (world), then angular (body frame)
    for (let k = 0; k < 3; k++) { qv[va + k] = vel[k]; qv[va + 3 + k] = spin[k]; }
    mj.mj_forward(m, this.d);
    this.views();
    this.read();
  }
  propVel(pi: number): Vec3 {
    this.views();
    const b = this.propBody[pi], { cvel: cv, subtree_com: sc, xipos } = this.v;
    const px = xipos[3 * b] - sc[3 * b], py = xipos[3 * b + 1] - sc[3 * b + 1], pz = xipos[3 * b + 2] - sc[3 * b + 2];
    return [cv[6 * b + 3] + cv[6 * b + 1] * pz - cv[6 * b + 2] * py, cv[6 * b + 4] + cv[6 * b + 2] * px - cv[6 * b] * pz, cv[6 * b + 5] + cv[6 * b] * py - cv[6 * b + 1] * px];
  }
  propSpin(pi: number): Vec3 {
    this.views();
    const b = this.propBody[pi], cv = this.v.cvel; // cvel: angular (world) first, then linear
    return [cv[6 * b], cv[6 * b + 1], cv[6 * b + 2]];
  }
  pushProp(pi: number, force: Vec3, torque: Vec3) {
    const b = this.propBody[pi] * 6;
    for (let k = 0; k < 3; k++) { this.xfrc[b + k] += force[k]; this.xfrc[b + 3 + k] += torque[k]; }
  }
  readQ(out: Float32Array | Float64Array) { this.views(); out.set(this.v.qpos); }
  writeQ(q: ArrayLike<number>, qd?: ArrayLike<number>) {
    this.views();
    const { qpos, qvel } = this.v;
    for (let i = 0; i < this.nq; i++) qpos[i] = q[i];
    for (let i = 0; i < this.nv; i++) qvel[i] = qd ? qd[i] : 0;
    mj.mj_forward(this.m, this.d);
    this.views();
    this.cache = null; this.limitsStale = true;
    this.read();
  }
  diffQ(q0: ArrayLike<number>, q1: ArrayLike<number>, dt: number, out: Float64Array) {
    this.hingeQ.forEach((a, k) => (out[this.hingeV[k]] = (q1[a] - q0[a]) / dt));
    this.freeQ.forEach((a, k) => {
      const v = this.freeV[k], r = qlog(qmul(qconj([q0[a + 4], q0[a + 5], q0[a + 6], q0[a + 3]]), [q1[a + 4], q1[a + 5], q1[a + 6], q1[a + 3]]));
      for (let i = 0; i < 3; i++) { out[v + i] = (q1[a + i] - q0[a + i]) / dt; out[v + 3 + i] = r[i] / dt; }
    });
  }
  /** Divergence warnings MuJoCo has raised (each one reset the data). */
  private warnings() {
    const w = this.d.warning, n = (k: Any) => (w.get ? w.get(k.value) : w[k.value])?.number ?? 0, W = mj.mjtWarning;
    return n(W.mjWARN_BADQACC) + n(W.mjWARN_BADQPOS) + n(W.mjWARN_BADQVEL);
  }
  stats() {
    return { contacts: this.d.ncon, bodies: this.m.nbody - 1, instabilities: this.instab };
  }
  destroy() { this.forceBuf.delete(); this.d.delete(); this.m.delete(); }
}
