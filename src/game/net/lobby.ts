// The multiplayer lobby (docs/multiplayer.md 'lobby' / 'want'): the room's shared state, kept by the host and sent
// whole to every guest on each change, and the game messages on the reliable channel. Plain data and pure rules
// (no DOM), so the host's decisions are unit-tested in Node.
import type { PeerInfo } from '../../net/room';
import { listSlots, modeById, resolveOptions, type SlotInfo } from '../../sim/modes/registry';
import type { ModeDef, ModeOptions, OptionDesc, PlayConfig } from '../../sim/modes/types';

/** The two teams' names (render/athleteMesh.ts TEAMS: team 0 navy, team 1 orange). */
export const TEAM_NAMES = ['Harbor Gulls', 'Ridge Foxes'] as const;

/** via 'self': the host's own row. rtt: the round trip between that player and the host (s). */
export interface LobbyPlayer { id: string; name: string; host: boolean; ready: boolean; via: PeerInfo['via'] | 'self'; rtt: number }
export interface Lobby {
  mode: string; options: ModeOptions;
  /** Per slot (athlete index): the player id on it, or null for a bot. */
  assign: (string | null)[];
  /** In join order, the host first. */
  players: LobbyPlayer[];
  phase: 'lobby' | 'game';
  /** Points per team this session (reset when the mode or its options change). */
  score: [number, number];
  /** Players who asked for the next rep during this one: it starts once every player on a position has. */
  votes: string[];
  /** The host's build (version.ts): a guest on another one cannot play in this room. */
  build: string;
}

/** A rep starting (host → all): everything a guest needs to build the same Play the host steps. */
export interface StartMsg { mode: string; options: ModeOptions; seed: number; rep: number; assign: (string | null)[]; cfg: PlayConfig; countdown: number }
/** Presentation events the host knows best (feel.ts big hits; a player leaving). */
export type NetEvent = { k: 'hit'; closing: number; impulse: number; a: number; b: number } | { k: 'left'; name: string; athlete: number } | { k: 'old'; name: string };
export type ToHost = { t: 'hi'; steer: number; v?: string } | { t: 'want'; slot: number | null } | { t: 'ready'; on: boolean } | { t: 'restart'; on: boolean };
export type ToGuest = { t: 'lobby'; lobby: Lobby } | { t: 'start'; start: StartMsg } | { t: 'ev'; ev: NetEvent } | { t: 'kick'; why?: 'version' };

/** A guest's message as the host may trust it, or null. */
export function parseToHost(data: string): ToHost | null {
  let m: unknown;
  try { m = JSON.parse(data); } catch { return null; }
  const o = m as Record<string, unknown>;
  if (o?.t === 'hi' && typeof o.steer === 'number' && Number.isFinite(o.steer)) return { t: 'hi', steer: Math.min(1, Math.max(0, o.steer)), ...(typeof o.v === 'string' && { v: o.v.slice(0, 40) }) };
  if (o?.t === 'want' && (o.slot === null || Number.isInteger(o.slot))) return { t: 'want', slot: o.slot as number | null };
  if (o?.t === 'ready' && typeof o.on === 'boolean') return { t: 'ready', on: o.on };
  if (o?.t === 'restart' && typeof o.on === 'boolean') return { t: 'restart', on: o.on };
  return null;
}

export const slotsOf = (l: Lobby): SlotInfo[] => listSlots(modeById(l.mode), l.options);

export function newLobby(host: { id: string; name: string }, mode: string, options: ModeOptions, build = 'dev'): Lobby {
  const def = modeById(mode), o = resolveOptions(def, options);
  const l: Lobby = { mode: def.id, options: o, assign: listSlots(def, o).map(() => null), players: [], phase: 'lobby', score: [0, 0], votes: [], build };
  join(l, host.id, host.name, true);
  return l;
}

/** A player arrives; in the lobby he is put on a free slot at once (the emptier team), during a game he watches. */
export function join(l: Lobby, id: string, name: string, host = false) {
  if (l.players.some((p) => p.id === id)) return;
  l.players.push({ id, name, host, ready: host, via: host ? 'self' : 'connecting', rtt: 0 });
  if (l.phase === 'lobby') autoAssign(l, [id]);
}

export function leave(l: Lobby, id: string) {
  l.players = l.players.filter((p) => p.id !== id);
  l.votes = l.votes.filter((v) => v !== id);
  l.assign = l.assign.map((x) => (x === id ? null : x));
}

/** A player's own request: an open (bot) slot moves him there; his own slot, or null, frees him (a bot plays it);
 *  another player's slot is the host's to give. */
export function want(l: Lobby, id: string, slot: number | null) {
  if (!l.players.some((p) => p.id === id)) return;
  const cur = l.assign.indexOf(id);
  if (slot === null || slot === cur) { if (cur >= 0) l.assign[cur] = null; return; }
  if (!(slot >= 0 && slot < l.assign.length) || l.assign[slot] !== null) return;
  if (cur >= 0) l.assign[cur] = null;
  l.assign[slot] = id;
}

/** The host puts a player (or a bot: null) on a slot. A player already on another slot swaps with whoever is there. */
export function place(l: Lobby, slot: number, id: string | null) {
  if (!(slot >= 0 && slot < l.assign.length)) return;
  if (id === null) { l.assign[slot] = null; return; }
  if (!l.players.some((p) => p.id === id)) return;
  const from = l.assign.indexOf(id);
  if (from === slot) return;
  if (from >= 0) l.assign[from] = l.assign[slot];
  l.assign[slot] = id;
}

/** Spread the players on no slot (or just `only`) over the open slots, each to the team with fewer players so far. */
export function autoAssign(l: Lobby, only?: string[]) {
  const slots = slotsOf(l), count = [0, 0];
  l.assign.forEach((id, i) => { if (id) count[slots[i].team]++; });
  const free = (t: number) => slots.findIndex((s, i) => s.team === t && l.assign[i] === null);
  for (const p of l.players) {
    if (l.assign.includes(p.id) || (only && !only.includes(p.id))) continue;
    const t = count[0] <= count[1] ? 0 : 1, k = free(t) >= 0 ? free(t) : free(1 - t);
    if (k < 0) return;
    l.assign[k] = p.id; count[slots[k].team]++;
  }
}

export function allBots(l: Lobby) { l.assign = l.assign.map(() => null); }

export function setReady(l: Lobby, id: string, on: boolean) { const p = l.players.find((x) => x.id === id); if (p && !p.host) p.ready = on; }

/** A player asks for the next rep (on) or takes it back. */
export function vote(l: Lobby, id: string, on: boolean) {
  if (!l.players.some((p) => p.id === id)) return;
  l.votes = l.votes.filter((v) => v !== id);
  if (on) l.votes.push(id);
}

/** Restart votes for this rep's players (`assign`, the start's): who has asked of those who must (everyone on a
 *  position; a watcher may ask but is not waited for), and whether the next rep is due (all asked, or with nobody on
 *  a position, anyone). */
export function restartTally(l: Lobby, assign: readonly (string | null)[]) {
  const need = [...new Set(assign.filter((id): id is string => !!id && l.players.some((p) => p.id === id)))];
  const have = need.filter((id) => l.votes.includes(id)).length;
  return { have, need: need.length, due: need.length ? have === need.length : l.votes.length > 0 };
}

/** A position's name without its number or side ('Blocker 2' → 'Blocker', 'Gunner L' → 'Gunner', 'Cover R1' → 'Cover'). */
export const baseLabel = (label: string) => label.replace(/\s+(?:[LR]?\d+|[LR])$/, '');

/** Change the mode or its options. Players keep their team and position where the new setup has it: the same
 *  label, else the same position name ('Blocker' ↔ 'Blocker 1'), else any open slot of the same team; else they watch. */
export function setup(l: Lobby, mode: string, options: ModeOptions) {
  const def = modeById(mode), o = resolveOptions(def, options);
  if (def.id === l.mode && JSON.stringify(o) === JSON.stringify(l.options)) return;
  const old = slotsOf(l), next = listSlots(def, o), assign: (string | null)[] = next.map(() => null);
  const placed = l.assign.flatMap((id, i) => (id ? [{ id, s: old[i] }] : []));
  const passes: ((a: SlotInfo, b: SlotInfo) => boolean)[] = [(a, b) => a.label === b.label, (a, b) => baseLabel(a.label) === baseLabel(b.label), () => true];
  for (const match of passes) for (const p of placed) {
    if (assign.includes(p.id)) continue;
    const k = next.findIndex((s, i) => assign[i] === null && s.team === p.s.team && match(s, p.s));
    if (k >= 0) assign[k] = p.id;
  }
  Object.assign(l, { mode: def.id, options: o, assign, score: [0, 0] });
}

/** The options that are head counts (ranges without a unit, as the slot tests treat them). */
export const countOptions = (def: ModeDef) => def.options.filter((d): d is Extract<OptionDesc, { kind: 'range' }> => d.kind === 'range' && d.unit === undefined);

/** Which team(s) a head count adds positions to, and the name of the position it adds ('blocker'). */
export function countInfo(def: ModeDef, o: ModeOptions, d: Extract<OptionDesc, { kind: 'range' }>): { teams: (0 | 1)[]; noun: string } {
  const v = +o[d.id], lo = v < d.max ? v : v - d.step, a = listSlots(def, { ...o, [d.id]: lo }), b = listSlots(def, { ...o, [d.id]: lo + d.step });
  const has = (list: SlotInfo[], s: SlotInfo) => list.some((x) => x.team === s.team && x.label === s.label);
  const added = b.filter((s) => !has(a, s)), teams = ([0, 1] as const).filter((t) => b.filter((s) => s.team === t).length > a.filter((s) => s.team === t).length);
  return { teams, noun: baseLabel(added[added.length - 1]?.label ?? d.label).toLowerCase() };
}

export function count(l: Lobby, id: string, delta: number) {
  const def = modeById(l.mode), d = countOptions(def).find((x) => x.id === id);
  if (d) setup(l, l.mode, { ...l.options, [id]: Math.min(d.max, Math.max(d.min, +l.options[id] + delta * d.step)) });
}

/** Assigned players who are not ready yet (the host is always ready: he presses Start). */
export const notReady = (l: Lobby) => l.players.filter((p) => !p.ready && l.assign.includes(p.id));

/** Keep the transport's view of each guest (name, path, ping) in the lobby: true if anything but the ping changed. */
export function syncPeers(l: Lobby, peers: PeerInfo[]): { joined: string[]; left: string[]; changed: boolean } {
  const ids = new Set(peers.map((p) => p.id)), before = JSON.stringify(l.players.map((p) => [p.id, p.via]));
  const left = l.players.filter((p) => !p.host && !ids.has(p.id)).map((p) => p.id), joined: string[] = [];
  for (const id of left) leave(l, id);
  for (const p of peers) {
    if (!l.players.some((x) => x.id === p.id)) { join(l, p.id, p.name); joined.push(p.id); }
    const x = l.players.find((y) => y.id === p.id)!;
    x.via = p.via; x.rtt = p.rtt;
  }
  return { joined, left, changed: before !== JSON.stringify(l.players.map((p) => [p.id, p.via])) };
}
