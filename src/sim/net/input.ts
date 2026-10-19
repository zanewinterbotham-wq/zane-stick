// A guest's input on the wire (docs/multiplayer.md 'input', guest → host, unreliable): a sequence number and the
// HumanInput the host's HumanBrain for him reads. Held actions travel as a bitmask over ACTIONS.
import type { HumanInput } from '../brains/human';
import { clamp } from '../math';
import { MSG } from './snapshot';

/** Every digital action of src/game/input/bindings.json, in a fixed order (append new ones at the end: the order is
 *  the wire format). The sim does not import game data, so the names are copied; a test checks the list is complete.
 *  'jump' is the owner's requested Space action (2026-10-18). */
export const ACTIONS = ['moveUp', 'moveDown', 'moveLeft', 'moveRight', 'sprint', 'thrust', 'dive', 'armL', 'armR', 'torsoUp', 'torsoDown',
  'shiftLock', 'reset', 'pause', 'overlay', 'tuning', 'jump'] as const;
const SIZE = 43;

export function encodeInput(i: HumanInput, seq: number): ArrayBuffer {
  const buf = new ArrayBuffer(SIZE), v = new DataView(buf);
  let o = 0, held = 0;
  v.setUint8(o++, MSG.input); v.setUint8(o++, 1); v.setUint32(o, seq >>> 0, true); o += 4;
  for (const x of [i.move.x, i.move.y, i.torso, i.sprint, i.armL, i.armR, i.cameraYaw, i.aimPitch]) { v.setFloat32(o, x, true); o += 4; }
  v.setUint8(o++, i.shiftLock ? 1 : 0);
  ACTIONS.forEach((a, k) => { if (i.held.has(a)) held |= 1 << k; });
  v.setUint32(o, held >>> 0, true);
  return buf;
}

/** A guest's input as the host may trust it: null unless it is one, every number finite and in its range. */
export function decodeInput(buf: ArrayBuffer): { seq: number; input: HumanInput } | null {
  if (buf.byteLength !== SIZE) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG.input || v.getUint8(1) !== 1) return null;
  const f = (k: number, lo: number, hi: number) => { const x = v.getFloat32(6 + 4 * k, true); return Number.isFinite(x) ? clamp(x, lo, hi) : 0; };
  const mask = v.getUint32(39, true);
  return {
    seq: v.getUint32(2, true),
    input: { move: { x: f(0, -1, 1), y: f(1, -1, 1) }, torso: f(2, -1, 1), sprint: f(3, 0, 1), armL: f(4, 0, 1), armR: f(5, 0, 1),
      cameraYaw: f(6, -1e3, 1e3), aimPitch: f(7, -Math.PI / 2, Math.PI / 2), shiftLock: v.getUint8(38) === 1,
      held: new Set(ACTIONS.filter((_, k) => mask & (1 << k))) },
  };
}
