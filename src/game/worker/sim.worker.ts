// The physics Worker (worker mode): runs the rep's Play off the page's thread, so physics and rendering use two cores.
// The page asks for the fixed steps each frame owes; this runs them, with what must see every step (hit sounds and
// big hits, sound cues, face moods), and posts the snapshot back. The simulation is the same code with the same
// inputs as on the page: only where it runs differs.
import { HumanBrain } from '../../sim/brains/human';
import { Play } from '../../sim/modes/play';
import { modeById } from '../../sim/modes/registry';
import { encodeSnapshot } from '../../sim/net/snapshot';
import { mujocoEngine } from '../../sim/physics/mujoco';
import { SoundCues, type Cue } from '../cues';
import { ExpressionTracker } from '../expressions';
import { hitFeel, HitMeter, type BigHit, type HitSound } from '../feel';
import type { Expression } from '../render/brows';
import type { FromSim, ToSim } from './protocol';

const human = new HumanBrain();
let play: Play | null = null, id = -1, meter = new HitMeter(), cues = new SoundCues(0), faces = new ExpressionTracker(), moods: Expression[] = [];

const post = (m: FromSim) => (self as unknown as Worker).postMessage(m, 'snap' in m ? [m.snap] : []);

self.onmessage = async (e: MessageEvent<ToSim>) => {
  const m = e.data;
  try {
    if (m.t === 'start') {
      play?.destroy(); play = null; id = m.id;
      await mujocoEngine.init();
      human.latest = null; human.steerAssist = m.steer;
      const p = await Play.create(mujocoEngine, m.cfg, modeById(m.mode), m.options, human, m.rep);
      if (id !== m.id) { p.destroy(); return; } // a newer rep was asked for while this one was built
      play = p; meter = new HitMeter(); cues = new SoundCues(p.ball); faces = new ExpressionTracker(); moods = [];
      post({ t: 'ready', id, snap: encodeSnapshot(p) });
    } else if (m.t === 'step') {
      if (!play || m.id !== id) return;
      human.latest = m.input;
      const w = play.world, sounds: HitSound[] = [], said: Cue[] = [], t0 = performance.now();
      let big: BigHit | null = null, k = 0;
      while (k < m.n) {
        play.step(); k++;
        const r = meter.step(w);
        sounds.push(...r.sounds);
        said.push(...cues.step(w));
        moods = faces.step(w);
        if (r.bigNow) { big = r.bigNow; if (m.stopOnBig && hitFeel(big.impulse, big.closing).stopMs) break; } // the page starts a hit-stop
      }
      post({ t: 'frame', id, steps: k, ms: performance.now() - t0, snap: encodeSnapshot(play), sounds, cues: said, big, best: meter.best, first: meter.big, faces: moods, contact: human.contact });
    } else { play?.destroy(); play = null; id = -1; }
  } catch (err) {
    post({ t: 'error', id: 'id' in m ? m.id : -1, message: err instanceof Error ? err.message : String(err) });
  }
};
