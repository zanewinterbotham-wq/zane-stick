// The real RoomDO + routeRoom + src/net/room.ts client, wired together in-process: a fake Durable Object state,
// a fake WebSocketPair and a WebSocket stub standing in for the browser's. Node has no RTCPeerConnection, so every
// peer uses the relay path (the RTC path is covered by tests/e2e/net.spec.ts in Chromium).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RoomDO, routeRoom, type CfSocket, type DONamespace, type DOState } from '../server/rooms/index';
import { createRoom, joinRoom, type NetRoom } from '../src/net/room';
import { CODE_ALPHABET, MAX_PEERS } from '../src/net/protocol';

type Data = string | ArrayBuffer;
/** One end of a fake WebSocketPair. Events wait until someone listens, like a socket handed over in a 101. */
class End {
  other!: End; readyState = 1; att: unknown;
  private onData?: (d: Data) => void; private onShut?: (code: number, reason: string) => void; private queue: (() => void)[] = [];
  listen(onData: (d: Data) => void, onShut: (code: number, reason: string) => void) {
    this.onData = onData; this.onShut = onShut;
    for (const f of this.queue.splice(0)) f();
  }
  private emit(f: () => void) { setTimeout(() => (this.onData ? f() : this.queue.push(f))); }
  accept() {}
  serializeAttachment(v: unknown) { this.att = structuredClone(v); }
  deserializeAttachment() { return structuredClone(this.att); }
  send(d: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== 1) return;
    const v = typeof d === 'string' ? d : ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer : d.slice(0);
    const o = this.other;
    o.emit(() => o.onData!(v));
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = this.other.readyState = 3;
    const o = this.other;
    o.emit(() => o.onShut!(code, reason));
    this.emit(() => this.onShut!(code, reason));
  }
}

let ns: DONamespace;
let rooms: NetRoom[] = [];
let sent = 0; // messages the server let through to a socket
function namespace(): DONamespace {
  const objects = new Map<string, RoomDO>();
  return {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (req) => {
        let o = objects.get(id as string);
        if (!o) {
          const socks: { ws: End; tags: string[] }[] = [], store = new Map<string, unknown>();
          const state: DOState = {
            acceptWebSocket(ws, tags = []) {
              const e = ws as unknown as End;
              socks.push({ ws: e, tags });
              e.listen((d) => { sent++; void o!.webSocketMessage(ws, d); }, () => { socks.splice(socks.findIndex((s) => s.ws === e), 1); void o!.webSocketClose(ws); });
            },
            getWebSockets: (tag) => socks.filter((s) => s.ws.readyState === 1 && (!tag || s.tags.includes(tag))).map((s) => s.ws as unknown as CfSocket),
            storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v), deleteAll: async () => store.clear(), setAlarm: async () => {} },
          };
          objects.set(id as string, (o = new RoomDO(state)));
        }
        return o.fetch(req);
      },
    }),
  };
}

/** Browser WebSocket stand-in: the upgrade goes through routeRoom, the 101's webSocket becomes our end. */
class FakeWebSocket {
  binaryType = 'blob'; readyState = 0; bufferedAmount = 0;
  onmessage: ((e: { data: Data }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  private end?: End;
  constructor(url: string) {
    void routeRoom(new Request(url.replace(/^ws/, 'http'), { headers: { Upgrade: 'websocket' } }), ns).then((res) => {
      const end = (res as Response & { webSocket?: End }).webSocket;
      if (!end) { this.readyState = 3; this.onclose?.({ code: 1006, reason: '' }); return; }
      this.end = end; this.readyState = 1;
      end.listen((data) => this.onmessage?.({ data }), (code, reason) => { this.readyState = 3; this.onclose?.({ code, reason }); });
    });
  }
  send(d: string | ArrayBufferView) { this.end?.send(d); }
  close(code = 1000) { this.end?.close(code); }
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeWebSocket;
  g.WebSocketPair = class { 0: End; 1: End; constructor() { this[0] = new End(); this[1] = new End(); this[0].other = this[1]; this[1].other = this[0]; } };
  // Node's Response refuses status 101; the Workers runtime returns one with the client end attached.
  const Base = Response;
  g.Response = class extends Base {
    webSocket?: unknown; private s?: number;
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      if (init?.status === 101) { this.s = 101; this.webSocket = init.webSocket; }
    }
    get status() { return this.s ?? super.status; }
  };
});

afterEach(() => { for (const r of rooms) r.close(); rooms = []; });

const SERVER = 'http://rooms.test';
const until = async (ok: () => boolean, ms = 2000) => {
  for (const t0 = Date.now(); !ok(); await new Promise((r) => setTimeout(r, 5))) if (Date.now() - t0 > ms) throw new Error('timed out');
};
async function room(p: Promise<NetRoom>) { const r = await p; rooms.push(r); return r; }
function inbox(r: NetRoom) { const got: [string, Data][] = []; r.onMessage((f, d) => got.push([f, d])); return got; }

describe('room server over the relay path', () => {
  it('a host and two guests exchange reliable text and binary through the Durable Object', async () => {
    ns = namespace();
    const host = await room(createRoom('Host', SERVER));
    expect(host.isHost).toBe(true);
    expect(host.code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{5}$`));
    const a = await room(joinRoom(host.code.toLowerCase(), 'Ann', SERVER));
    const b = await room(joinRoom(host.code, 'Bo\u0007b', SERVER));
    await until(() => host.peers().length === 2 && b.peers().length === 2 && a.peers().length === 2);
    expect(host.peers().map((p) => [p.name, p.host, p.via])).toEqual([['Ann', false, 'relay'], ['Bob', false, 'relay']]);
    expect(a.peers().find((p) => p.host)).toMatchObject({ id: host.selfId, name: 'Host' });

    const [hIn, aIn, bIn] = [inbox(host), inbox(a), inbox(b)];
    a.broadcast('ready', true);
    b.send(host.selfId, new Float32Array([1.5, -2]).buffer, false);
    host.broadcast('start', true);
    host.send(b.selfId, new Uint8Array([9, 8, 7]).buffer, false);
    a.send(b.selfId, 'guest-to-guest', true); // star: the server drops it
    await until(() => hIn.length === 2 && aIn.length === 1 && bIn.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(hIn[0]).toEqual([a.selfId, 'ready']);
    expect(hIn[1][0]).toBe(b.selfId);
    expect([...new Float32Array(hIn[1][1] as ArrayBuffer)]).toEqual([1.5, -2]);
    expect(aIn).toEqual([[host.selfId, 'start']]);
    expect(bIn[0]).toEqual([host.selfId, 'start']);
    expect([...new Uint8Array(bIn[1][1] as ArrayBuffer)]).toEqual([9, 8, 7]);
  });

  it('measures rtt, drops oversize messages and announces a guest leaving', async () => {
    ns = namespace();
    const host = await room(createRoom('H', SERVER));
    const g = await room(joinRoom(host.code, 'G', SERVER));
    const gIn = inbox(g);
    await until(() => host.peers().length === 1); // the host hears of a guest by its own peers message
    host.send(g.selfId, new ArrayBuffer(70 * 1024), true); // over the 64 KB cap
    host.send(g.selfId, 'after', true);
    await until(() => gIn.length === 1);
    expect(gIn[0][1]).toBe('after');
    await until(() => host.peers()[0]?.rtt > 0 && g.peers()[0]?.rtt > 0, 3000); // probes run once a second
    expect(host.peers()[0].rtt).toBeLessThan(0.5);
    const counts: number[] = [];
    host.onPeers((p) => counts.push(p.length));
    g.close();
    await until(() => counts.includes(0));
    expect(host.peers()).toEqual([]);
  });

  it('host leaving closes the room: guests see host-left, late joiners room-closed, unknown codes no-room', async () => {
    ns = namespace();
    const host = await room(createRoom('H', SERVER));
    const g = await room(joinRoom(host.code, 'G', SERVER));
    const why: string[] = [];
    g.onClose((r) => why.push(r));
    host.close();
    await until(() => why.length === 1);
    expect(why).toEqual(['host-left']);
    await expect(joinRoom(host.code, 'Late', SERVER)).rejects.toThrow('room-closed');
    await expect(joinRoom('ZZZZZ', 'X', SERVER)).rejects.toThrow('no-room');
    await expect(joinRoom('nope', 'X', SERVER)).rejects.toThrow('no-room');
    expect((await routeRoom(new Request(`${SERVER}/api/room/${host.code}`), ns)).status).toBe(410);
    expect((await routeRoom(new Request(`${SERVER}/api/room/ZZZZZ`), ns)).status).toBe(404);
    expect((await routeRoom(new Request(`${SERVER}/api/room/%E0%A4%A`), ns)).status).toBe(404); // a bad escape: 404, not a throw
    expect((await routeRoom(new Request(`${SERVER}/api/room`), ns)).status).toBe(200);
  });

  it(`a room takes ${MAX_PEERS} sockets: the next join is refused room-full`, async () => {
    ns = namespace();
    const host = await room(createRoom('H', SERVER));
    for (let i = 1; i < MAX_PEERS; i++) await room(joinRoom(host.code, `G${i}`, SERVER));
    await expect(joinRoom(host.code, 'One too many', SERVER)).rejects.toThrow('room-full');
    await until(() => host.peers().length === MAX_PEERS - 1);
  });

  it('the host kicks a guest through the server: his socket closes "kicked"; a guest cannot kick', async () => {
    ns = namespace();
    const host = await room(createRoom('H', SERVER));
    const a = await room(joinRoom(host.code, 'A', SERVER)), b = await room(joinRoom(host.code, 'B', SERVER));
    await until(() => host.peers().length === 2);
    const why: string[] = [];
    a.onClose((r) => why.push('a:' + r)); b.onClose((r) => why.push('b:' + r)); host.onClose((r) => why.push('h:' + r));
    (b as unknown as { ws: FakeWebSocket }).ws.send(JSON.stringify({ t: 'kick', to: host.selfId })); // a guest's kick: ignored
    host.kick(a.selfId);
    await until(() => why.length === 1 && host.peers().length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect([why, host.peers().map((p) => p.name)]).toEqual([['a:kicked'], ['B']]);
  });

  it('a code with a host in it is never handed out twice', async () => {
    ns = namespace();
    const up = () => new Request('https://room/ABCDE/create', { headers: { Upgrade: 'websocket' } });
    const stub = ns.get(ns.idFromName('ABCDE'));
    expect((await stub.fetch(up())).status).toBe(101);
    expect((await stub.fetch(up())).status).toBe(409);
  });

  it('drops junk without dropping the socket', async () => {
    ns = namespace();
    const host = await room(createRoom('H', SERVER));
    const g = await room(joinRoom(host.code, 'G', SERVER));
    const ws = (g as unknown as { ws: FakeWebSocket }).ws;
    const before = sent;
    ws.send('{not json');
    ws.send(JSON.stringify({ t: 'signal', to: 42, data: 1 }));
    ws.send(new Uint8Array([9, 9, 9]));
    await until(() => sent - before >= 3);
    const hIn = inbox(host);
    g.broadcast('still here', true);
    await until(() => hIn.length === 1);
  });
});
