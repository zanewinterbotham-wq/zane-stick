// Room server: one Durable Object per room code (signaling for WebRTC + a WebSocket relay fallback).
// Deployed as Worker "zane-stick-rooms" (workers_dev = false); players reach it only through the Pages Function
// functions/api/room/[[path]].ts on the game's own address. `wrangler dev` serves the same routes for local play.
import { CLOSE, CLOSE_REASON, MAX_MESSAGE, MAX_PEERS, cleanName, frameHeader, makeCode, normCode, readdressFrame } from '../../src/net/protocol';
import type { ClientMsg, ServerMsg, WirePeer } from '../../src/net/protocol';

// The slice of the Workers runtime this file uses (no @cloudflare/workers-types dependency).
export interface CfSocket extends WebSocket { accept(): void; serializeAttachment(v: unknown): void; deserializeAttachment(): unknown }
export interface DOState {
  acceptWebSocket(ws: CfSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfSocket[];
  storage: { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void>; deleteAll(): Promise<void>; setAlarm(t: number): Promise<void> };
}
export interface DONamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }
declare const WebSocketPair: new () => { 0: CfSocket; 1: CfSocket };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const isUpgrade = (req: Request) => req.headers.get('Upgrade')?.toLowerCase() === 'websocket';
const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
const say = (ws: CfSocket, m: ServerMsg) => { try { ws.send(JSON.stringify(m)); } catch { /* closing */ } };
/** A browser can't read an HTTP status off a failed upgrade, so accept and close with a reason it can read. */
function refuse(code: number): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, CLOSE_REASON[code]);
  return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
}

/** /api/room → health, /api/room/new → create (WebSocket), /api/room/<CODE> → join (WebSocket) or status (GET). */
export async function routeRoom(req: Request, rooms: DONamespace): Promise<Response> {
  const url = new URL(req.url);
  const seg = url.pathname.replace(/^\/api\/room\/?/, '').split('/')[0];
  if (!seg) return json(200, { ok: true });
  if (seg === 'new') {
    if (!isUpgrade(req)) return json(426, { error: 'websocket required' });
    for (let i = 0; i < 8; i++) { // a DO per code: a taken code answers 409, so draw again
      const code = makeCode(rand);
      const res = await rooms.get(rooms.idFromName(code)).fetch(new Request(`https://room/${code}/create${url.search}`, req));
      if (res.status !== 409) return res;
    }
    return json(503, { error: 'no free room code' });
  }
  const code = normCode(seg); // a client sends a normCode'd code, which needs no decoding
  if (!code) return json(404, { error: 'room not found' });
  return rooms.get(rooms.idFromName(code)).fetch(new Request(`https://room/${code}/join${url.search}`, req));
}

type Peer = WirePeer;
/** Messages per second a socket may send (sustained); bursts up to twice that. A host relaying 30 Hz snapshots to
 *  dozens of guests stays well under it, a flood does not. */
const RATE = 1500;

export class RoomDO {
  private buckets = new WeakMap<CfSocket, { t: number; n: number }>(); // lost on hibernation, which only refills it
  constructor(private state: DOState, _env?: unknown) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [, code, op] = url.pathname.split('/');
    const name = cleanName(url.searchParams.get('name') ?? '');
    const open = this.state.getWebSockets('host').length > 0;
    if (op === 'create') {
      if (open) return json(409, { error: 'code in use' });
      await this.state.storage.deleteAll(); // a code freed by a closed room can be reused
      return this.admit(code, name, true);
    }
    if (!open) {
      const closed = (await this.state.storage.get('closed')) === true;
      if (!isUpgrade(req)) return json(closed ? 410 : 404, { error: closed ? 'room closed' : 'room not found' });
      return refuse(closed ? CLOSE.roomClosed : CLOSE.noRoom);
    }
    if (!isUpgrade(req)) return json(200, { code, players: this.state.getWebSockets().length });
    if (this.state.getWebSockets().length >= MAX_PEERS) return refuse(CLOSE.roomFull);
    return this.admit(code, name, false);
  }

  private admit(code: string, name: string, host: boolean): Response {
    const pair = new WebSocketPair(), ws = pair[1];
    const me: Peer = { id: crypto.randomUUID().slice(0, 8), name, host };
    this.state.acceptWebSocket(ws, host ? ['host', me.id] : [me.id]); // the id tag makes lookup by id O(1)
    ws.serializeAttachment(me);
    say(ws, { t: 'hello', code, id: me.id, host, peers: this.list() });
    this.announce(ws);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  private list(without?: CfSocket): Peer[] {
    return this.state.getWebSockets().filter((s) => s !== without).map((s) => s.deserializeAttachment() as Peer);
  }

  /** Everyone but `skip` gets the new peer list (`gone`: skip has left and is not in it). */
  private announce(skip: CfSocket, gone = false) {
    const peers = this.list(gone ? skip : undefined);
    for (const s of this.state.getWebSockets()) if (s !== skip) say(s, { t: 'peers', peers });
  }

  private allow(ws: CfSocket): boolean {
    const now = Date.now(), b = this.buckets.get(ws) ?? { t: now, n: 2 * RATE };
    b.n = Math.min(2 * RATE, b.n + ((now - b.t) / 1000) * RATE);
    b.t = now;
    this.buckets.set(ws, b);
    return b.n >= 1 ? (b.n--, true) : false;
  }

  /** The socket `to` names if `me` may talk to it: star topology, so one end must be the host. */
  private target(me: Peer, to: unknown): CfSocket | undefined {
    if (typeof to !== 'string' || !to) return;
    const s = this.state.getWebSockets(to)[0];
    return s && (me.host || (s.deserializeAttachment() as Peer).host) ? s : undefined;
  }

  async webSocketMessage(ws: CfSocket, msg: string | ArrayBuffer) {
    if ((typeof msg === 'string' ? msg.length : msg.byteLength) > MAX_MESSAGE || !this.allow(ws)) return;
    const me = ws.deserializeAttachment() as Peer;
    if (typeof msg !== 'string') { // relay frame: forward the payload verbatim, re-addressed from the sender
      const f = new Uint8Array(msg), to = this.target(me, frameHeader(f)?.id);
      if (to) try { to.send(readdressFrame(f, me.id)!); } catch { /* closing */ }
      return;
    }
    let m: ClientMsg;
    try { m = JSON.parse(msg); } catch { return; }
    if (m?.t === 'ping') say(ws, { t: 'pong', ts: Number(m.ts) || 0 });
    else if (m?.t === 'signal') { const to = this.target(me, m.to); if (to) say(to, { t: 'signal', from: me.id, data: m.data }); }
    else if (m?.t === 'kick' && me.host) {
      const to = this.target(me, m.to);
      if (!to || to === ws) return;
      try { to.close(CLOSE.kicked, CLOSE_REASON[CLOSE.kicked]); } catch { /* gone */ }
      this.announce(to, true); // now: his close event may never come (the close handshake can stall)
    }
  }

  async webSocketClose(ws: CfSocket) {
    try { ws.close(); } catch { /* already closed */ }
    const me = ws.deserializeAttachment() as Peer;
    if (!me.host) return this.announce(ws, true);
    await this.state.storage.put('closed', true); // joiners now get "room closed" instead of "not found"
    await this.state.storage.setAlarm(Date.now() + 10 * 60_000);
    // the message first: a guest's close event may never come (the close handshake can stall), the message does
    for (const s of this.state.getWebSockets()) if (s !== ws) { say(s, { t: 'bye', reason: 'host-left' }); try { s.close(CLOSE.hostLeft, CLOSE_REASON[CLOSE.hostLeft]); } catch { /* gone */ } }
  }

  async webSocketError(ws: CfSocket) { return this.webSocketClose(ws); }

  async alarm() { if (!this.state.getWebSockets('host').length) await this.state.storage.deleteAll(); }
}

export default { fetch: (req: Request, env: { ROOMS: DONamespace }) => routeRoom(req, env.ROOMS) };
