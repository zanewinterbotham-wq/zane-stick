# Multiplayer (Phase 1 work, owner request 2026-10-18)

The host makes a room and gets a short code; friends type the code to join. Any number of players. Empty positions
are bots. A lobby lets everyone see the room, pick the mode and its options (host), and choose who plays which
position (host decides, players can ask for a slot by clicking it).

## Architecture: host-authoritative star

- **The host's browser runs the only simulation** (Play/World/MuJoCo, exactly as single player). Determinism across
  browsers is not required.
- **Guests send input, not Commands**: their latest `HumanInput` (src/sim/brains/human.ts), about 60 times a second,
  unreliable. The host runs a `HumanBrain` per remote player fed from that input, so steer assist, catching aims and
  contact mode work the same for everyone. Bots are the usual role brains.
- **The host sends snapshots**: every athlete's and prop's generalised positions (MuJoCo qpos) plus a small world
  meta block, ~30 times a second, unreliable. Guests build the same World from the same setup (mode, options, seed,
  rep, assignments) but never step its physics: they write interpolated snapshots into the scene and run
  `mj_forward`, so the renderer, camera, HUD and faces work unchanged on a replica.
- **Reliable messages** (lobby state, rep start, rep end/score, injuries and other events) go on a reliable channel.
- Topology is a star: guests talk only to the host. The host relays anything another guest needs.

## Transport (src/net/, browser only; src/sim never imports it)

- Signaling and fallback relay: a Cloudflare Durable Object (`RoomDO`, one per room) behind Pages Functions on the
  game's own address (`/api/room/...`), so no `*.workers.dev` URL appears anywhere. The DO Worker has
  `workers_dev = false`.
- Each guest opens a WebRTC peer connection to the host with two data channels: `r` (reliable, ordered) and `u`
  (unordered, `maxRetransmits: 0`). STUN: `stun:stun.cloudflare.com:3478`. If the peer connection is not open within
  ~6 s (school networks often block it), traffic for that guest falls back to the room WebSocket relay (binary
  frames forwarded by the DO). Both paths look the same to the game.
- Room codes: 5 characters from an unambiguous alphabet (no 0/O/1/I/L). The room ends when the host leaves; guests
  see "Host left".

```ts
// src/net/room.ts — the only API the game uses
export interface PeerInfo { id: string; name: string; host: boolean; via: 'rtc' | 'relay' | 'connecting'; rtt: number }
export interface NetRoom {
  readonly code: string; readonly selfId: string; readonly isHost: boolean;
  peers(): PeerInfo[];                                   // everyone else in the room
  send(to: string, data: ArrayBuffer | string, reliable: boolean): void;
  broadcast(data: ArrayBuffer | string, reliable: boolean): void;   // host: to every guest; guest: to the host
  onMessage(cb: (from: string, data: ArrayBuffer | string) => void): void;
  onPeers(cb: (peers: PeerInfo[]) => void): void;        // join, leave, path or rtt change
  onClose(cb: (reason: string) => void): void;
  close(): void;
}
export function createRoom(name: string, server?: string): Promise<NetRoom>;
export function joinRoom(code: string, name: string, server?: string): Promise<NetRoom>;
```

## Game protocol (src/game/net/ or src/sim/net/ for the pure encode/decode)

- `lobby` (host → all, reliable, JSON): players [{id, name}], mode id, mode options, assignment slot → player id or
  null (bot), each player's ready flag. `want` (guest → host): request a slot / leave it / ready.
- `start` (host → all, reliable, JSON): {mode, options, seed, rep, assign: (playerId | null)[] per athlete, cfg: the
  host's physics + gameplay settings that change the World (hit power, toughness, bone strength, support...)}.
  Guests rebuild their replica from it.
- `input` (guest → host, unreliable, binary): seq, HumanInput (move x/y, torso, sprint, armL, armR, cameraYaw,
  aimPitch, shiftLock, the held action names as a bitmask in a fixed action order).
- `snap` (host → all, unreliable, binary): rep, tick, sim time, qpos as float32 for the whole scene, then meta per
  athlete (downBy, injury bits, knock, grip flags), ball carrier, play status (ended, repTime, score).
- `event` (host → all, reliable, JSON): injuries (World.injuries entries), big hits, whistles, rep result.

## Smoothness

- Guests render ~100 ms behind the newest snapshot (adaptive to jitter), interpolating qpos (positions lerped,
  quaternions nlerped) between the two snapshots around the render time; extrapolate at most 100 ms if packets stop.
- Inputs are sent every render frame and the host always uses the newest one (sequence numbers drop stale ones).
- Slow motion and hit-stop are off in multiplayer (they would stop time for everyone).
- The host keeps simulating when its tab is hidden (a Worker timer, or at least a warning in the lobby).
