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
  kick(id: string): void;                                // host: the server closes that guest's socket
  close(): void;
}
export function createRoom(name: string, server?: string): Promise<NetRoom>;
export function joinRoom(code: string, name: string, server?: string): Promise<NetRoom>;
```

Implementation notes (src/net/, server/rooms/):
- `rtt` is in seconds (SI), smoothed, 0 until the first probe returns (probes run once a second).
- `onClose` reasons: `'host-left'`, `'kicked'`, `'disconnected'` (socket lost), `'closed'` (own `close()`).
  `createRoom`/`joinRoom` reject with `Error('no-room' | 'room-closed' | 'room-full' | 'unreachable')`. One table,
  `CLOSE_REASON` in src/net/protocol.ts, spells every close code. A room takes `MAX_PEERS` (32) sockets.
- A guest knows the host when `joinRoom` resolves; the host learns of a guest from `onPeers`. A send to an id not in
  `peers()` (or guest to guest) is dropped. Relay messages over 64 KB are dropped by the server. Strings starting
  with `\u0001` are reserved for the transport.
- `defaultServer()` = `?server=` or the page's origin. `src/net/loopback.ts` `createLoopbackRoom(guestNames)` gives an
  in-memory host + guests for tests (async delivery, star topology, `join(name)` for late joiners).
- Routes: `/api/room/new` (WebSocket, create), `/api/room/<CODE>` (WebSocket join; plain GET answers 200/404/410).

## Game protocol (src/game/net/lobby.ts for the JSON messages, src/sim/net/ for the binary ones)

- `lobby` (host → all, reliable, JSON `{t:'lobby', lobby}`): players [{id, name, host, ready, via, rtt}], mode id,
  mode options, `assign` (per slot: player id or null for a bot), phase ('lobby' | 'game'), score per team. Sent
  whole on every change (pings at most once a second).
- `hi` / `want` / `ready` (guest → host, reliable, JSON): his steer assist; take a slot (an open one), free his own
  (`slot: null` or his own slot); ready flag. The host validates every field (`parseToHost`).
- `start` (host → all, reliable, JSON): {mode, options, seed, rep, assign: (playerId | null)[] per athlete, cfg: the
  host's whole PlayConfig (his preset's physics, hit power, toughness, bone strength, support, body strength...),
  countdown}. Guests build the same Play from it: the same slots are players' (a stand-in brain the guest never
  runs), so bodies and toughness match. A guest who joins mid-game gets the current one and watches.
- `input` (guest → host, unreliable, binary): seq, HumanInput (move x/y, torso, sprint, armL, armR, cameraYaw,
  aimPitch, shiftLock, the held action names as a bitmask in a fixed action order, and a throw: its point and loft,
  repeated in the next few inputs so a lost packet does not lose it).
- `snap` (host → all, unreliable, binary): rep, tick, sim time, qpos as float32 for the whole scene, then meta per
  athlete (downBy, injury bits, knock, grip flags), ball carrier, play state (ended, verdict, `Play.note` such as
  'BLOCKED', the pass state and the last throw), every injury so far.
- `ev` (host → all, reliable, JSON): big hits (feel.ts: impulse and closing speed, so guests get the banner, shake
  and rumble from the host's numbers, not from replica contact forces) and a player leaving mid-rep.
- `kick` (host → one guest): he is removed (the host ignores him from then on), and the host has the room server
  close his socket (`NetRoom.kick`, a `{t:'kick', to}` to the server). He can rejoin under a new id.

## What is built (game side, src/game/net/)

- **Title → Multiplayer**: name (saved), Host a game, or Join with the 5-character code (forgiving case, spaces,
  dashes, a pasted invite link; Enter joins). Errors in words: no such room, closed, host left, connection failed,
  removed. An invite link `?join=CODE` opens the join screen filled in, and joins at once when a name is saved.
- **Lobby** (`lobby-ui.ts`): the room code big with Copy code / Copy link; players with the host's crown, position,
  path (direct / relay) and ping, ready state, and the host's remove button; the mode (the Play menu's cards and
  options; guests see them read-only, live). **Position menu**: the two teams side by side (headers from the slots'
  groups, e.g. Kicking team / Return team, and the team names), a card per position with its player's chip or BOT.
  Click an open position to take it, your own to give it to a bot; the host drags chips between positions (swaps),
  onto Watching, or picks from each card's dropdown; Auto-assign spreads the unplaced players over open positions
  alternating teams; Everyone to bots; head-count steppers (+ Add blocker) in each team's column. Newcomers land on
  an open position of the emptier team. Changing mode or counts keeps players on their team and position (same
  label, else the same position name, else the same team). Start needs every placed player ready (or Start anyway)
  and counts down 3-2-1 on every screen while the guests build.
- **Playing**: the host steps the play at the fixed rate for everyone (no slow motion, no hit-stop) and sends
  snapshots 30 times a second of play time; the next rep starts only when every player on a position has asked for it (Enter / Start or the menu's Vote to
  restart; again takes it back; a watcher may ask but is not waited for; owner decision 2026-10-19). The HUD corner shows
  the count (restart 1/2); the votes reset each rep.
  Guests send their input every frame and render `Replica.render(now)`; the camera, HUD, faces, sounds and gore
  read the replica world. The HUD shows your position and team, the score per team, and the room / path / ping
  corner; Tab shows everyone. Spectators follow any athlete (Space / arm buttons cycle). The pause menu keeps the
  game running: Positions (the lobby over the play, for the next rep), Vote to restart, Back to lobby (host), Leave
  room. A guest leaving mid-rep: his athlete is a bot at once (`Play.toBot`). The host leaving ends the room.
- **Host tab hidden**: browsers stop animation frames and throttle timers in background tabs, so a Worker's timer
  keeps the host's play stepping while hidden; the lobby and the HUD still ask the host to keep the tab in front.
- **Room server address**: the page's own origin on the Cloudflare Pages site and on local dev servers; anywhere
  else (the GitHub Pages copy, which has no /api) `https://zane-stick.pages.dev`; `?server=` overrides.

### Try it locally

1. `npm run dev:rooms` (the room server on 127.0.0.1:8787) and `npm run dev` (Vite proxies /api to it).
2. Open http://localhost:5173 in two windows (or a normal and a private one, so their settings differ), Multiplayer
   → Host a game in one, type the code (or open Copy link's address) in the other.
3. Tests: `tests/net-lobby.test.ts` (lobby rules; a host and two guests over a loopback room play a rep) and
   `tests/e2e/multiplayer.spec.ts` (three browsers against dev:rooms and Vite on 5181, started by
   playwright.config.ts).

### Not done yet

- **Client prediction**: a guest sees his own athlete with the same ~100 ms delay (plus the trip to the host) as
  everyone else. Predicting it would mean stepping a local copy of his own body (and the ball when he holds it)
  from his input ahead of the snapshots and blending back to the host's pose on each snapshot; contacts with other
  athletes cannot be predicted, so it pays off only in open field. Not needed for now.
- Mode status lines are worded for team 0 (the single player's side), so team 1 players see only their position
  line; the 1-v-1 big-hit sound and grunt use athletes 0 and 1 as in single player.

## Smoothness

- Guests render ~100 ms behind the newest snapshot (adaptive to jitter), interpolating qpos (positions lerped,
  quaternions nlerped) between the two snapshots around the render time; extrapolate at most 100 ms if packets stop.
- Inputs are sent every render frame and the host always uses the newest one (sequence numbers drop stale ones).
- Slow motion and hit-stop are off in multiplayer (they would stop time for everyone).
- The host keeps simulating when its tab is hidden (a Worker timer, or at least a warning in the lobby).
