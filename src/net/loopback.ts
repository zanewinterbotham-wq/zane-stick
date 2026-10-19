// In-memory NetRoom for tests and offline integration: a host and guests in one process, star topology like the
// real room. Messages arrive asynchronously (microtask), in order, never lost; ArrayBuffers are copied on send.
import type { NetRoom, PeerInfo } from './room';

export interface LoopbackRoom { host: NetRoom; guests: NetRoom[]; join(name: string): NetRoom }

export function createLoopbackRoom(guestNames: string[] = ['Guest'], hostName = 'Host', code = 'TEST2'): LoopbackRoom {
  const members: Member[] = [];
  let next = 0;
  const others = (m: Member) => members.filter((o) => o !== m && (m.isHost || o.isHost));
  const announce = () => { for (const m of members) { const p = m.peers(); for (const cb of m.peerCbs) cb(p); } };
  const leave = (m: Member, reason: string) => {
    const i = members.indexOf(m);
    if (i < 0) return;
    members.splice(i, 1);
    for (const cb of m.closeCbs) cb(reason);
    if (m.isHost) for (const g of [...members]) leave(g, 'host-left');
    else announce();
  };

  class Member implements NetRoom {
    readonly code = code; readonly selfId = `p${next++}`;
    msgCbs: ((from: string, data: ArrayBuffer | string) => void)[] = [];
    peerCbs: ((peers: PeerInfo[]) => void)[] = [];
    closeCbs: ((reason: string) => void)[] = [];
    constructor(readonly name: string, readonly isHost: boolean) {}
    peers(): PeerInfo[] {
      return members.filter((o) => o !== this).map((o) => ({ id: o.selfId, name: o.name, host: o.isHost, via: 'rtc', rtt: 0 }));
    }
    send(to: string, data: ArrayBuffer | string) {
      const o = others(this).find((x) => x.selfId === to);
      if (!o) return;
      const copy = typeof data === 'string' ? data : data.slice(0);
      queueMicrotask(() => { if (members.includes(o)) for (const cb of o.msgCbs) cb(this.selfId, copy); });
    }
    broadcast(data: ArrayBuffer | string) { for (const o of others(this)) this.send(o.selfId, data); }
    onMessage(cb: (from: string, data: ArrayBuffer | string) => void) { this.msgCbs.push(cb); }
    onPeers(cb: (peers: PeerInfo[]) => void) { this.peerCbs.push(cb); }
    onClose(cb: (reason: string) => void) { this.closeCbs.push(cb); }
    close() { leave(this, 'closed'); }
  }

  const join = (name: string, isHost = false) => { const m = new Member(name, isHost); members.push(m); announce(); return m; };
  const host = join(hostName, true);
  return { host, guests: guestNames.map((n) => join(n)), join: (name) => join(name) };
}
