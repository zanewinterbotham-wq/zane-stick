// Anatomical source data. Every value cites docs/realism-sources.md by section tag [S#].
// Frame: Y up, athlete faces +Z, +X is the athlete's LEFT. Axes below are for the LEFT side; the
// right side mirrors them through the sagittal plane: (x, y, z) -> (x, -y, -z) for rotation axes.

import type { Vec3 } from '../math';

/** de Leva (1996) male table [S1]. len in mm at reference stature 1741 mm, mass 73.0 kg.
 *  com = % of length from the first-named (origin) endpoint; rg = radii of gyration in % of length
 *  about the sagittal (mediolateral), transverse (anteroposterior) and longitudinal axes.
 *  Endpoint choices: head VERT–CERV (includes the neck), shank KJC–AJC and hand WJC–DAC3 so every
 *  segment runs joint centre to joint centre (or to the fingertip). */
export const DE_LEVA = {
  refStature: 1741, refMass: 73.0,
  head: { from: 'VERT', to: 'CERV', len: 242.9, mass: 6.94, com: 50.02, rg: [30.3, 31.5, 26.1] },
  trunk: { from: 'CERV', to: 'MIDH', len: 603.3, mass: 43.46, com: 51.38, rg: [32.8, 30.6, 16.9] },
  upt: { from: 'SUPR', to: 'XYPH', len: 170.7, mass: 15.96, com: 29.99, rg: [71.6, 45.4, 65.9] },
  mpt: { from: 'XYPH', to: 'OMPH', len: 215.5, mass: 16.33, com: 45.02, rg: [48.2, 38.3, 46.8] },
  lpt: { from: 'OMPH', to: 'MIDH', len: 145.7, mass: 11.17, com: 61.15, rg: [61.5, 55.1, 58.7] },
  upperArm: { from: 'SJC', to: 'EJC', len: 281.7, mass: 2.71, com: 57.72, rg: [28.5, 26.9, 15.8] },
  forearm: { from: 'EJC', to: 'WJC', len: 268.9, mass: 1.62, com: 45.74, rg: [27.6, 26.5, 12.1] },
  hand: { from: 'WJC', to: 'DAC3', len: 187.9, mass: 0.61, com: 36.24, rg: [28.8, 23.5, 18.4] },
  thigh: { from: 'HJC', to: 'KJC', len: 422.2, mass: 14.16, com: 40.95, rg: [32.9, 32.9, 14.9] },
  shank: { from: 'KJC', to: 'AJC', len: 440.3, mass: 4.33, com: 43.95, rg: [25.1, 24.6, 10.2] },
  foot: { from: 'HEEL', to: 'TTIP', len: 258.1, mass: 1.37, com: 44.15, rg: [25.7, 24.5, 12.4] },
} as const;

/** Reference body for the ANSUR II shape ratios below [S2]: male means, 1.7562 m, 85.52 kg. */
export const ANSUR_REF = { stature: 1.7562, mass: 85.52 };

/** Landmark and shape ratios not in de Leva [S2]; fractions of stature unless noted. */
export const PROPORTIONS = {
  ankleHeight: 0.0384,       // ankle joint centre height / stature [S2, assumption]
  hipHalfWidth: 0.052,       // hip joint centre half-separation / stature [S2, assumption]
  shoulderHalfWidth: 0.110,  // GH centre: (biacromial 0.4157 m / 2 − 15 mm) / 1.7562 m [S2]
  shoulderHeight: 0.80,      // GH centre height / stature [S2, assumption]
  aoHeight: 0.90,            // head–neck (atlanto-occipital) joint height / stature [S2, assumption]
  neckShareOfHead: 0.208,    // neck share of de Leva head+neck mass (VIVA+ model) [S2]
  scHalfWidth: 0.012, scForward: 0.035, // sternoclavicular joint position / stature [S2, assumption]
  spineBack: 0.03,           // spine joints sit this far behind the hip-centre plane / stature [S2, assumption]
  heelBehindAnkle: 0.21,     // heel-to-ankle-joint distance / foot length [S2, assumption]
  mtpFromHeel: 0.72,         // MTP line / foot length from heel [S2, assumption]
  toesMassFrac: 0.138,       // toes share of foot mass (OpenSim gait2392) [S2]
  girdleMassFrac: 0.072,     // each clavicle+scapula / UPT mass: 0.86 kg of a 75 kg body (MOBL-ARMS) [S2]
  // Shapes from ANSUR II male means at the ANSUR reference body; widths scale with sqrt(BMI ratio) [S2].
  r: { neck: 0.036, upperArm: 0.026, forearm: 0.021, thigh: 0.045, shank: 0.028, clavicle: 0.022 },
  pelvis: [0.0984, 0.056, 0.070] as Vec3,  // box half extents / stature (hip breadth, —, buttock depth)
  lumbar: [0.093, 0.061, 0.068] as Vec3,   // (waist breadth, —, waist depth)
  thorax: [0.0824, 0.068, 0.0723] as Vec3, // (chest breadth, —, chest depth)
  hand: [0.013, 0.055, 0.025] as Vec3,     // half extents (thickness, length to fingertip 0.110, breadth 0.0503) / stature
  footHalfWidth: 0.029, footHeight: 0.036, toesHeight: 0.016,
  headRadius: 0.05,                         // ≈ ½ head breadth (0.1543 m) / stature
};

export interface DofSpec {
  name: string;
  axis: Vec3;          // left-side rotation axis in the parent frame at rest
  range: [number, number]; // degrees, [negative direction limit, positive direction limit] [S3]
  tPos: number;        // peak isometric torque in the + direction, reference athlete (N·m) [S4]
  tNeg: number;        // peak isometric torque in the − direction (N·m) [S4]
  wMax: number;        // max joint angular velocity for the torque–velocity curve (rad/s) [S4]
}
export interface JointSpec { name: string; parent: string; child: string; dofs: DofSpec[]; damping: number }

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const nX: Vec3 = [-1, 0, 0], nY: Vec3 = [0, -1, 0], nZ: Vec3 = [0, 0, -1];

/** Reference athlete for strengths: a 90 kg college football player [S4]. */
export const STRENGTH_REF_MASS = 90;

// Ranges [S3]; strengths and wMax [S4]; passive damping [S3] (N·m·s/rad).
// Sign conventions: + flexion, + abduction, + internal rotation, + dorsiflexion, + elevation,
// + protraction, + pronation, + inversion, + left lateral bend, + left rotation (spine/neck).
export const JOINTS: JointSpec[] = [
  { name: 'lumbar', parent: 'pelvis', child: 'lumbar', damping: 5, dofs: [
    { name: 'flex', axis: X, range: [-16, 51], tPos: 165, tNeg: 320, wMax: 10 },
    { name: 'latL', axis: nZ, range: [-18, 18], tPos: 210, tNeg: 210, wMax: 10 },
    { name: 'rotL', axis: Y, range: [-5, 5], tPos: 115, tNeg: 115, wMax: 10 },
  ] },
  { name: 'thoracic', parent: 'lumbar', child: 'thorax', damping: 5, dofs: [
    { name: 'flex', axis: X, range: [-20, 35], tPos: 165, tNeg: 320, wMax: 10 },
    { name: 'latL', axis: nZ, range: [-20, 20], tPos: 210, tNeg: 210, wMax: 10 },
    { name: 'rotL', axis: Y, range: [-30, 30], tPos: 115, tNeg: 115, wMax: 10 },
  ] },
  { name: 'neckLow', parent: 'thorax', child: 'neck', damping: 0.5, dofs: [
    { name: 'flex', axis: X, range: [-28, 35], tPos: 40, tNeg: 70, wMax: 10 },
    { name: 'latL', axis: nZ, range: [-33, 33], tPos: 48, tNeg: 48, wMax: 10 },
    { name: 'rotL', axis: Y, range: [-35, 35], tPos: 20, tNeg: 20, wMax: 10 },
  ] },
  { name: 'neckUp', parent: 'neck', child: 'head', damping: 0.5, dofs: [
    { name: 'flex', axis: X, range: [-32, 15], tPos: 30, tNeg: 55, wMax: 10 },
    { name: 'latL', axis: nZ, range: [-12, 12], tPos: 35, tNeg: 35, wMax: 10 },
    { name: 'rotL', axis: Y, range: [-45, 45], tPos: 20, tNeg: 20, wMax: 10 },
  ] },
  { name: 'sc', parent: 'thorax', child: 'clavicle', damping: 0.5, dofs: [
    { name: 'elev', axis: Z, range: [-10, 45], tPos: 110, tNeg: 80, wMax: 12 },
    { name: 'protr', axis: nY, range: [-30, 15], tPos: 70, tNeg: 70, wMax: 12 },
  ] },
  { name: 'shoulder', parent: 'clavicle', child: 'upperArm', damping: 1, dofs: [
    { name: 'flex', axis: nX, range: [-60, 120], tPos: 115, tNeg: 145, wMax: 30 },
    { name: 'abd', axis: Z, range: [-40, 120], tPos: 115, tNeg: 145, wMax: 30 },
    { name: 'intRot', axis: nY, range: [-90, 70], tPos: 90, tNeg: 57, wMax: 30 },
  ] },
  { name: 'elbow', parent: 'upperArm', child: 'forearm', damping: 0.3, dofs: [
    { name: 'flex', axis: nX, range: [-3, 145], tPos: 115, tNeg: 90, wMax: 30 },
    { name: 'pron', axis: nY, range: [-85, 77], tPos: 20, tNeg: 25, wMax: 25 },
  ] },
  { name: 'wrist', parent: 'forearm', child: 'hand', damping: 0.1, dofs: [
    { name: 'flex', axis: nZ, range: [-70, 80], tPos: 35, tNeg: 20, wMax: 25 },
    { name: 'radDev', axis: nX, range: [-30, 20], tPos: 25, tNeg: 25, wMax: 25 },
  ] },
  { name: 'hip', parent: 'pelvis', child: 'thigh', damping: 2, dofs: [
    { name: 'flex', axis: nX, range: [-20, 120], tPos: 240, tNeg: 340, wMax: 25 },
    { name: 'abd', axis: Z, range: [-30, 45], tPos: 200, tNeg: 170, wMax: 20 },
    { name: 'intRot', axis: nY, range: [-45, 40], tPos: 120, tNeg: 90, wMax: 20 },
  ] },
  { name: 'knee', parent: 'thigh', child: 'shank', damping: 1, dofs: [
    { name: 'flex', axis: X, range: [-3, 140], tPos: 200, tNeg: 320, wMax: 25 },
    { name: 'intRot', axis: nY, range: [-15, 15], tPos: 40, tNeg: 40, wMax: 15 },
  ] },
  { name: 'ankle', parent: 'shank', child: 'foot', damping: 0.5, dofs: [
    { name: 'dorsi', axis: nX, range: [-50, 15], tPos: 70, tNeg: 220, wMax: 22 },
    { name: 'inv', axis: nZ, range: [-20, 35], tPos: 55, tNeg: 40, wMax: 18 },
  ] },
  { name: 'toe', parent: 'foot', child: 'toes', damping: 0.1, dofs: [
    { name: 'ext', axis: nX, range: [-45, 70], tPos: 20, tNeg: 40, wMax: 20 },
  ] },
];

/** Hand-muscle constants [S4]. */
export const GRIP_STRENGTH = 570;      // N per hand, reference athlete
/** Hill torque–velocity: curvature a/T0 and eccentric plateau (× isometric) [S4]. */
export const HILL = { k: 0.3, eccMax: 1.3 };

/** When a segment is fused away (lower detail), the surviving joint inherits these extra ranges [S3]:
 *  fused joint dof → surviving joint dof. Strengths stay at the surviving joint. */
export const FUSE_RANGE_TRANSFER: Record<string, Record<string, string>> = {
  thoracic: { flex: 'lumbar.flex', latL: 'lumbar.latL', rotL: 'lumbar.rotL' },
  neckUp: { flex: 'neckLow.flex', latL: 'neckLow.latL', rotL: 'neckLow.rotL' },
  sc: { elev: 'shoulder.abd', protr: 'shoulder.flex' },
};
