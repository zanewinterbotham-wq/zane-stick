// Wire format shared by the browser transport (src/net/room.ts) and the room server (server/rooms/).
// No DOM, no Workers APIs: both sides and Node tests import it.

/** Room code alphabet: no 0/O/1/I/L so a code read aloud or off a screen can't be mistyped. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;
/** The server drops any message bigger than this (bytes; a string counts its UTF-16 length). */
export const MAX_MESSAGE = 64 * 1024;
/** WebSocket close codes the server uses; the client turns them into onClose reasons. */
export const CLOSE = { hostLeft: 4000, noRoom: 4004, roomClosed: 4010 } as const;

/** A fresh code from `rand` (uniform in [0, 1)); server side uses crypto, tests can pass a stub. */
export function makeCode(rand: () => number): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

/** What a player typed → the canonical code, or null when it can't be one. Forgives case, spaces and dashes. */
export function normCode(typed: string): string | null {
  const s = typed.toUpperCase().replace(/[\s-]/g, '');
  return s.length === CODE_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c)) ? s : null;
}

/** Display names: printable, trimmed, at most 24 characters. */
export function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || 'Player';
}

// Control messages (JSON text frames on the room WebSocket).
export interface WirePeer { id: string; name: string; host: boolean }
export type ServerMsg =
  | { t: 'hello'; code: string; id: string; host: boolean; peers: WirePeer[] }
  | { t: 'peers'; peers: WirePeer[] }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'pong'; ts: number };
export type ClientMsg = { t: 'signal'; to: string; data: unknown } | { t: 'ping'; ts: number };

// Relay frames (binary WebSocket frames): [kind u8][id length u8][id utf-8][payload]. The sender puts the target id
// in the header, the server swaps in the sender's id and forwards the payload untouched.
const enc = new TextEncoder();
const dec = new TextDecoder();
export const FRAME_BINARY = 0, FRAME_TEXT = 1;

function pack(kind: number, id: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const idb = enc.encode(id);
  const out = new Uint8Array(2 + idb.length + body.length);
  out[0] = kind;
  out[1] = idb.length;
  out.set(idb, 2);
  out.set(body, 2 + idb.length);
  return out;
}

export function encodeFrame(id: string, data: ArrayBuffer | string): Uint8Array<ArrayBuffer> {
  return typeof data === 'string' ? pack(FRAME_TEXT, id, enc.encode(data)) : pack(FRAME_BINARY, id, new Uint8Array(data));
}

/** Header only (the server needs no more): null for junk. */
export function frameHeader(f: Uint8Array): { kind: number; id: string; at: number } | null {
  if (f.length < 2 || f[0] > FRAME_TEXT || f.length < 2 + f[1]) return null;
  return { kind: f[0], id: dec.decode(f.subarray(2, 2 + f[1])), at: 2 + f[1] };
}

/** The same frame addressed to `id` instead (server: target id → sender id). */
export function readdressFrame(f: Uint8Array, id: string): Uint8Array<ArrayBuffer> | null {
  const h = frameHeader(f);
  return h ? pack(h.kind, id, f.subarray(h.at)) : null;
}

export function decodeFrame(f: Uint8Array): { id: string; data: ArrayBuffer | string } | null {
  const h = frameHeader(f);
  if (!h) return null;
  return { id: h.id, data: h.kind === FRAME_TEXT ? dec.decode(f.subarray(h.at)) : f.slice(h.at).buffer };
}
