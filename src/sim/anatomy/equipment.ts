// Equipment, ball and turf constants [S5]. Masses in kg, sizes in m.
export const EQUIPMENT = {
  helmet: { mass: 1.95, radius: 0.135, topClearance: 0.035 }, // shell + liner + facemask (modern models 1.7–2.2 kg); sphere approximation of a 0.30 × 0.24 × 0.26 m shell
  facemask: { radius: 0.022 },
  pads: { mass: 2.2, halfWidth: 0.25, halfHeight: 0.07, halfDepth: 0.16 }, // skill 1.4–2.3 kg, linemen ~2.7 kg
  jersey: { mass: 0.3, tearStrength: 1000 },                    // tear (N) when grabbed by a fist: ~3 × a 25 mm-jaw grab test's 250–500 N, a fist gathers ~75–100 mm of knit [assumption]
  cleats: { mass: 0.32, soleHeight: 0.025 },                    // per shoe; sole + stud height
};

/** Contact compliance (MuJoCo solref time constant, s) per surface. Defined in seconds, not steps, so
 *  contacts behave the same at every physics rate; 0.0084 s = 2 steps at the 240 Hz minimum rate. [S5] */
export const CONTACT = {
  body: { timeconst: 0.0084, dampRatio: 1 },   // bare segments and helmet shell (helmet–helmet ~1.3–2.3e5 N/m is stiffer than 240 Hz allows)
  pad: { timeconst: 0.02, dampRatio: 1 },      // shoulder pads ~7e4 N/m, padded impacts last 10–12 ms
};

/** Grip constraint compliance (s): hand grip and jersey grab (fabric stretch) [S5, assumption]. */
export const GRIP_TIMECONST = { hand: 0.025, jersey: 0.06 };

/** Cleat-on-turf traction [S5]: translational coefficient (infill turf 1.1–1.3), torsional friction
 *  length (m; ~50 N·m rotational traction at ~1 kN normal load), rolling. */
export const TURF = { mu: 1.2, torsional: 0.05, rolling: 0.0001 };

/** Regulation ball [S5]. */
export const BALL = { mass: 0.41, length: 0.28, diameter: 0.17 };
