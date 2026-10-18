// Anatomical source data. Every value cites docs/realism-sources.md by section tag [S#].
// Frame: Y up, athlete faces +Z, +X is the athlete's LEFT. Axes below are for the LEFT side; the
// right side mirrors them through the sagittal plane: (x, y, z) -> (x, -y, -z) for rotation axes.

import type { Vec3 } from '../math';

/** de Leva (1996) male table [S1]. len in mm at reference stature 1741 mm, mass 73.0 kg.
 *  com = % of length from the first-named (proximal/cranial) endpoint; rg = radii of gyration
 *  in % of length about the sagittal (mediolateral), transverse (anteroposterior) and longitudinal axes. */
export const DE_LEVA = {
  refStature: 1741, refMass: 73.0,
  head: { from: 'VERT', to: 'CERV', len: 242.9, mass: 6.94, com: 59.76, rg: [36.2, 37.6, 31.2] },
  trunk: { from: 'CERV', to: 'MIDH', len: 603.3, mass: 43.46, com: 44.86, rg: [37.2, 34.7, 19.1] },
  upt: { from: 'SUPR', to: 'XIPH', len: 170.7, mass: 15.96, com: 29.99, rg: [71.6, 45.4, 65.9] },
  mpt: { from: 'XIPH', to: 'OMPH', len: 215.5, mass: 16.33, com: 45.02, rg: [48.2, 38.3, 46.8] },
  lpt: { from: 'OMPH', to: 'MIDH', len: 145.7, mass: 11.17, com: 61.15, rg: [61.5, 55.1, 58.7] },
  upperArm: { from: 'SJC', to: 'EJC', len: 281.7, mass: 2.71, com: 57.72, rg: [28.5, 26.9, 15.8] },
  forearm: { from: 'EJC', to: 'WJC', len: 268.9, mass: 1.62, com: 45.74, rg: [27.6, 26.5, 12.1] },
  hand: { from: 'WJC', to: 'MET3', len: 86.2, mass: 0.61, com: 79.0, rg: [62.8, 51.3, 40.1] },
  thigh: { from: 'HJC', to: 'KJC', len: 422.2, mass: 14.16, com: 40.95, rg: [32.9, 32.9, 14.9] },
  shank: { from: 'KJC', to: 'LMAL', len: 434.0, mass: 4.33, com: 44.59, rg: [25.5, 24.9, 10.3] },
  foot: { from: 'HEEL', to: 'TTIP', len: 258.1, mass: 1.37, com: 44.15, rg: [25.7, 24.5, 12.4] },
} as const;

/** Landmark and shape ratios not in de Leva [S2]; fractions of stature unless noted. */
export const PROPORTIONS = {
  ankleHeight: 0.0384,       // lateral malleolus height / stature [S2, assumption]
  hipHalfWidth: 0.052,       // hip joint centre half-separation / stature [S2]
  shoulderHalfWidth: 0.105,  // glenohumeral centre half-separation / stature [S2]
  shoulderHeight: 0.80,      // glenohumeral centre height / stature [S2]
  aoHeight: 0.90,            // atlanto-occipital (head-neck) joint height / stature [S2, assumption]
  headComHeight: 0.927,      // head-alone COM height / stature, used to split de Leva head+neck [S2, assumption]
  scHalfWidth: 0.012, scForward: 0.035, // sternoclavicular joint position / stature [S2, assumption]
  spineBack: 0.03,           // spine joints sit this far behind the hip-centre plane / stature [S2, assumption]
  heelBehindAnkle: 0.21,     // heel-to-ankle-joint distance / foot length [S2, assumption]
  mtpFromHeel: 0.72,         // first-MTP position / foot length from heel [S2]
  toesMassFrac: 0.15,        // toes share of foot mass [S2, assumption]
  girdleMassFrac: 0.10,      // each clavicle+scapula share of UPT mass [S2, assumption]
  // Shape sizes at reference build (73 kg, 1.741 m); widths scale with sqrt(BMI ratio).
  r: { neck: 0.034, upperArm: 0.026, forearm: 0.021, thigh: 0.042, shank: 0.028, clavicle: 0.022 },
  pelvis: [0.098, 0.056, 0.065] as Vec3,  // box half extents / stature
  lumbar: [0.084, 0.061, 0.06] as Vec3,
  thorax: [0.09, 0.068, 0.068] as Vec3,
  hand: [0.014, 0.034, 0.026] as Vec3,     // box half extents (thickness x, length y, width z) / stature
  footHalfWidth: 0.029, footHeight: 0.036, toesHeight: 0.016,
  headRadius: 0.058,
};

export interface DofSpec {
  name: string;
  axis: Vec3;          // left-side rotation axis in the parent frame at rest
  range: [number, number]; // degrees, [negative direction limit, positive direction limit]
  tPos: number;        // peak isometric torque in the + direction, reference athlete (N·m) [S4]
  tNeg: number;        // peak isometric torque in the − direction (N·m) [S4]
  wMax: number;        // max joint angular velocity for the torque–velocity curve (rad/s) [S4]
}
export interface JointSpec { name: string; parent: string; child: string; dofs: DofSpec[]; damping: number }

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const nX: Vec3 = [-1, 0, 0], nY: Vec3 = [0, -1, 0], nZ: Vec3 = [0, 0, -1];

/** Reference athlete for strengths: college football player, 90 kg [S4]. */
export const STRENGTH_REF_MASS = 90;

// Ranges [S3]; strengths and wMax [S4]; passive damping [S3] (N·m·s/rad).
// Sign conventions: + flexion, + abduction, + internal rotation, + dorsiflexion, + elevation,
// + protraction, + pronation, + inversion, + left lateral bend, + left rotation (spine/neck).
export const JOINTS: JointSpec[] = [
  { name: 'lumbar', parent: 'pelvis', child: 'lumbar', damping: 2, dofs: [
    { name: 'flex', axis: X, range: [-25, 45], tPos: 250, tNeg: 330, wMax: 8 },
    { name: 'latL', axis: nZ, range: [-25, 25], tPos: 230, tNeg: 230, wMax: 8 },
    { name: 'rotL', axis: Y, range: [-8, 8], tPos: 120, tNeg: 120, wMax: 8 },
  ] },
  { name: 'thoracic', parent: 'lumbar', child: 'thorax', damping: 2, dofs: [
    { name: 'flex', axis: X, range: [-20, 30], tPos: 250, tNeg: 330, wMax: 8 },
    { name: 'latL', axis: nZ, range: [-20, 20], tPos: 230, tNeg: 230, wMax: 8 },
    { name: 'rotL', axis: Y, range: [-32, 32], tPos: 120, tNeg: 120, wMax: 8 },
  ] },
  { name: 'neckLow', parent: 'thorax', child: 'neck', damping: 0.5, dofs: [
    { name: 'flex', axis: X, range: [-45, 35], tPos: 45, tNeg: 70, wMax: 8 },
    { name: 'latL', axis: nZ, range: [-38, 38], tPos: 55, tNeg: 55, wMax: 8 },
    { name: 'rotL', axis: Y, range: [-40, 40], tPos: 25, tNeg: 25, wMax: 8 },
  ] },
  { name: 'neckUp', parent: 'neck', child: 'head', damping: 0.3, dofs: [
    { name: 'flex', axis: X, range: [-15, 15], tPos: 40, tNeg: 60, wMax: 8 },
    { name: 'latL', axis: nZ, range: [-7, 7], tPos: 45, tNeg: 45, wMax: 8 },
    { name: 'rotL', axis: Y, range: [-40, 40], tPos: 22, tNeg: 22, wMax: 8 },
  ] },
  { name: 'sc', parent: 'thorax', child: 'clavicle', damping: 0.5, dofs: [
    { name: 'elev', axis: Z, range: [-10, 40], tPos: 110, tNeg: 70, wMax: 8 },
    { name: 'protr', axis: nY, range: [-25, 25], tPos: 90, tNeg: 90, wMax: 8 },
  ] },
  { name: 'shoulder', parent: 'clavicle', child: 'upperArm', damping: 0.5, dofs: [
    { name: 'flex', axis: nX, range: [-50, 125], tPos: 100, tNeg: 125, wMax: 18 },
    { name: 'abd', axis: Z, range: [-30, 125], tPos: 90, tNeg: 125, wMax: 18 },
    { name: 'intRot', axis: nY, range: [-90, 70], tPos: 75, tNeg: 55, wMax: 20 },
  ] },
  { name: 'elbow', parent: 'upperArm', child: 'forearm', damping: 0.3, dofs: [
    { name: 'flex', axis: nX, range: [-5, 145], tPos: 85, tNeg: 75, wMax: 18 },
    { name: 'pron', axis: nY, range: [-80, 80], tPos: 12, tNeg: 14, wMax: 18 },
  ] },
  { name: 'wrist', parent: 'forearm', child: 'hand', damping: 0.1, dofs: [
    { name: 'flex', axis: nZ, range: [-70, 80], tPos: 22, tNeg: 15, wMax: 18 },
    { name: 'radDev', axis: nX, range: [-30, 20], tPos: 18, tNeg: 18, wMax: 18 },
  ] },
  { name: 'hip', parent: 'pelvis', child: 'thigh', damping: 1, dofs: [
    { name: 'flex', axis: nX, range: [-30, 120], tPos: 200, tNeg: 320, wMax: 16 },
    { name: 'abd', axis: Z, range: [-30, 45], tPos: 180, tNeg: 200, wMax: 14 },
    { name: 'intRot', axis: nY, range: [-45, 45], tPos: 90, tNeg: 90, wMax: 14 },
  ] },
  { name: 'knee', parent: 'thigh', child: 'shank', damping: 1, dofs: [
    { name: 'flex', axis: X, range: [-3, 140], tPos: 160, tNeg: 300, wMax: 20 },
    { name: 'intRot', axis: nY, range: [-15, 10], tPos: 35, tNeg: 35, wMax: 12 },
  ] },
  { name: 'ankle', parent: 'shank', child: 'foot', damping: 0.5, dofs: [
    { name: 'dorsi', axis: nX, range: [-50, 20], tPos: 60, tNeg: 230, wMax: 20 },
    { name: 'inv', axis: nZ, range: [-15, 35], tPos: 50, tNeg: 45, wMax: 15 },
  ] },
  { name: 'toe', parent: 'foot', child: 'toes', damping: 0.1, dofs: [
    { name: 'ext', axis: nX, range: [-40, 70], tPos: 15, tNeg: 30, wMax: 20 },
  ] },
];

/** Per-hand grip strength of the reference athlete (N) [S4]. */
export const GRIP_STRENGTH = 550;

/** When a segment is fused away (lower detail), the surviving joint inherits these extra ranges [S3]:
 *  fused joint dof → surviving joint dof. Strengths stay at the surviving joint. */
export const FUSE_RANGE_TRANSFER: Record<string, Record<string, string>> = {
  thoracic: { flex: 'lumbar.flex', latL: 'lumbar.latL', rotL: 'lumbar.rotL' },
  neckUp: { flex: 'neckLow.flex', latL: 'neckLow.latL', rotL: 'neckLow.rotL' },
  sc: { elev: 'shoulder.abd', protr: 'shoulder.flex' },
};
