// Equipment, ball and turf constants [S5]. Masses in kg, sizes in m.
export const EQUIPMENT = {
  helmet: { mass: 2.0, radius: 0.14, topClearance: 0.035 },   // shell + liner + facemask, approximated as a sphere
  facemask: { radius: 0.022 },
  pads: { mass: 2.5, halfWidth: 0.25, halfHeight: 0.07, halfDepth: 0.16 },
  jersey: { mass: 0.3, slack: 0.06, tearStrength: 900 },       // slack (m) before the fabric pulls taut; tear (N)
  cleats: { mass: 0.35, soleHeight: 0.025 },                    // per shoe; sole + stud height
};

/** Contact compliance per surface role. timeconst in units of the physics timestep (MuJoCo solref). [S5] */
export const CONTACT = {
  body: { timeSteps: 2, dampRatio: 1 },     // bare segments: as stiff as the step allows (prevents pass-through)
  pad: { timeSteps: 6, dampRatio: 1 },      // shoulder pads compress
  helmet: { timeSteps: 5, dampRatio: 1 },   // helmet liner compresses
};

/** Grip constraint compliance (s): hand grip and jersey grab (fabric stretch) [S5, assumption]. */
export const GRIP_TIMECONST = { hand: 0.025, jersey: 0.06 };

/** Cleat-on-turf traction [S5]. */
export const TURF = { mu: 1.2, torsional: 0.03, rolling: 0.0001 };

/** Regulation ball [S5]: prolate spheroid approximated for collision as a capsule. */
export const BALL = { mass: 0.41, length: 0.28, diameter: 0.17 };
