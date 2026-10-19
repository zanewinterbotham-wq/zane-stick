// Messages between the page and the physics Worker (worker mode, docs/performance.md). The Worker runs the rep's Play
// with the player's HumanBrain; the page keeps a replica of it (the multiplayer guest's: same setup, never stepped)
// and shows each frame's snapshot. Presentation that must see every step (hit sounds and big hits, sound cues, face
// moods) runs in the Worker and comes back with the frame.
import type { HumanInput } from '../../sim/brains/human';
import type { ModeOptions, PlayConfig } from '../../sim/modes/types';
import type { Cue } from '../cues';
import type { BigHit, HitSound } from '../feel';
import type { Expression } from '../render/brows';

export type ToSim =
  /** Build rep `id`'s play (as Play.create with the player on athlete 0). */
  | { t: 'start'; id: number; cfg: PlayConfig; mode: string; options: ModeOptions; rep: number; steer: number }
  /** Run up to `n` fixed steps with this input; stop after a big hit that would start a hit-stop (`stopOnBig`). */
  | { t: 'step'; id: number; n: number; input: HumanInput | null; stopOnBig: boolean }
  | { t: 'stop' };

export type FromSim =
  | { t: 'ready'; id: number; snap: ArrayBuffer }
  /** One request's result: the snapshot after it, the steps run (ms of Worker time), and what they produced. */
  | { t: 'frame'; id: number; steps: number; ms: number; snap: ArrayBuffer; sounds: HitSound[]; cues: Cue[]; big: BigHit | null; best: BigHit | null; first: BigHit | null; faces: Expression[]; contact: boolean }
  | { t: 'error'; id: number; message: string };
