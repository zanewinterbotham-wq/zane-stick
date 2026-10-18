// Builds an athlete's body plan (segments, joints, collision shapes, equipment) from height and mass.
// Everything is expressed in the rest pose: standing at the origin, facing +Z, arms hanging, +X = left.

import { add, deg, scale, sub, type Vec3 } from '../math';
import { DE_LEVA, FUSE_RANGE_TRANSFER, GRIP_STRENGTH, JOINTS, PROPORTIONS as P, STRENGTH_REF_MASS } from './data';
import { boxInertia, cylinderInertia, diag, madd, msub, parallel, type Mat3 } from './inertia';
import { EQUIPMENT } from './equipment';

export type Detail = 'minimum' | 'standard';
export type GeomRole = 'body' | 'hand' | 'foot' | 'helmet' | 'facemask' | 'pad';

export interface GeomPlan {
  name: string;
  type: 'box' | 'capsule' | 'sphere';
  size: number[];          // box: half extents; capsule: [r]; sphere: [r]
  pos?: Vec3;              // box/sphere centre (world, rest)
  fromto?: [Vec3, Vec3];   // capsule end points (world, rest)
  role: GeomRole;
}
export interface SegmentPlan {
  name: string;
  parent: string | null;
  side: -1 | 0 | 1;        // +1 left, −1 right
  origin: Vec3;            // body frame origin = proximal joint centre (root: COM) (world, rest)
  mass: number;
  com: Vec3;               // world, rest
  inertia: Mat3;           // about COM, world axes
  geoms: GeomPlan[];
  /** Body tissue mass only (no equipment), for reporting. */
  tissueMass: number;
}
export interface DofPlan {
  name: string;
  axis: Vec3;              // world (rest) = parent frame
  range: [number, number]; // rad
  tPos: number; tNeg: number; // N·m
  wMax: number;            // rad/s
}
export interface JointPlan { name: string; side: -1 | 0 | 1; parent: string; child: string; pos: Vec3; dofs: DofPlan[]; damping: number }
export interface AthleteParams {
  height: number;          // m (stature, barefoot)
  mass: number;            // kg (body, without equipment)
  strength: number;        // scale on peak torques, 1 = reference athlete
  speed: number;           // scale on max joint velocities
}
export interface BodyPlan {
  params: AthleteParams;
  detail: Detail;
  segments: SegmentPlan[];
  joints: JointPlan[];
  gripStrength: number;    // N per hand
  standHeight: number;     // pelvis origin height at rest (m)
}

export const DEFAULT_ATHLETE: AthleteParams = { height: 1.83, mass: 95, strength: 1, speed: 1 };

const mirrorAxis = (a: Vec3, side: number): Vec3 => (side < 0 ? [a[0], -a[1], -a[2]] : a);
const pct = (x: number) => x / 100;

export function buildBody(params: AthleteParams, detail: Detail = 'standard'): BodyPlan {
  const plan = buildStandard(params);
  return detail === 'minimum' ? toMinimum(plan) : plan;
}

function buildStandard(params: AthleteParams): BodyPlan {
  const H = params.height, M = params.mass, D = DE_LEVA;
  const c = EQUIPMENT.cleats.soleHeight; // body stands on cleats
  // Widths scale with sqrt(BMI / reference BMI): heavier athletes are thicker, not taller.
  const g = Math.sqrt((M / (H * H)) / (D.refMass / (D.refStature / 1000) ** 2));
  // Vertical chain ankle→knee→hip→C7→vertex scaled so the vertex lands exactly at stature [S2].
  const chainMm = D.shank.len + D.thigh.len + D.trunk.len + D.head.len;
  const fv = (H * (1 - P.ankleHeight)) / chainMm; // m per de Leva mm, vertical chain
  const fl = H / D.refStature;                     // m per de Leva mm, limbs
  const yAnkle = c + P.ankleHeight * H;
  const yKnee = yAnkle + D.shank.len * fv;
  const yHip = yKnee + D.thigh.len * fv;
  const yOmph = yHip + D.lpt.len * fv;
  const yXiph = yOmph + D.mpt.len * fv;
  const ySupr = yXiph + D.upt.len * fv;
  const yCerv = yHip + D.trunk.len * fv;
  const yVert = yCerv + D.head.len * fv;
  const yAO = c + P.aoHeight * H;
  const yShoulder = c + P.shoulderHeight * H;

  const segs: SegmentPlan[] = [];
  const seg = (name: string, parent: string | null, side: -1 | 0 | 1, origin: Vec3, mass: number, com: Vec3, inertia: Mat3, geoms: GeomPlan[]) => {
    const s = { name, parent, side, origin, mass, com, inertia, geoms, tissueMass: mass };
    segs.push(s);
    return s;
  };
  /** de Leva inertia: rg % of segment length; axes order [sagittal(X), transverse(Z), longitudinal(Y or Z for foot)]. */
  const rgI = (m: number, lenM: number, rg: readonly number[], longAxis: 1 | 2 = 1): Mat3 => {
    const [s, t, l] = rg.map((r) => m * (pct(r) * lenM) ** 2);
    return longAxis === 1 ? diag([s, l, t]) : diag([s, t, l]);
  };
  const box = (name: string, center: Vec3, half: Vec3, role: GeomRole = 'body'): GeomPlan => ({ name, type: 'box', size: half, pos: center, role });
  const cap = (name: string, a: Vec3, b: Vec3, r: number, role: GeomRole = 'body'): GeomPlan => ({ name, type: 'capsule', size: [r], fromto: [a, b], role });

  // ---- Trunk: pelvis = LPT, lumbar = MPT, thorax = UPT minus the two shoulder girdles [S1][S2].
  const back = -P.spineBack * H;
  const pelvisM = pct(D.lpt.mass) * M;
  const pelvisCom: Vec3 = [0, yOmph - pct(D.lpt.com) * (yOmph - yHip), 0];
  seg('pelvis', null, 0, pelvisCom, pelvisM, pelvisCom, rgI(pelvisM, D.lpt.len * fv, D.lpt.rg), [
    box('pelvis', [0, (yHip - 0.03 * H + yOmph) / 2, -0.01 * H], [P.pelvis[0] * H * g, (yOmph - yHip + 0.03 * H) / 2, P.pelvis[2] * H * g]),
  ]);
  const lumbarM = pct(D.mpt.mass) * M;
  seg('lumbar', 'pelvis', 0, [0, yOmph, back], lumbarM, [0, yXiph - pct(D.mpt.com) * (yXiph - yOmph), 0], rgI(lumbarM, D.mpt.len * fv, D.mpt.rg), [
    box('lumbar', [0, (yOmph + yXiph) / 2, 0], [P.lumbar[0] * H * g, (yXiph - yOmph) / 2, P.lumbar[2] * H * g]),
  ]);
  const uptM = pct(D.upt.mass) * M;
  const uptCom: Vec3 = [0, ySupr - pct(D.upt.com) * (ySupr - yXiph), 0];
  const uptI = rgI(uptM, D.upt.len * fv, D.upt.rg);
  // Shoulder girdles (clavicle + scapula) split out of UPT; thorax keeps the rest so UPT totals are preserved.
  const girdles = ([1, -1] as const).map((s) => {
    const sc: Vec3 = [s * P.scHalfWidth * H, ySupr, P.scForward * H];
    const gh: Vec3 = [s * P.shoulderHalfWidth * H, yShoulder, 0];
    const m = P.girdleMassFrac * uptM;
    const com: Vec3 = add(scale(add(sc, gh), 0.5), [0, -0.01 * H, -0.02 * H]);
    const L = Math.hypot(...sub(gh, sc));
    return { s, sc, gh, m, com, I: diag(boxInertia(m, [L / 2, 0.03 * H, 0.025 * H])) };
  });
  const thoraxM = uptM - girdles.reduce((a, x) => a + x.m, 0);
  const thoraxCom = scale(girdles.reduce((a, x) => sub(a, scale(x.com, x.m)), scale(uptCom, uptM)), 1 / thoraxM);
  let thoraxI = msub(uptI, parallel(thoraxM, sub(thoraxCom, uptCom)));
  for (const x of girdles) thoraxI = msub(thoraxI, madd(x.I, parallel(x.m, sub(x.com, uptCom))));
  seg('thorax', 'lumbar', 0, [0, yXiph, back], thoraxM, thoraxCom, thoraxI, [
    box('thorax', [0, (yXiph + yCerv - 0.01 * H) / 2, 0], [P.thorax[0] * H * g, (yCerv - 0.01 * H - yXiph) / 2, P.thorax[2] * H * g]),
  ]);

  // ---- Neck and head: de Leva head+neck split so the combined COM and inertia match [S1][S2].
  const hnM = pct(D.head.mass) * M;
  const hnCom: Vec3 = [0, yVert - pct(D.head.com) * (yVert - yCerv), 0];
  const hnI = rgI(hnM, D.head.len * fv, D.head.rg);
  const headComY = c + P.headComHeight * H, neckComY = (yCerv + yAO) / 2;
  const neckFrac = (headComY - hnCom[1]) / (headComY - neckComY);
  const neckM = neckFrac * hnM, headM = hnM - neckM;
  const neckR = P.r.neck * H * g;
  const neckCom: Vec3 = [0, neckComY, back / 2];
  const neckI = diag(cylinderInertia(neckM, neckR, yAO - yCerv, 1));
  const headCom: Vec3 = scale(sub(scale(hnCom, hnM), scale(neckCom, neckM)), 1 / headM);
  const headI = msub(msub(hnI, madd(neckI, parallel(neckM, sub(neckCom, hnCom)))), parallel(headM, sub(headCom, hnCom)));
  seg('neck', 'thorax', 0, [0, yCerv, back * 0.66], neckM, neckCom, neckI, [cap('neck', [0, yCerv, back * 0.5], [0, yAO, 0], neckR)]);
  seg('head', 'neck', 0, [0, yAO, back * 0.2], headM, headCom, headI, [{ name: 'head', type: 'sphere', size: [P.headRadius * H], pos: [0, (yAO + yVert) / 2 + 0.01 * H, 0.01 * H], role: 'body' }]);

  // ---- Arms [S1][S2].
  for (const s of [1, -1] as const) {
    const sx = s > 0 ? 'L' : 'R';
    const gd = girdles.find((x) => x.s === s)!;
    seg('clavicle' + sx, 'thorax', s, gd.sc, gd.m, gd.com, gd.I, [cap('clavicle' + sx, gd.sc, gd.gh, P.r.clavicle * H * g)]);
    const sh = gd.gh;
    const el: Vec3 = [sh[0], sh[1] - D.upperArm.len * fl, 0];
    const wr: Vec3 = [sh[0], el[1] - D.forearm.len * fl, 0];
    const met: Vec3 = [sh[0], wr[1] - D.hand.len * fl, 0];
    const limb = (name: string, parent: string, a: Vec3, b: Vec3, d: (typeof D)['upperArm' | 'forearm' | 'hand' | 'thigh' | 'shank'], r: number, len: number) => {
      const m = pct(d.mass) * M;
      seg(name + sx, parent + sx, s, a, m, add(a, scale(sub(b, a), pct(d.com))), rgI(m, len, d.rg), r > 0 ? [cap(name + sx, a, b, r)] : []);
    };
    limb('upperArm', 'clavicle', sh, el, D.upperArm, P.r.upperArm * H * g, D.upperArm.len * fl);
    limb('forearm', 'upperArm', el, wr, D.forearm, P.r.forearm * H * g, D.forearm.len * fl);
    limb('hand', 'forearm', wr, met, D.hand, 0, D.hand.len * fl);
    const hand = segs[segs.length - 1];
    hand.geoms.push(box('hand' + sx, [wr[0], wr[1] - P.hand[1] * H, 0], [P.hand[0] * H * g, P.hand[1] * H, P.hand[2] * H], 'hand'));
  }

  // ---- Legs [S1][S2].
  const footLen = D.foot.len * fl;
  for (const s of [1, -1] as const) {
    const sx = s > 0 ? 'L' : 'R';
    const x = s * P.hipHalfWidth * H;
    const hip: Vec3 = [x, yHip, 0], knee: Vec3 = [x, yKnee, 0], ankle: Vec3 = [x, yAnkle, 0];
    const thM = pct(D.thigh.mass) * M, shM = pct(D.shank.mass) * M;
    seg('thigh' + sx, 'pelvis', s, hip, thM, add(hip, scale(sub(knee, hip), pct(D.thigh.com))), rgI(thM, D.thigh.len * fv, D.thigh.rg), [cap('thigh' + sx, hip, knee, P.r.thigh * H * g)]);
    seg('shank' + sx, 'thigh' + sx, s, knee, shM, add(knee, scale(sub(ankle, knee), pct(D.shank.com))), rgI(shM, D.shank.len * fv, D.shank.rg), [cap('shank' + sx, knee, ankle, P.r.shank * H * g)]);
    // Foot split into rear/mid foot and toes at the MTP line; foot+toes reproduce de Leva's foot [S1][S2].
    const zHeel = -P.heelBehindAnkle * footLen, zMtp = zHeel + P.mtpFromHeel * footLen, zTip = zHeel + footLen;
    const ftM = pct(D.foot.mass) * M;
    const ftCom: Vec3 = [x, c + 0.5 * P.footHeight * H, zHeel + pct(D.foot.com) * footLen];
    const ftI = rgI(ftM, footLen, D.foot.rg, 2);
    const toesM = P.toesMassFrac * ftM, toesHalf: Vec3 = [P.footHalfWidth * H * g, (c + P.toesHeight * H) / 2, (zTip - zMtp) / 2];
    const toesCom: Vec3 = [x, toesHalf[1], (zMtp + zTip) / 2];
    const toesI = diag(boxInertia(toesM, [toesHalf[0], P.toesHeight * H / 2, toesHalf[2]]));
    const rearM = ftM - toesM;
    const rearCom = scale(sub(scale(ftCom, ftM), scale(toesCom, toesM)), 1 / rearM);
    const rearI = msub(msub(ftI, madd(toesI, parallel(toesM, sub(toesCom, ftCom)))), parallel(rearM, sub(rearCom, ftCom)));
    const footTop = yAnkle - 0.012 * H;
    seg('foot' + sx, 'shank' + sx, s, ankle, rearM, rearCom, rearI, [box('foot' + sx, [x, footTop / 2, (zHeel + zMtp) / 2], [P.footHalfWidth * H * g, footTop / 2, (zMtp - zHeel) / 2], 'foot')]);
    seg('toes' + sx, 'foot' + sx, s, [x, c + 0.5 * P.toesHeight * H, zMtp], toesM, toesCom, toesI, [box('toes' + sx, toesCom.slice() as Vec3, toesHalf, 'foot')]);
  }

  // ---- Joints [S3][S4].
  const segByName = new Map(segs.map((s) => [s.name, s]));
  const tScale = params.strength * (M / STRENGTH_REF_MASS) ** (2 / 3); // allometric strength scaling [S4]
  const joints: JointPlan[] = [];
  for (const j of JOINTS) {
    const sides: (-1 | 0 | 1)[] = segByName.has(j.child) ? [0] : [1, -1];
    for (const s of sides) {
      const sx = s > 0 ? 'L' : s < 0 ? 'R' : '';
      const child = segByName.get(j.child + sx)!;
      joints.push({
        name: j.name + sx, side: s, parent: j.parent + (segByName.has(j.parent) ? '' : sx), child: child.name,
        pos: child.origin, damping: j.damping,
        dofs: j.dofs.map((d) => ({
          name: d.name, axis: mirrorAxis(d.axis, s), range: [deg(d.range[0]), deg(d.range[1])],
          tPos: d.tPos * tScale, tNeg: d.tNeg * tScale, wMax: d.wMax * params.speed,
        })),
      });
    }
  }

  const plan: BodyPlan = { params, detail: 'standard', segments: segs, joints, gripStrength: GRIP_STRENGTH * tScale, standHeight: pelvisCom[1] };
  addEquipment(plan, { yVert, yAO, yShoulder, yXiph, H, g });
  return plan;
}

/** Equipment adds mass on top of body mass at its segment, plus its collision shapes [S5]. */
function addEquipment(plan: BodyPlan, k: { yVert: number; yAO: number; yShoulder: number; yXiph: number; H: number; g: number }) {
  const S = (n: string) => plan.segments.find((s) => s.name === n)!;
  const E = EQUIPMENT;
  const addMass = (s: SegmentPlan, m: number, com: Vec3, I: Vec3) => {
    const total = s.mass + m;
    const newCom = scale(add(scale(s.com, s.mass), scale(com, m)), 1 / total);
    s.inertia = madd(madd(s.inertia, parallel(s.mass, sub(s.com, newCom))), madd(diag(I), parallel(m, sub(com, newCom))));
    s.mass = total; s.com = newCom;
  };
  const head = S('head');
  const helmetC: Vec3 = [0, k.yVert + E.helmet.topClearance - E.helmet.radius, 0.012];
  addMass(head, E.helmet.mass, helmetC, [1, 1, 1].map(() => (2 / 3) * E.helmet.mass * E.helmet.radius ** 2) as Vec3);
  head.geoms = [
    { name: 'helmet', type: 'sphere', size: [E.helmet.radius], pos: helmetC, role: 'helmet' },
    { name: 'facemask', type: 'capsule', size: [E.facemask.radius], fromto: [[-0.07, helmetC[1] - 0.06, helmetC[2] + E.helmet.radius - 0.01], [0.07, helmetC[1] - 0.06, helmetC[2] + E.helmet.radius - 0.01]], role: 'facemask' },
  ];
  const thorax = S('thorax');
  const padC: Vec3 = [0, k.yShoulder + 0.01 * k.H, -0.005];
  const padHalf: Vec3 = [E.pads.halfWidth * Math.sqrt(k.g), E.pads.halfHeight, E.pads.halfDepth * k.g];
  addMass(thorax, E.pads.mass, padC, boxInertia(E.pads.mass, padHalf));
  thorax.geoms.push({ name: 'pads', type: 'box', size: padHalf, pos: padC, role: 'pad' });
  addMass(thorax, E.jersey.mass, thorax.com.slice() as Vec3, [0, 0, 0]);
  for (const sx of ['L', 'R']) {
    const f = S('foot' + sx), t = S('toes' + sx);
    addMass(f, E.cleats.mass * 0.8, [f.com[0], E.cleats.soleHeight / 2, f.com[2]], [0, 0, 0]);
    addMass(t, E.cleats.mass * 0.2, [t.com[0], E.cleats.soleHeight / 2, t.com[2]], [0, 0, 0]);
  }
}

/** Fuse `child` into its parent: masses, COMs and inertias combine exactly; its joint disappears. */
export function fuse(plan: BodyPlan, child: string, rename?: string) {
  const c = plan.segments.find((s) => s.name === child)!;
  const p = plan.segments.find((s) => s.name === c.parent)!;
  const total = p.mass + c.mass;
  const com = scale(add(scale(p.com, p.mass), scale(c.com, c.mass)), 1 / total);
  p.inertia = madd(madd(p.inertia, parallel(p.mass, sub(p.com, com))), madd(c.inertia, parallel(c.mass, sub(c.com, com))));
  p.mass = total; p.com = com; p.tissueMass += c.tissueMass;
  p.geoms.push(...c.geoms);
  const ji = plan.joints.findIndex((j) => j.child === child);
  const gone = plan.joints[ji];
  plan.joints.splice(ji, 1);
  // Surviving joints inherit the fused joint's range [S3].
  const base = gone.name.replace(/[LR]$/, '');
  const sx = gone.side > 0 ? 'L' : gone.side < 0 ? 'R' : '';
  for (const [dof, target] of Object.entries(FUSE_RANGE_TRANSFER[base] ?? {})) {
    const [tj, td] = target.split('.');
    const tgt = plan.joints.find((j) => j.name === tj + sx || j.name === tj)?.dofs.find((d) => d.name === td);
    const src = gone.dofs.find((d) => d.name === dof);
    if (tgt && src) tgt.range = [tgt.range[0] + src.range[0], tgt.range[1] + src.range[1]];
  }
  for (const s of plan.segments) if (s.parent === child) s.parent = p.name;
  for (const j of plan.joints) if (j.parent === child) j.parent = p.name;
  plan.segments.splice(plan.segments.indexOf(c), 1);
  if (rename) {
    const old = p.name;
    p.name = rename;
    for (const s of plan.segments) if (s.parent === old) s.parent = rename;
    for (const j of plan.joints) { if (j.parent === old) j.parent = rename; if (j.child === old) j.child = rename; }
  }
}

/** Minimum detail: pelvis, trunk, head, upper arms, forearms(+hands), thighs, shanks, feet(+toes). */
function toMinimum(plan: BodyPlan): BodyPlan {
  for (const sx of ['L', 'R']) { fuse(plan, 'clavicle' + sx); fuse(plan, 'hand' + sx); fuse(plan, 'toes' + sx); }
  fuse(plan, 'thorax', 'trunk');
  fuse(plan, 'head', 'head'); // head fused into neck; the merged segment keeps the name 'head'
  plan.detail = 'minimum';
  return plan;
}

export const totalMass = (p: BodyPlan) => p.segments.reduce((a, s) => a + s.mass, 0);
export function wholeCom(p: BodyPlan): Vec3 {
  const m = totalMass(p);
  return scale(p.segments.reduce((a, s) => add(a, scale(s.com, s.mass)), [0, 0, 0] as Vec3), 1 / m);
}
/** Whole-body inertia about the whole-body COM (rest pose). */
export function wholeInertia(p: BodyPlan): Mat3 {
  const c = wholeCom(p);
  return p.segments.reduce((a, s) => madd(a, madd(s.inertia, parallel(s.mass, sub(s.com, c)))), diag([0, 0, 0]));
}
