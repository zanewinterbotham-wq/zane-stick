// Browser transport for multiplayer (docs/multiplayer.md): the room WebSocket carries signaling and the relay
// fallback; each guest gets a WebRTC peer connection to the host with data channels 'r' (reliable, ordered) and 'u'
// (unordered, no retransmits). Both paths look the same to the game. Only the game shell imports this, never src/sim.
import { CLOSE, decodeFrame, encodeFrame, normCode } from './protocol';
import type { ClientMsg, ServerMsg, WirePeer } from './protocol';

/** rtt: round trip to that peer over its current path, in seconds (smoothed; 0 until measured). */
export interface PeerInfo { id: string; name: string; host: boolean; via: 'rtc' | 'relay' | 'connecting'; rtt: number }
export interface NetRoom {
  readonly code: string; readonly selfId: string; readonly isHost: boolean;
  peers(): PeerInfo[];                                   // everyone else in the room
  send(to: string, data: ArrayBuffer | string, reliable: boolean): void;
  broadcast(data: ArrayBuffer | string, reliable: boolean): void;   // host: to every guest; guest: to the host
  onMessage(cb: (from: string, data: ArrayBuffer | string) => void): void;
  onPeers(cb: (peers: PeerInfo[]) => void): void;        // join, leave, path or rtt change
  onClose(cb: (reason: string) => void): void;           // 'host-left' | 'disconnected' | 'closed' (own close())
  close(): void;
}

const ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
const RTC_WAIT = 6000; // ms a peer connection may take to open before that guest's traffic goes over the relay
const PROBE = 1000; // ms between rtt probes to each peer
const KEEPALIVE = 25; // probes between server pings, so proxies never see a silent socket
const CTRL = '\u0001'; // strings starting with this are transport-internal (rtt probes); the game never sees them
const MAX_QUEUE = 256 * 1024; // bytes: unreliable sends are dropped while this much is already queued

/** Room server origin: ?server=<url> on the page, else the page's own origin. */
export function defaultServer(): string {
  return new URLSearchParams(location.search).get('server') ?? location.origin;
}

function roomUrl(server: string, path: string, name: string): string {
  const u = new URL(`/api/room/${path}`, server);
  u.protocol = u.protocol.replace(/^http/, 'ws');
  u.searchParams.set('name', name);
  return u.href;
}

export function createRoom(name: string, server = defaultServer()): Promise<NetRoom> {
  return open(roomUrl(server, 'new', name));
}

export function joinRoom(code: string, name: string, server = defaultServer()): Promise<NetRoom> {
  const c = normCode(code);
  return c ? open(roomUrl(server, c, name)) : Promise.reject(new Error('Room not found'));
}

function open(url: string): Promise<NetRoom> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      const m = typeof e.data === 'string' ? (JSON.parse(e.data) as ServerMsg) : null;
      if (m?.t === 'hello') resolve(new Room(ws, m));
    };
    ws.onclose = (e) => reject(new Error(e.code === CLOSE.noRoom ? 'Room not found' : e.code === CLOSE.roomClosed ? 'Room closed' : 'Could not reach the room server'));
  });
}

interface Link { info: PeerInfo; pc?: RTCPeerConnection; r?: RTCDataChannel; u?: RTCDataChannel; sig: Promise<void>; timer?: ReturnType<typeof setTimeout> }

class Room implements NetRoom {
  readonly code: string; readonly selfId: string; readonly isHost: boolean;
  private links = new Map<string, Link>();
  private msgCbs: ((from: string, data: ArrayBuffer | string) => void)[] = [];
  private peerCbs: ((peers: PeerInfo[]) => void)[] = [];
  private closeCbs: ((reason: string) => void)[] = [];
  private closed = false;
  private ticker: ReturnType<typeof setInterval>;

  constructor(private ws: WebSocket, hello: Extract<ServerMsg, { t: 'hello' }>) {
    this.code = hello.code; this.selfId = hello.id; this.isHost = hello.host;
    ws.onmessage = (e) => this.onServer(e.data);
    ws.onclose = (e) => this.end(e.code === CLOSE.hostLeft ? 'host-left' : 'disconnected');
    let n = 0;
    this.ticker = setInterval(() => {
      for (const l of this.links.values()) this.send(l.info.id, CTRL + 'p' + performance.now(), false);
      if (++n % KEEPALIVE === 0) this.toServer({ t: 'ping', ts: Date.now() });
    }, PROBE);
    this.setPeers(hello.peers);
  }

  peers(): PeerInfo[] { return [...this.links.values()].map((l) => ({ ...l.info })); }
  onMessage(cb: (from: string, data: ArrayBuffer | string) => void) { this.msgCbs.push(cb); }
  onPeers(cb: (peers: PeerInfo[]) => void) { this.peerCbs.push(cb); }
  onClose(cb: (reason: string) => void) { this.closeCbs.push(cb); }
  close() { this.end('closed'); }

  send(to: string, data: ArrayBuffer | string, reliable: boolean) {
    const l = this.links.get(to);
    if (!l || this.closed || !this.talks(l)) return;
    const c = l.info.via === 'rtc' ? (reliable ? l.r : l.u) : undefined;
    if (c?.readyState === 'open') {
      if (reliable || c.bufferedAmount < MAX_QUEUE) typeof data === 'string' ? c.send(data) : c.send(data);
    } else if (this.ws.readyState === 1 && (reliable || this.ws.bufferedAmount < MAX_QUEUE)) this.ws.send(encodeFrame(to, data));
  }

  broadcast(data: ArrayBuffer | string, reliable: boolean) {
    for (const l of this.links.values()) this.send(l.info.id, data, reliable);
  }

  /** Star topology: a guest only ever talks to the host (the server drops guest-to-guest traffic too). */
  private talks(l: Link) { return this.isHost || l.info.host; }

  private toServer(m: ClientMsg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  private onServer(data: string | ArrayBuffer) {
    if (typeof data !== 'string') {
      const f = decodeFrame(new Uint8Array(data));
      if (f && this.links.has(f.id)) this.deliver(f.id, f.data);
      return;
    }
    let m: ServerMsg;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'peers') this.setPeers(m.peers);
    else if (m.t === 'signal') this.onSignal(m.from, m.data as RtcSignal);
  }

  private deliver(from: string, data: ArrayBuffer | string) {
    if (typeof data !== 'string' || data[0] !== CTRL) { for (const cb of this.msgCbs) cb(from, data); return; }
    if (data[1] === 'p') return this.send(from, CTRL + 'q' + data.slice(2), false);
    const l = this.links.get(from), rtt = (performance.now() - Number(data.slice(2))) / 1000;
    if (!l || !(rtt >= 0)) return;
    l.info.rtt = l.info.rtt ? 0.7 * l.info.rtt + 0.3 * rtt : rtt;
    this.emitPeers();
  }

  private setPeers(list: WirePeer[]) {
    const ids = new Set(list.map((p) => p.id));
    for (const [id, l] of this.links) if (!ids.has(id)) { this.drop(l); this.links.delete(id); }
    for (const p of list) if (p.id !== this.selfId && !this.links.has(p.id)) this.links.set(p.id, this.link(p));
    this.emitPeers();
  }

  private link(p: WirePeer): Link {
    const l: Link = { info: { ...p, via: 'connecting', rtt: 0 }, sig: Promise.resolve() };
    if (!this.talks(l) || typeof RTCPeerConnection === 'undefined') { l.info.via = 'relay'; return l; }
    l.timer = setTimeout(() => { if (l.info.via === 'connecting') this.via(l, 'relay'); }, RTC_WAIT);
    if (!this.isHost) { // the guest calls, the host answers
      const pc = this.rtc(l);
      this.negotiate(l, async () => { await pc.setLocalDescription(); this.signal(l, { sdp: pc.localDescription!.toJSON() }); });
    }
    return l;
  }

  private rtc(l: Link): RTCPeerConnection {
    const pc = new RTCPeerConnection(ICE);
    // Negotiated channels: both ends create them with fixed ids, so nobody waits on ondatachannel.
    const r = pc.createDataChannel('r', { negotiated: true, id: 0 });
    const u = pc.createDataChannel('u', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    for (const c of [r, u]) {
      c.binaryType = 'arraybuffer';
      c.onopen = () => { if (r.readyState === 'open' && u.readyState === 'open') this.via(l, 'rtc'); };
      c.onclose = () => { if (l.pc === pc) this.via(l, 'relay'); };
      c.onmessage = (e) => this.deliver(l.info.id, e.data);
    }
    pc.onicecandidate = (e) => { if (e.candidate) this.signal(l, { ice: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && l.pc === pc) this.via(l, 'relay'); };
    Object.assign(l, { pc, r, u });
    return pc;
  }

  private signal(l: Link, data: RtcSignal) { this.toServer({ t: 'signal', to: l.info.id, data }); }

  /** Signaling steps for one peer run strictly in order (an ICE candidate never races its description). */
  private negotiate(l: Link, step: () => Promise<void>) {
    l.sig = l.sig.then(step).catch(() => { /* a failed negotiation leaves this peer on the relay */ });
  }

  private onSignal(from: string, s: RtcSignal) {
    const l = this.links.get(from);
    if (!l || !this.talks(l) || typeof RTCPeerConnection === 'undefined') return;
    this.negotiate(l, async () => {
      if (s?.sdp) {
        const pc = l.pc ?? this.rtc(l);
        await pc.setRemoteDescription(s.sdp);
        if (s.sdp.type === 'offer') { await pc.setLocalDescription(); this.signal(l, { sdp: pc.localDescription!.toJSON() }); }
      } else if (s?.ice && l.pc) await l.pc.addIceCandidate(s.ice);
    });
  }

  private via(l: Link, via: PeerInfo['via']) {
    if (l.info.via === via || this.closed) return;
    l.info.via = via;
    clearTimeout(l.timer);
    this.emitPeers();
  }

  private drop(l: Link) {
    clearTimeout(l.timer);
    const pc = l.pc;
    l.pc = undefined; // before close(), so the closing channels don't report a path change
    pc?.close();
  }

  private emitPeers() { const p = this.peers(); for (const cb of this.peerCbs) cb(p); }

  private end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    for (const l of this.links.values()) this.drop(l);
    this.ws.onclose = null;
    try { this.ws.close(1000); } catch { /* already closed */ }
    for (const cb of this.closeCbs) cb(reason);
  }
}

type RtcSignal = { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };
