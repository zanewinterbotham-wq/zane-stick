// A guest's input on the wire (docs/multiplayer.md 'input', guest → host, unreliable): a sequence number and the
// HumanInput the host's HumanBrain for him reads. Held actions travel as a bitmask over ACTIONS, a throw (PassCmd) as
// its point and loft.
import type { HumanInput } from '../brains/human';
import type { PassCmd } from '../control/types';
import { clamp } from '../math';
import { MSG } from './snapshot';

/** Every digital action of src/game/input/bindings.json, in a fixed order (append new ones at the end: the order is
 *  the wire format). The sim does not import game data, so the names are copied; a test checks the list is complete.
 *  'jump' is the owner's requested Space action (2026-10-18). */
export const ACTIONS = ['moveUp', 'moveDown', 'moveLeft', 'moveRight', 'sprint', 'thrust', 'dive', 'armL', 'armR', 'torsoUp', 'torsoDown',
  'shiftLock', 'reset', 'pause', 'overlay', 'tuning', 'jump', 'throw', 'lob', 'target', 'scheme', 'replay', 'photo'] as const;
const SIZE = 57, VERSION = 2;
/** A pass rides along in this many inputs after its own (the channel is unreliable: one lost packet must not lose the
 *  throw; the copies reach the host while the throw already runs, and the world ignores them). */
export const PASS_REPEAT = 6;
/** The sender's memory of its last pass, for encodeInput to repeat it. */
export interface PassHold { pass: PassCmd | null; until: number }
/** A pass point must lie within this box (m: the field and its surrounds, a ball's reach above it). */
const PASS_BOX = { x: 40, y: 30, z: 80 };

/** `hold` (the sender's, kept between calls): repeat a pass in the next PASS_REPEAT inputs. */
export function encodeInput(i: HumanInput, seq: number, hold?: PassHold): ArrayBuffer {
  const buf = new ArrayBuffer(SIZE), v = new DataView(buf);
  let o = 0, held = 0, pass = i.pass ?? null;
  if (hold) { if (pass) { hold.pass = pass; hold.until = seq + PASS_REPEAT; } else if (seq <= hold.until) pass = hold.pass; }
  v.setUint8(o++, MSG.input); v.setUint8(o++, VERSION); v.setUint32(o, seq >>> 0, true); o += 4;
  for (const x of [i.move.x, i.move.y, i.torso, i.sprint, i.armL, i.armR, i.cameraYaw, i.aimPitch]) { v.setFloat32(o, x, true); o += 4; }
  v.setUint8(o++, i.shiftLock ? 1 : 0);
  ACTIONS.forEach((a, k) => { if (i.held.has(a)) held |= 1 << k; });
  v.setUint32(o, held >>> 0, true); o += 4;
  v.setUint8(o++, pass ? (pass.follow ? 3 : 1) : 0); // bit 0: a pass; bit 1: its point follows the passer
  for (const x of pass?.at ?? [0, 0, 0]) { v.setFloat32(o, x, true); o += 4; }
  v.setUint8(o, Math.round(clamp(pass?.loft ?? 0, 0, 1) * 255));
  return buf;
}

/** A guest's input as the host may trust it: null unless it is one, every number finite and in its range. */
export function decodeInput(buf: ArrayBuffer): { seq: number; input: HumanInput } | null {
  if (buf.byteLength !== SIZE) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG.input || v.getUint8(1) !== VERSION) return null;
  const f = (k: number, lo: number, hi: number) => { const x = v.getFloat32(6 + 4 * k, true); return Number.isFinite(x) ? clamp(x, lo, hi) : 0; };
  const mask = v.getUint32(39, true), at = [44, 48, 52].map((k) => v.getFloat32(k, true)), B = PASS_BOX;
  // a pass anywhere a ball can go, or none
  const flag = v.getUint8(43);
  const pass = (flag & 1) === 1 && at.every(Number.isFinite) && Math.abs(at[0]) <= B.x && at[1] >= 0 && at[1] <= B.y && Math.abs(at[2]) <= B.z
    ? { at: at as [number, number, number], loft: v.getUint8(56) / 255, ...(flag & 2 && { follow: true }) } : null;
  return {
    seq: v.getUint32(2, true),
    input: { move: { x: f(0, -1, 1), y: f(1, -1, 1) }, torso: f(2, -1, 1), sprint: f(3, 0, 1), armL: f(4, 0, 1), armR: f(5, 0, 1),
      cameraYaw: f(6, -1e3, 1e3), aimPitch: f(7, -Math.PI / 2, Math.PI / 2), shiftLock: v.getUint8(38) === 1,
      held: new Set(ACTIONS.filter((_, k) => mask & (1 << k))), pass },
  };
}
