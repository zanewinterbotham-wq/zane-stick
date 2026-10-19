import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, CODE_LENGTH, cleanName, decodeFrame, encodeFrame, frameHeader, makeCode, normCode, readdressFrame } from '../src/net/protocol';
import { createLoopbackRoom } from '../src/net/loopback';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('room codes', () => {
  it('are 5 characters from an alphabet without 0/O/1/I/L', () => {
    for (const c of '0O1IL') expect(CODE_ALPHABET).not.toContain(c);
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const codes = new Set(Array.from({ length: 500 }, () => makeCode(rand)));
    for (const c of codes) expect(c).toMatch(new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`));
    expect(codes.size).toBeGreaterThan(490);
    expect(makeCode(() => 0.999999)).toBe('ZZZZZ');
  });
  it('normalise what a player types', () => {
    expect(normCode(' ab-c d9 ')).toBe('ABCD9');
    expect(normCode('ABCD')).toBeNull();
    expect(normCode('ABCDO')).toBeNull(); // O is never in a code
    expect(normCode('ABCDEF')).toBeNull();
  });
  it('clean names', () => {
    expect(cleanName('  Zed\u0000\n ')).toBe('Zed');
    expect(cleanName('')).toBe('Player');
    expect(cleanName('x'.repeat(40))).toHaveLength(24);
  });
});

describe('relay frames', () => {
  it('round-trip binary and text payloads and re-address without touching them', () => {
    const bin = new Uint8Array([0, 1, 2, 250, 255]).buffer;
    const f = encodeFrame('host1234', bin);
    expect(frameHeader(f)).toEqual({ kind: 0, id: 'host1234', at: 10 });
    const g = readdressFrame(f, 'g7')!;
    const d = decodeFrame(g)!;
    expect(d.id).toBe('g7');
    expect([...new Uint8Array(d.data as ArrayBuffer)]).toEqual([0, 1, 2, 250, 255]);
    expect(decodeFrame(encodeFrame('a', 'héllo ⚑'))).toEqual({ id: 'a', data: 'héllo ⚑' });
    expect(decodeFrame(encodeFrame('a', ''))).toEqual({ id: 'a', data: '' });
  });
  it('reject junk', () => {
    expect(frameHeader(new Uint8Array([]))).toBeNull();
    expect(frameHeader(new Uint8Array([7, 0]))).toBeNull(); // unknown kind
    expect(frameHeader(new Uint8Array([0, 9, 65]))).toBeNull(); // id longer than the frame
    expect(readdressFrame(new Uint8Array([1]), 'x')).toBeNull();
  });
});

describe('loopback room', () => {
  it('is a star: host reaches every guest, guests reach only the host', async () => {
    const { host, guests: [a, b] } = createLoopbackRoom(['A', 'B']);
    const got: string[] = [];
    host.onMessage((from, d) => got.push(`host<${from}:${d}`));
    a.onMessage((from, d) => got.push(`A<${from}:${typeof d === 'string' ? d : new Uint8Array(d)[0]}`));
    b.onMessage((from, d) => got.push(`B<${from}:${d}`));
    expect(host.isHost && !a.isHost).toBe(true);
    expect(host.peers().map((p) => p.name)).toEqual(['A', 'B']);
    expect(a.peers().find((p) => p.host)?.id).toBe(host.selfId);
    a.broadcast('hi', true);
    a.send(b.selfId, 'sneak', true); // guest to guest: dropped
    const buf = new Uint8Array([42]).buffer;
    host.send(a.selfId, buf, false);
    new Uint8Array(buf)[0] = 0; // the copy on send protects the receiver
    host.broadcast('all', true);
    expect(got).toEqual([]); // asynchronous, like a network
    await tick();
    expect(got).toEqual([`host<${a.selfId}:hi`, `A<${host.selfId}:42`, `A<${host.selfId}:all`, `B<${host.selfId}:all`]);
  });
  it('announces joins and leaves, and closes everyone when the host leaves', () => {
    const room = createLoopbackRoom([]);
    const seen: number[] = [];
    room.host.onPeers((p) => seen.push(p.length));
    const c = room.join('C'), d = room.join('D');
    c.close();
    expect(seen).toEqual([1, 2, 1]);
    const reasons: string[] = [];
    d.onClose((r) => reasons.push(r));
    room.host.onClose((r) => reasons.push('host:' + r));
    room.host.close();
    expect(reasons).toEqual(['host:closed', 'host-left']);
  });
});
