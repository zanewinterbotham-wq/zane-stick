// Human brain: turns the latest input snapshot into Commands. Lives in the sim so humans and bots share
// one interface; the browser shell writes `latest` once per render frame (no DOM access here).
import { neutralCommands, type Commands } from '../control/types';
import type { Brain, Perception } from './types';

/** Device-independent input snapshot (what the shell's InputFrame boils down to). */
export interface HumanInput {
  move: { x: number; y: number };   // x right, y forward, relative to the camera's heading
  lean: { x: number; y: number };
  sprint: number; sink: number; armL: number; armR: number;
  contactMode: boolean;
  held: ReadonlySet<string>;
  cameraYaw: number;                // heading the camera looks along (rad, 0 = +Z)
}

export class HumanBrain implements Brain {
  latest: HumanInput | null = null;
  think(_p: Perception): Commands {
    const c = neutralCommands();
    const i = this.latest;
    if (!i) return c;
    const h = i.held;
    // camera-relative movement: stick up = the direction the camera looks
    const fwd = [Math.sin(i.cameraYaw), Math.cos(i.cameraYaw)], right = [-Math.cos(i.cameraYaw), Math.sin(i.cameraYaw)];
    let mx = fwd[0] * i.move.y + right[0] * i.move.x, mz = fwd[1] * i.move.y + right[1] * i.move.x;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    c.move = { x: mx, z: mz };
    c.contactMode = i.contactMode;
    c.gait = i.sprint > 0.5 ? 'sprint' : m > 0.6 ? 'jog' : 'walk';
    if (c.gait === 'walk' && m > 0) c.move = { x: mx / (m || 1), z: mz / (m || 1) }; // walk at walking speed
    c.sink = i.sink;
    c.lean = { fwd: i.lean.y, side: -i.lean.x }; // side + = left
    c.headTuck = h.has('headTuck');
    c.dive = h.has('dive');
    if (i.contactMode) {
      c.armL = i.armL; c.armR = i.armR;
      c.gripL = h.has('gripL'); c.gripR = h.has('gripR');
      c.wrap = h.has('wrap'); c.shoot = h.has('shoot');
      c.thrustHips = h.has('thrustHips');
      c.driveLegs = i.sprint;
      c.chopFeet = h.has('chopFeet');
      c.plantCut = h.has('cutLeft') ? 1 : h.has('cutRight') ? -1 : 0;
      if (c.driveLegs > 0.5) c.gait = 'sprint';
    } else {
      c.plantCut = h.has('cutLeft') ? 1 : h.has('cutRight') ? -1 : 0;
    }
    return c;
  }
}
