// Browser entry: title menu, open-field drill, HUD, pause menu, panels. The simulation runs on a fixed
// timestep; slow motion only changes how fast real time feeds the fixed steps.
import './testLock'; // first: tests must not capture the owner's real cursor
import { HumanBrain } from '../sim/brains/human';
import { carrierSkill } from '../sim/brains/carrier';
import { tacklerSkill } from '../sim/brains/tackler';
import { DEFAULT_OPEN_FIELD } from '../sim/drills/openField';
import { Play } from '../sim/modes/play';
import { modeById } from '../sim/modes/registry';
import type { ModeDef, ModeOptions } from '../sim/modes/types';
import { headingOf, qrot } from '../sim/math';
import { mujocoEngine } from '../sim/physics/mujoco';
import { carrierVsTacklerScenario, pushScenario, runScenario, standScenario, thrustHitScenario, type Scenario } from '../sim/scenarios';
import { World, type PhysicsSettings } from '../sim/world';
import { Audio } from './audio';
import { chooseBest, reportText, runBenchmark } from './benchmark';
import { ChaseCamera } from './camera';
import { SoundCues } from './cues';
import { HitMeter, hitFeel, MPH } from './feel';
import { InputManager, keyName, keysText, type InputFrame } from './input/input';
import { PRESETS, type PresetName } from './presets';
import { GameRenderer, RENDER_PRESETS } from './render/renderer';
import { DEFAULT_SETTINGS, GAME_SUPPORT, PLAYER_BASE, loadSettings, saveSettings, type Settings } from './settings';
import { CATEGORIES, equipItem } from './inventory';
import { modeMenu, savedOptions } from './modes';
import { openSettings } from './settings-menu';
import { el, Hud, inventoryPanel, Layer, menu, moveFocus } from './ui';
import { createRoom, joinRoom, type NetRoom } from '../net/room';
import type { HumanInput } from '../sim/brains/human';
import type { PlayConfig } from '../sim/modes/types';
import { TEAM_NAMES, type NetEvent, type StartMsg } from './net/lobby';
import { lobbyPanel, mpScreen, netMessage, pingText, rosterRows, type LobbyView } from './net/lobby-ui';
import { COUNTDOWN, Session } from './net/session';

const params = new URLSearchParams(location.search);
/** A multiplayer guest's input while his menu is open: stand still (the shared play goes on). */
const IDLE: HumanInput = { move: { x: 0, y: 0 }, torso: 0, sprint: 0, armL: 0, armR: 0, held: new Set(), cameraYaw: 0, aimPitch: 0 };
/** Multiplayer: the host starts the next rep by itself this long after a play ends (s of play time). */
const AUTO_NEXT = 5;
const canvas = document.getElementById('view') as HTMLCanvasElement;

// ------------------------------------------------------------------ dev scenarios (?scenario=…)
async function devScenario(name: string) {
  const physics: PhysicsSettings = { hz: +(params.get('hz') ?? 240), iterations: 30, detail: (params.get('detail') as PhysicsSettings['detail']) ?? 'standard' };
  const assist = +(params.get('assist') ?? 0);
  const sc: Scenario = name === 'push' ? pushScenario(physics, +(params.get('dir') ?? 0), +(params.get('imp') ?? 60), assist)
    : name === 'walk' || name === 'jog' || name === 'sprint' ? runScenario(physics, name, { assist })
    : name === 'cut' ? runScenario(physics, 'jog', { assist, cutAt: 3 })
    : name === 'hit' ? carrierVsTacklerScenario(physics, { hitPower: +(params.get('hp') ?? 1) })
    : name === 'thrust' ? thrustHitScenario(physics, +(params.get('torso') ?? 1)) : standScenario(physics, assist);
  const world = await World.create(mujocoEngine, sc.setup);
  const r = new GameRenderer(canvas, RENDER_PRESETS[(params.get('gfx') as 'minimum' | 'high') ?? 'high']);
  await r.setSkin(params.get('skin') ?? DEFAULT_SETTINGS.skin);
  await r.setStadium(params.get('stadium') ?? 'field'); // the dev scenarios have no barrier in their physics
  r.setWorld(world);
  r.setXray(params.get('xray') === '1');
  const cam = new ChaseCamera();
  cam.mode = (params.get('cam') as ChaseCamera['mode']) ?? 'chase';
  r.hideHeadOf = cam.mode === 'helmet' ? 0 : -1;
  const heading = () => { const q = world.scene.athletes[0].state.segQuat; return headingOf(qrot([q[0], q[1], q[2], q[3]], [0, 0, 1])); };
  cam.snap(r.camera, world, heading());
  document.getElementById('loading')?.remove();
  const stepOnce = () => { sc.onStep?.(world); world.step(); };
  (window as unknown as { __zs: unknown }).__zs = {
    world, renderer: r,
    advance(seconds: number) {
      for (let i = 0, n = Math.round(seconds / world.dt); i < n; i++) stepOnce();
      cam.update(r.camera, world, seconds, heading());
      r.render(world);
      return world.time;
    },
  };
  r.render(world);
}

// ------------------------------------------------------------------ the game
class App {
  settings: Settings = loadSettings();
  input = new InputManager();
  audio = new Audio();
  hud = new Hud();
  layer = new Layer();
  renderer: GameRenderer | null = null;
  rendererPreset: PresetName | null = null;
  drill: Play | null = null;
  human = new HumanBrain();
  cam = new ChaseCamera();
  paused = true;
  timeScale = 1;
  slowUntil = 0;
  freezeUntil = 0;   // hit-stop: wall-clock ms until which no sim steps run
  nextStop = 0;      // one hit-stop per hit, not one per contact step
  meter = new HitMeter();
  meterWorld: World | null = null;
  cues = new SoundCues(0);
  speed = 0;         // smoothed human ground speed for the speedometer and FOV kick, m/s
  acc = 0;
  last = performance.now();
  fps = 0; physMs = 0;
  rep = 0;
  peakShown = false;
  endWhistled = false;
  /** The game mode being played and its options; the session score (your team, the bots') and whether this rep's
   *  points are counted yet. */
  mode: ModeDef = modeById('tackle');
  modeOpts: ModeOptions = {};
  score: [number, number] = [0, 0];
  scored = false;
  startHeld = 0;
  pausedAt = 0;
  private padPrev: boolean[] = [];
  /** Multiplayer (docs/multiplayer.md): the room's session, the lobby on screen, when the shared play starts moving
   *  (performance.now ms, after the 3-2-1), the athlete a spectator watches, the Tab roster, the big hits the host
   *  reported this rep, the host's queued next rep, and when the host's tab was hidden. */
  net: Session | null = null;
  lobbyView: LobbyView | null = null;
  countdownUntil = 0;
  spectate = 0;
  rosterOn = false;
  netBig: { closing: number; impulse: number } | null = null;
  netBest: { closing: number; impulse: number } | null = null;
  nextQueued = false;
  hiddenAt = 0;
  private ticker: Worker | null = null;

  async boot() {
    this.input.capture = false;
    this.cam.mode = this.settings.camera;
    this.cam.follow = this.input.autoCamera = this.settings.autoCamera;
    this.input.sprintToggle = this.settings.sprintToggle;
    this.input.setKeyboard(this.settings.bindings);
    this.audio.muted = this.settings.mute;
    this.audio.onVoice = (v) => this.renderer?.voice(v);
    // Alt+Tab (or any switch away): pause, which frees the mouse; Resume or a click on the field captures it again
    window.addEventListener('blur', () => this.lostFocus());
    canvas.addEventListener('click', () => { if (!this.paused) this.lockPointer(); });
    document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) this.lostFocus(); });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) this.lostFocus(); });
    window.addEventListener('resize', () => this.renderer?.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => { if (e.code === 'Tab') this.rosterOn = false; });
    // a host's hidden tab is throttled: say so when he comes back
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (this.net?.isHost) this.hiddenAt = performance.now(); }
      else if (this.hiddenAt) { this.hiddenAt = 0; this.hud.flash('Keep this tab in front while you host'); }
    });
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: false });
    // menu sounds: hover/focus moves, activation (buttons may name their own: back, confirm), slider drags
    let hover: Element | null = null;
    const ui = this.layer.root, btn = (e: Event) => (e.target as Element).closest?.('button') ?? null;
    ui.addEventListener('mouseover', (e) => { const b = btn(e); if (b && b !== hover) this.audio.play('ui_move', 1); hover = b; });
    ui.addEventListener('click', (e) => { const b = btn(e); if (b) this.audio.play(b.dataset.sfx ?? 'ui_select', 1); });
    ui.addEventListener('input', (e) => { if ((e.target as HTMLInputElement).type === 'range') this.audio.play('ui_slider_tick', 1); });
    document.getElementById('loading')!.textContent = 'Loading physics…';
    await mujocoEngine.init();
    if (!this.settings.preset) await this.autoPreset();
    document.getElementById('loading')?.remove();
    this.title();
    const join = params.get('join');
    if (join) this.multiplayer('', join, !!this.settings.netName); // an invite link: joins at once if he has a name already
    requestAnimationFrame((t) => this.frame(t));
  }

  /** First launch: a short benchmark picks the highest preset that holds its target frame rate. */
  async autoPreset() {
    const el0 = document.getElementById('loading')!;
    el0.textContent = 'Measuring your device (5 s)…';
    try {
      const rs = await runBenchmark(canvas);
      this.settings.preset = chooseBest(rs);
    } catch (e) {
      console.warn('benchmark failed, using Minimum', e);
      this.settings.preset = 'minimum';
    }
    saveSettings(this.settings);
  }

  get preset() { return PRESETS[this.settings.preset ?? 'minimum']; }

  // ---------------------------------------------------------------- screens
  /** Off the field: no play running for this screen, the cursor free. */
  menus() {
    this.paused = true;
    this.audio.loop(null);
    this.hud.setVisible(false);
    this.hud.showResult(null);
    this.hud.setNet(null); this.hud.setRoster(null); this.hud.setCountdown(null);
    this.input.capture = false;
    document.exitPointerLock?.();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }

  title() {
    this.menus();
    const last = modeById(this.settings.mode ?? 'tackle');
    this.layer.show(menu('ZANE STICK', [
      { label: `Quick play: ${last.title}`, hint: 'Enter / A', action: () => void this.startDrill(last, savedOptions(this.settings, last)) },
      { label: 'Play', hint: 'choose a game mode', action: () => this.modes() },
      { label: 'Multiplayer', hint: 'host, or join with a code', action: () => this.multiplayer() },
      { label: 'Settings', action: () => this.settingsMenu(() => this.title()) },
      { label: 'Inventory', hint: 'skins, stadiums', action: () => this.inventory() },
      { label: 'Benchmark', action: () => this.benchmark() },
    ], 'Physics football. Every movement is muscles on a simulated body.'));
  }

  /** The Play screen: game modes, each with its setup. */
  modes() {
    const hooks = { show: (e: HTMLElement) => this.layer.show(e), start: (m: ModeDef, o: ModeOptions) => void this.startDrill(m, o), back: () => this.title(), save: () => this.save() };
    this.layer.show(modeMenu(this.settings, hooks));
  }

  // ---------------------------------------------------------------- multiplayer (docs/multiplayer.md)
  /** Host or join: name and room code. `msg`: why he is back here (an error, the host left); `code` and `autoJoin`
   *  from an invite link. */
  multiplayer(msg = '', code = '', autoJoin = false) {
    this.leaveNet(false);
    this.menus();
    const rename = (n: string) => { this.settings.netName = n; this.save(); };
    this.layer.show(mpScreen({ name: this.settings.netName ?? 'Player', code, msg, autoJoin, rename,
      host: async (name) => { rename(name); this.openNet(await createRoom(name), name); },
      join: async (c, name) => { rename(name); this.openNet(await joinRoom(c, name), name); },
      back: () => this.title() }));
  }

  openNet(room: NetRoom, name: string) {
    const mode = modeById(this.settings.mode ?? 'tackle');
    const net = this.net = new Session(room, mujocoEngine, name, { mode: mode.id, options: savedOptions(this.settings, mode), steer: this.settings.steerAssist });
    net.onLobby = (l) => {
      this.lobbyView?.update();
      if (l.phase === 'lobby' && this.drill && !net.isHost) { this.drill = null; this.lobby(); } // the host went back to the lobby
    };
    net.onStart = (s, play) => void this.netStart(s, play);
    net.onEvent = (e) => this.netEvent(e);
    net.onClose = (r) => { if (this.net === net) { this.net = null; this.drill = null; this.multiplayer(netMessage(r)); } };
    if (net.isHost) this.startTicker();
    this.lobby();
  }

  /** The lobby; `inGame`: the pause menu's Positions, over the running play (changes count from the next rep). */
  lobby(inGame = false) {
    const net = this.net!;
    if (!inGame) this.menus();
    this.lobbyView = lobbyPanel(net, this.settings, {
      start: () => void this.netBegin(true), leave: () => this.leaveNet(), save: () => this.save(),
      ...(inGame && { back: () => this.resume(), nextRep: () => { this.resume(); void this.newRep(); } }),
    });
    this.layer.show(this.lobbyView.root);
  }

  /** Host: the next rep for everyone (a new game counts down 3-2-1 while the guests build it). */
  async netBegin(countdown: boolean) {
    const net = this.net;
    if (!net?.isHost) return;
    this.freshRep();
    await net.begin(this.playConfig(), this.human, countdown ? COUNTDOWN : 0);
  }

  /** A rep's play is ready (the host's own, or a guest's replica): onto the field with it. */
  async netStart(s: StartMsg, play: Play) {
    const fresh = !this.drill;
    if (!this.net?.isHost) this.freshRep(); // the host's was before he built it
    this.drill = play; this.mode = modeById(s.mode); this.modeOpts = s.options;
    this.netBig = this.netBest = null; this.nextQueued = false;
    this.countdownUntil = s.countdown ? performance.now() + s.countdown * 1000 : 0;
    if (fresh) {
      this.lobbyView = null;
      this.layer.hide();
      this.hud.setVisible(true);
      this.input.capture = true;
      this.audio.unlock();
      this.audio.loop('crowd_ambience_loop');
      this.paused = false;
      this.enterPlay();
      if (!this.settings.autoCamera && !document.pointerLockElement) this.hud.flash('Click the field to look with the mouse');
    }
    await this.attach(play);
  }

  netEvent(e: NetEvent) {
    if (e.k === 'left') { this.hud.flash(`${e.name} left: a bot plays on`); return; }
    const d = this.drill;
    if (!d || this.net?.isHost) return;
    this.netBig ??= e;
    if (!this.netBest || e.impulse > this.netBest.impulse) this.netBest = e;
    this.bigHit(d, e);
  }

  /** Leave the room (to the multiplayer screen, or nowhere when another screen follows). */
  leaveNet(show = true) {
    const net = this.net;
    this.net = null; this.lobbyView = null; this.rosterOn = false;
    if (net) { this.drill = null; net.close(); }
    this.ticker?.terminate(); this.ticker = null;
    this.hud.setNet(null); this.hud.setRoster(null); this.hud.setCountdown(null);
    if (show) this.multiplayer();
  }

  /** The HUD line about the local player's place in a multiplayer play. */
  netLine(): string {
    const d = this.drill!, slots = d.mode.players;
    if (d.human >= 0) { const p = slots[d.human]; return `You: ${p.label}${p.group ? ` (${p.group})` : ''}  ·  ${TEAM_NAMES[p.team]}`; }
    const t = this.cam.target, id = this.net!.start?.assign[t] ?? null;
    return `Watching ${slots[t]?.label ?? ''} (${id ? this.net!.name(id) : 'bot'})  ·  Space: next player`;
  }

  /** Multiplayer HUD: the room and ping corner, the Tab roster, the 3-2-1. */
  netHud() {
    const net = this.net, d = this.drill;
    if (!net || !d) return;
    const host = net.room.peers().find((p) => p.host);
    this.hud.setNet(net.isHost ? `Room ${net.room.code}  ·  hosting ${net.lobby.players.length}` : `Room ${net.room.code}  ·  ${host ? pingText(host) : '…'}`);
    this.hud.setRoster(this.rosterOn ? rosterRows(net.lobby, net.start?.assign ?? net.lobby.assign, d.mode.players.map((p) => p.label)) : null);
    const left = this.countdownUntil - performance.now();
    this.hud.setCountdown(left > 0 ? String(Math.ceil(left / 1000)) : left > -700 ? 'GO!' : null);
  }

  /** A host's hidden tab gets no animation frames and throttled timers; a Worker's timer keeps his play stepping. */
  startTicker() {
    if (this.ticker || typeof Worker === 'undefined') return;
    try {
      this.ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 16);'], { type: 'text/javascript' })));
      let last = performance.now();
      this.ticker.onmessage = () => {
        const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        if (!document.hidden || !this.net?.isHost || !this.drill) return;
        this.human.latest = null;
        this.simulate(now, dt);
      };
    } catch { /* no workers: the lobby's warning has to do */ }
  }

  async startDrill(mode: ModeDef, options: ModeOptions) {
    if (mode !== this.mode || JSON.stringify(options) !== JSON.stringify(this.modeOpts)) this.score = [0, 0];
    this.mode = mode; this.modeOpts = options;
    this.settings.mode = mode.id; this.save();
    this.layer.hide();
    this.enterPlay();
    this.audio.unlock();
    this.audio.loop('crowd_ambience_loop');
    this.hud.setVisible(true);
    this.input.capture = true;
    await this.newRep();
    this.paused = false;
  }

  async newRep() {
    if (this.net) { // multiplayer: the host starts every rep, for everyone
      if (this.net.isHost) await this.netBegin(false); else this.hud.flash('The host starts the next rep');
      return;
    }
    this.drill?.destroy();
    this.freshRep();
    this.drill = await Play.create(mujocoEngine, this.playConfig(), this.mode, this.modeOpts, this.human, this.rep++);
    await this.attach(this.drill);
  }

  /** Per-rep HUD and input state back to the start. The rep's pre-roll steps the human brain with the last input: a
   *  camera still turned from the previous rep (e.g. running back after a fumble) and a held key would turn the
   *  athlete around before the rep starts. Start from the spawn heading (+Z) with no movement. */
  freshRep() {
    this.hud.showResult(null);
    this.peakShown = false;
    this.endWhistled = false;
    this.scored = false;
    this.input.resetToggles();
    this.cam.yaw = 0;
    this.human.latest = null;
    this.human.steerAssist = this.settings.steerAssist;
  }

  /** The World and bodies from this player's settings and preset (a multiplayer host's go to every guest). */
  playConfig(): PlayConfig {
    const p = this.preset, s = this.settings;
    return {
      physics: p.physics, assist: s.assist, seed: 1, difficulty: carrierSkill(s.juking), defense: tacklerSkill(s.tackling), toughness: s.toughness, hitPower: s.hitPower, boneStrength: s.boneStrength, aiBoneStrength: s.aiBoneStrength, carrierGait: DEFAULT_OPEN_FIELD.carrierGait, activeBots: p.activeBots,
      human: { ...DEFAULT_OPEN_FIELD.human, strength: PLAYER_BASE.strength * s.strength, speed: PLAYER_BASE.speed * s.speed }, bot: DEFAULT_OPEN_FIELD.carrier, traction: s.traction, gains: s.gains,
      support: { ...GAME_SUPPORT, ...s.support },
    };
  }

  /** Show a rep's play: renderer (rebuilt when the preset changed), skin, stadium, camera on the player's athlete. */
  async attach(play: Play) {
    const p = this.preset, s = this.settings;
    // the player's own athlete (multiplayer: any slot; a spectator: the one he watches)
    this.cam.target = play.human >= 0 ? play.human : Math.min(this.spectate, play.world.athletes.length - 1);
    if (!this.renderer || this.rendererPreset !== p.name) {
      this.renderer?.renderer.dispose();
      this.renderer = new GameRenderer(canvas, p.render);
      this.rendererPreset = p.name;
    }
    await this.renderer.setSkin(s.skin);
    await this.renderer.setStadium(params.get('stadium') ?? s.stadium);
    if (play !== this.drill) return; // a newer rep arrived while this one loaded
    this.renderer.setWorld(play.world);
    this.renderer.setXray(this.renderer.xray);
    this.renderer.effortShading = s.effortShading;
    this.renderer.goreLevel = s.goreLevel;
    this.cam.snap(this.renderer.camera, play.world, this.humanHeading());
    this.input.clearLook(); // mouse movement during loading must not spin the fresh camera
    this.acc = 0;
    this.audio.play('game_whistle_start', 1);
  }

  pauseMenu() {
    this.paused = true;
    this.pausedAt = performance.now();
    this.input.capture = false;
    document.exitPointerLock?.();
    const net = this.net;
    if (net) { // the shared play goes on behind this menu
      this.layer.show(menu('Menu', [
        { label: 'Resume', hint: 'Esc / Start', action: () => this.resume() },
        { label: 'Positions', hint: 'next rep', action: () => this.lobby(true) },
        ...(net.isHost ? [{ label: 'Next rep', hint: 'Enter', sfx: 'ui_confirm', action: () => { this.resume(); void this.newRep(); } },
          { label: 'Back to lobby', sfx: 'ui_back', action: () => { this.drill = null; net.toLobby(); this.lobby(); } }] : []),
        { label: 'Settings', action: () => this.settingsMenu(() => this.pauseMenu()) },
        { label: 'Leave room', sfx: 'ui_back', action: () => this.leaveNet() },
      ], `Room ${net.room.code}  ·  the game keeps running`));
      return;
    }
    this.layer.show(menu('Paused', [
      { label: 'Resume', hint: 'Esc / Start', action: () => this.resume() },
      { label: 'Reset rep', hint: 'Enter', sfx: 'ui_confirm', action: () => { this.resume(); void this.newRep(); } },
      { label: 'Settings', action: () => this.settingsMenu(() => this.pauseMenu()) },
      { label: 'Inventory', hint: 'next rep', action: () => this.inventory(() => this.pauseMenu(), false) },
      { label: 'Quit to title', sfx: 'ui_back', action: () => { this.drill?.destroy(); this.drill = null; this.title(); } },
    ]));
  }

  resume() { this.layer.hide(); this.input.capture = true; this.paused = false; this.last = performance.now(); this.enterPlay(); }

  /** Playing: pointer lock for mouse look, and fullscreen with keyboard lock so the bound keys reach the game.
   *  Each can be refused (no user gesture, headless, unsupported); the game works without them. */
  enterPlay() {
    this.lockPointer();
    if (document.fullscreenElement) { void this.lockKeys(); return; } // bindings may have changed while paused
    if (!document.documentElement.requestFullscreen) return;
    document.documentElement.requestFullscreen().then(() => { this.lockPointer(); return this.lockKeys(); }).catch(() => {});
  }

  /** Lock only the bound keys: a bare lock() would also take Alt+Tab and the Windows key from the system. */
  lockKeys() {
    const kb = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } }).keyboard;
    return kb?.lock?.(this.input.lockKeys()).catch(() => {});
  }

  lockPointer() {
    if (this.settings.autoCamera || document.pointerLockElement || !canvas.requestPointerLock) return;
    try { void (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* refused: click the view to retry */ }
  }

  /** Esc released the pointer or left fullscreen mid-rep: pause, so the cursor is free for the menu. */
  lostFocus() { if (this.drill && !this.paused && !this.layer.open) this.pauseMenu(); }

  setAutoCamera(on: boolean) {
    this.settings.autoCamera = this.cam.follow = this.input.autoCamera = on;
    this.save();
    if (on) document.exitPointerLock?.();
  }

  /** Gameplay controls from the live bindings: HUD label, keyboard and mouse. */
  controlRows(): [string, string][] {
    const k = this.input.bindings.keyboard, t = (a: string) => keysText(k[a] ?? []);
    const move = ['moveUp', 'moveLeft', 'moveDown', 'moveRight'].map((a) => k[a]?.[0] ? keyName(k[a][0]) : '—').join(' ');
    return [
      ['Move', move], ['Sprint', t('sprint')], ['Thrust', t('thrust')], ['Jump', t('jump')], ['Dive', t('dive')],
      ['Left arm, grab', t('armL')], ['Right arm, grab', t('armR')],
      ['Pads down / up: torso and hips (scroll up = down)', `Scroll, ${t('torsoDown')} / ${t('torsoUp')}`],
      ['Side shuffle (toggle)', t('shiftLock')],
      ...(this.settings.autoCamera ? [] : [['Look', 'Mouse'] as [string, string]]),
    ];
  }

  keyTest(back = () => this.title()) {
    const box = el('div', { class: 'panel menu wide' }, el('h1', { text: 'Key test' }), el('p', { class: 'sub', text: 'Hold keys or buttons. Everything that registers shows below, so you can see which combinations your keyboard drops.' }));
    const keys = el('div', { class: 'keys' });
    const acts = el('p', { class: 'sub mono' });
    const b = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_back' }, 'Back (Esc)');
    b.addEventListener('click', () => { clearInterval(timer); back(); });
    box.append(keys, acts, b);
    const timer = window.setInterval(() => {
      if (!document.body.contains(box)) { clearInterval(timer); return; }
      keys.replaceChildren(...this.input.rawHeld().map((k) => el('span', { text: k })));
      const f = this.input.read(0, 0);
      acts.textContent = 'Actions: ' + ([...f.held].join(', ') || '—');
    }, 50);
    this.layer.show(box);
  }

  settingsMenu(back: () => void, tab?: string) { openSettings(this, back, tab); }

  /** Everything equippable (skins, stadiums, ...), with previews. Equipped items show from the next rep. */
  inventory(back = () => this.title(), escape = true) {
    const equip = (cat: string, item: string) => { const ok = equipItem(this.settings, cat, item); if (ok) this.save(); return ok; };
    this.layer.show(inventoryPanel(CATEGORIES, this.settings, { equip, back, escape }));
  }

  async benchmark() {
    const box = el('div', { class: 'panel menu wide' }, el('h1', { text: 'Benchmark' }));
    const out = el('textarea', { readonly: 'true', 'aria-label': 'Benchmark results' });
    out.value = 'Running… (about 6 seconds)';
    box.append(out);
    this.layer.show(box);
    const rs = await runBenchmark(canvas);
    out.value = reportText(rs);
    this.renderer = null; this.rendererPreset = null;
    const copy = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Copy results');
    copy.addEventListener('click', () => { void navigator.clipboard?.writeText(out.value).then(() => this.hud.flash('Copied'), () => out.select()); });
    const use = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, `Use recommended preset (${PRESETS[chooseBest(rs)].label})`);
    use.addEventListener('click', () => { this.settings.preset = chooseBest(rs); this.save(); this.title(); });
    const back = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_back' }, 'Back');
    back.addEventListener('click', () => this.title());
    box.append(copy, use, back);
    copy.focus();
  }

  toggleCamera() { this.cam.mode = this.cam.mode === 'chase' ? 'helmet' : 'chase'; this.settings.camera = this.cam.mode as Settings['camera']; this.save(); }
  save() { saveSettings(this.settings); }

  // ---------------------------------------------------------------- input
  onKey(e: KeyboardEvent) {
    this.audio.unlock();
    if (this.layer.open) {
      if ((document.activeElement as HTMLElement | null)?.tagName === 'SELECT') return; // its own arrow keys
      if (e.code === 'ArrowDown') { this.focusMove(1); e.preventDefault(); }
      else if (e.code === 'ArrowUp') { this.focusMove(-1); e.preventDefault(); }
      // the Esc that released the pointer can also arrive as a key press: it must not resume at once
      else if (e.code === 'Escape' && this.drill && performance.now() - this.pausedAt > 300) { this.audio.play('ui_back', 1); this.resume(); }
      return;
    }
    if (!this.drill) return;
    if (e.code === 'Tab' && this.net) { this.rosterOn = true; e.preventDefault(); return; } // held: who is in the room
    const k = this.input.bindings.keyboard;
    if (k.pause.includes(e.code)) this.pauseMenu();
    else if (k.reset.includes(e.code)) void this.newRep();
    else if (k.overlay.includes(e.code)) { this.settings.overlay = !this.settings.overlay; this.save(); }
    else if (k.tuning.includes(e.code)) { this.paused = true; this.pausedAt = performance.now(); this.input.capture = false; document.exitPointerLock?.(); this.settingsMenu(() => this.pauseMenu(), 'advanced'); }
  }

  /** Gamepad buttons for menus and Start (tap = reset, hold = pause). */
  pollPad(dt: number) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = pads[0];
    if (!p) return;
    const down = (i: number) => !!p.buttons[i]?.pressed;
    const edge = (i: number) => down(i) && !this.padPrev[i];
    if (this.layer.open) {
      if (edge(13)) this.focusMove(1);
      if (edge(12)) this.focusMove(-1);
      if (edge(0)) (document.activeElement as HTMLElement | null)?.click();
      if (edge(1) && this.drill) { this.audio.play('ui_back', 1); this.resume(); }
    } else if (this.drill) {
      if (down(9)) { this.startHeld += dt; if (this.startHeld > 0.6 && this.startHeld - dt <= 0.6) this.pauseMenu(); }
      else { if (this.startHeld > 0 && this.startHeld < 0.6) void this.newRep(); this.startHeld = 0; }
    }
    this.padPrev = p.buttons.map((b) => b.pressed);
  }

  focusMove(dir: 1 | -1) { moveFocus(this.layer.root, dir); this.audio.play('ui_move', 1); }

  humanHeading() {
    const q = this.drill!.world.scene.athletes[this.cam.target].state.segQuat;
    return headingOf(qrot([q[0], q[1], q[2], q[3]], [0, 0, 1]));
  }

  // ---------------------------------------------------------------- loop
  frame(now: number) {
    const dtReal = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps += (1 / Math.max(dtReal, 1e-3) - this.fps) * 0.05;
    this.pollPad(dtReal);
    const d = this.drill, r = this.renderer;
    if (d && r) {
      const w = d.world;
      if (!this.paused || this.net) { // a multiplayer play goes on behind the menu
        const f: InputFrame = this.input.read(0, dtReal);
        if (!this.paused) {
          if (!this.cam.follow) this.cam.look(f.look.x, f.look.y);
          this.human.latest = { move: f.move, torso: f.torso, sprint: f.sprint, armL: f.armL, armR: f.armR, held: f.held, cameraYaw: this.cam.yaw, aimPitch: this.cam.aimPitch, shiftLock: f.shiftLock };
          if (f.pressed.has('shiftLock')) this.hud.flash(`Side shuffle ${f.shiftLock ? 'on' : 'off'}`);
          if (this.net && d.human < 0) this.spectateKeys(f);
        } else this.human.latest = null; // in the menu he stands still
        if (this.net && !this.net.isHost) this.guestFrame(dtReal);
        else this.simulate(now, dtReal);
      }
      this.cam.update(r.camera, w, dtReal, this.humanHeading());
      r.hideHeadOf = this.cam.mode === 'helmet' ? this.cam.target : -1;
      const m = r.camera.matrixWorld.elements; // column 0: the camera's right axis
      this.audio.listen([r.camera.position.x, r.camera.position.y, r.camera.position.z], [m[0], m[1], m[2]]);
      const v = w.scene.athletes[this.cam.target].state.comVel;
      this.speed += (Math.hypot(v[0], v[2]) - this.speed) * Math.min(1, dtReal * 8);
      // FOV kick so a full sprint reads as fast: +12° from jog to top speed
      const fov = 55 + 12 * Math.min(1, Math.max(0, (this.speed - 3) / 7));
      if (Math.abs(r.camera.fov - fov) > 0.05) { r.camera.fov = fov; r.camera.updateProjectionMatrix(); }
      r.render(w, this.cam.target);
      this.updateHud();
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  /** The fixed steps real time owes (single player, and a multiplayer host's play for everyone). */
  simulate(now: number, dtReal: number) {
    const d = this.drill!, w = d.world, net = this.net;
    if (net && now < this.countdownUntil) return; // 3-2-1: nobody moves yet
    if (now / 1000 > this.slowUntil) this.timeScale = 1;
    // hit-stop freezes wall time only: the same fixed steps run afterwards, none are skipped mid-step
    if (now >= this.freezeUntil) this.acc += dtReal * this.timeScale;
    const t0 = performance.now();
    let steps = 0;
    while (this.acc >= w.dt && steps < 40) {
      if (net) net.step(); else d.step(); // the host's step also sends the snapshots
      this.acc -= w.dt; steps++;
      if (this.feedback(now)) { this.acc = 0; break; }
    }
    if (steps >= 40) this.acc = 0; // never spiral: drop time rather than fall behind
    this.physMs += (performance.now() - t0 - this.physMs) * 0.1;
    if (net && d.ended && w.time - d.endTime > AUTO_NEXT && !this.nextQueued) { this.nextQueued = true; void this.newRep(); }
  }

  /** A multiplayer guest's frame: send the input, show the host's play (interpolated), and the sounds and faces it
   *  makes. Big hits come from the host's events (replica contact forces are only an estimate). */
  guestFrame(dt: number) {
    const net = this.net!, d = this.drill!, w = d.world;
    net.sendInput(this.human.latest ?? IDLE);
    if (!net.render()) return; // nothing of this rep yet: the start pose
    if (this.meterWorld !== w) { this.meter = new HitMeter(); this.cues = new SoundCues(d.ball); this.meterWorld = w; }
    const { sounds } = this.meter.step(w, dt);
    for (const s of sounds) this.audio.hit(s);
    for (const c of this.cues.step(w, dt)) this.audio.play(c.cat, c.loud, c.pos, c.athlete);
    this.renderer?.stepFaces(w, dt);
    const loud = sounds[0]?.loud ?? 0;
    if (loud > 0.1) this.cam.addShake(0.04 * loud * loud);
  }

  /** A spectator: Space or the right arm button watches the next athlete, the left arm button the one before. */
  spectateKeys(f: InputFrame) {
    const n = this.drill!.world.athletes.length, step = f.pressed.has('jump') || f.pressed.has('armR') ? 1 : f.pressed.has('armL') ? -1 : 0;
    if (step) this.cam.target = this.spectate = (this.cam.target + step + n) % n;
  }

  /** Every contact makes a sound and a light shake by how hard it was; only a big hit (impulse over 30 ms
   *  and closing speed) gets slow motion, hit-stop, the camera punch and the banner. Call after each step;
   *  returns true when a hit-stop starts. */
  feedback(now: number): boolean {
    const d = this.drill!, w = d.world;
    if (this.meterWorld !== w) { this.meter = new HitMeter(); this.cues = new SoundCues(d.ball); this.meterWorld = w; }
    const { sounds, bigNow } = this.meter.step(w);
    for (const s of sounds) this.audio.hit(s);
    for (const c of this.cues.step(w)) this.audio.play(c.cat, c.loud, c.pos, c.athlete);
    this.renderer?.stepFaces(w);
    const loud = sounds[0]?.loud ?? 0;
    if (!bigNow) {
      if (loud > 0.1) { this.cam.addShake(0.04 * loud * loud); this.rumble({ duration: 60, strong: 0.3 * loud, weak: 0.5 * loud }); }
      return false;
    }
    const fx = this.bigHit(d, bigNow);
    if (this.net) { this.net.event({ k: 'hit', closing: bigNow.closing, impulse: bigNow.impulse, a: 0, b: 1 }); return false; } // shared time: no slow motion or hit-stop
    if (fx.slowMo && this.settings.slowMo && now / 1000 > this.slowUntil) { this.timeScale = 0.3; this.slowUntil = now / 1000 + 0.9; }
    if (!fx.stopMs || now < this.nextStop) return false;
    this.freezeUntil = now + fx.stopMs;
    this.nextStop = now + 500;
    return true;
  }

  /** A big hit's sound, shake, rumble, banner and camera punch (a multiplayer guest's from the host's event). */
  bigHit(d: Play, big: { impulse: number; closing: number }) {
    const w = d.world, fx = hitFeel(big.impulse, big.closing);
    const a = w.scene.athletes[0].state, b = w.scene.athletes[1].state;
    const n = [0, 1, 2].map((k) => b.com[k] - a.com[k]), along = (v: number[]) => v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
    this.audio.play('hit_big_layer', 0.5 + 0.5 * fx.k, [0, 1, 2].map((k) => (a.com[k] + b.com[k]) / 2));
    this.audio.play('crowd_ooh', 0.6 + 0.4 * fx.k);
    // the grunt comes from the athlete who was hit: the one closing less along the line between them
    const hit = along(a.comVel) >= -along(b.comVel) ? 1 : 0, hs = w.scene.athletes[hit].state, hi = w.athletes[hit].segIndex.get('head')!;
    this.audio.play('voice_grunt', 1, [hs.segPos[3 * hi], hs.segPos[3 * hi + 1], hs.segPos[3 * hi + 2]], hit);
    this.cam.addShake(fx.shake);
    this.rumble(fx.rumble);
    this.hud.flash('BIG HIT');
    if (w.hits.some((h) => h.a === d.human || h.b === d.human)) this.input.padsUp(); // given or taken: back to running
    this.cam.punch(n[0], n[2], fx.punch);
    return fx;
  }

  rumble(r: { duration: number; strong: number; weak: number }) {
    const pad = navigator.getGamepads?.()[0] as (Gamepad & { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } }) | null;
    pad?.vibrationActuator?.playEffect('dual-rumble', { duration: r.duration, strongMagnitude: r.strong, weakMagnitude: r.weak }).catch(() => {});
  }

  updateHud() {
    const d = this.drill!, w = d.world, me = w.athletes[this.cam.target];
    const sup = w.view(me).support; // present once the world runs the active-ragdoll support
    // the local player's athlete and team (single player: athlete 0, team 0; a spectator: team 0's view)
    const net = this.net, guest = !!net && !net.isHost, mine = d.human, T = mine >= 0 ? d.team(mine) : 0;
    const contact = guest ? mine >= 0 && w.athletes[mine].cmd.contactMode : this.human.contact; // a guest's brain runs on the host
    const mode = contact ? 'CONTACT (auto)' : 'MOVEMENT', bc = w.ballCarrier;
    const line = net && T !== 0 ? undefined : d.mode.status?.(d); // modes word their line for team 0
    if (d.ended && !this.scored) { this.scored = true; if (!net && d.scorer >= 0) this.score[d.scorer as 0 | 1] += d.points; } // multiplayer: the host keeps the score
    const score = net ? `${TEAM_NAMES[0]} ${net.lobby.score[0]} – ${net.lobby.score[1]} ${TEAM_NAMES[1]}` : `Score: you ${this.score[0]}, bots ${this.score[1]}`;
    this.hud.setStatus([
      `${this.mode.title.toUpperCase()}  ·  Rep ${d.rep + 1}  ·  ${Math.min(d.repTime, d.rules.timeLimit).toFixed(1)} s  ·  ${score}`,
      ...(net ? [this.netLine()] : []),
      ...(line ? [line] : []),
      net && mine < 0 ? `Ball: ${bc < 0 ? 'LOOSE' : `${d.mode.players[bc].label}, ${TEAM_NAMES[d.team(bc)]}`}` // a spectator
        : `Ball: ${mine >= 0 && bc === mine ? 'YOU HAVE IT — get it over the goal line' : bc < 0 ? 'LOOSE — dive on it' : d.team(bc) === T ? 'your teammate' : 'carrier'}   ·   Mode: ${mode}${this.human.latest?.shiftLock ? '  ·  SIDE SHUFFLE' : ''}${this.timeScale < 1 ? '   SLOW MOTION' : ''}`,
      sup ? `Support ${((d.cfg.support?.strength ?? 1) * 100).toFixed(0)}%  ·  posture ${(sup.posture * 100).toFixed(0)}%  ·  carry ${(sup.carry * 100).toFixed(0)}%${sup.down ? '  ·  DOWN' : ''}`
        : `Balance assist ${(this.settings.assist * 100).toFixed(0)}%${me.assistLevel < 1 ? ` (fading ${(me.assistLevel * 100).toFixed(0)}%)` : ''}`,
    ]);
    this.hud.setSpeed(this.speed, this.speed * MPH);
    this.hud.setControls(this.controlRows().map(([h, k]) => [k, h]));
    if (this.settings.overlay) {
      const st = w.scene.stats();
      this.hud.setOverlay([
        `FPS        ${this.fps.toFixed(0)}`, `physics    ${this.physMs.toFixed(2)} ms/frame`, `render     ${this.renderer!.lastMs.toFixed(2)} ms/frame`,
        `bodies     ${st.bodies}`, `contacts   ${st.contacts}`, `step rate  ${Math.round(1 / w.dt)} Hz`,
        `assist     ${(this.settings.assist * me.assistLevel * 100).toFixed(0)}%`, `preset     ${this.preset.label}`,
      ]);
    } else this.hud.setOverlay(null);
    this.netHud();
    if (d.ended && !this.endWhistled) { this.endWhistled = true; this.audio.play('game_whistle_end', 1); }
    if (d.ended && !this.peakShown && w.time - d.endTime > 0.6) {
      this.peakShown = true;
      const imp = w.impact;
      const result = resultTitle(d);
      const fumble = mine >= 0 && d.recoveredBy === mine ? 'Fumble recovered by you' : d.recoveredBy >= 0 ? `Fumble recovered by ${d.team(d.recoveredBy) === T ? 'your teammate' : net ? 'the other team' : 'the bots'}` : '';
      const title = fumble ? `${fumble}  ·  ${result}` : result;
      const ms = (v: number) => `${v.toFixed(1)} m/s (${(v * MPH).toFixed(1)} mph)`;
      // impulse over 30 ms, and the mean force it implies; the per-step peak force is a stiff-contact spike
      const J = (h: { impulse: number }) => `${h.impulse.toFixed(0)} N·s in 30 ms (${(h.impulse / 30).toFixed(1)} kN avg)`;
      // a guest's big hits are the host's (replica contact forces are an estimate)
      const big = guest ? this.netBig : this.meter.big, best = guest ? this.netBest ?? this.meter.best : this.meter.best;
      const points: [string, string] = net ? ['Points', `${d.points} to the ${TEAM_NAMES[d.scorer as 0 | 1]}  ·  ${score}`] : ['Points', `${d.points} to ${d.scorer === 0 ? 'you' : 'the bots'}  ·  score: you ${this.score[0]}, bots ${this.score[1]}`];
      this.hud.showResult({
        title,
        banner: big ? `BIG HIT  ·  ${ms(big.closing)}  ·  ${J(big)}` : undefined,
        rows: imp.firstContactTime >= 0 ? [
          ['Closing speed', ms(imp.closingSpeed)],
          ['Hardest hit', best ? J(best) : '—'],
          [mine >= 0 || !net ? 'Peak head accel (you)' : 'Peak head accel (watched)', `${imp.peakHeadG[this.cam.target].toFixed(0)} g`],
          ['Peak head accel (athlete 2)', `${imp.peakHeadG[1].toFixed(0)} g`],
          ...(d.points ? [points] : []),
        ] : [['Contact', 'none']],
        foot: !net ? 'Enter / Start: next rep   ·   head acceleration is a 60 Hz-filtered estimate'
          : net.isHost ? `Enter / Start: next rep (it starts by itself in ${AUTO_NEXT} s)` : 'The host starts the next rep',
      });
    }
  }
}

/** The result card's title, from the local player's side (single player: team 0; a spectator sees team 0's). */
function resultTitle(d: Play): string {
  if (d.verdict) return d.verdict;
  const T = d.human >= 0 ? d.team(d.human) : 0, bc = d.world.ballCarrier, me = d.human >= 0 && bc === d.human, ours = bc >= 0 && d.team(bc) === T;
  switch (d.ended) {
    case 'time': return 'Time';
    case 'touchdown': return d.scorer === T ? 'Touchdown!' : 'Missed — touchdown';
    case 'safety': return d.scorer === T ? 'Safety! Two points' : 'Safety against you';
    case 'touchback': return 'Touchback';
    case 'out': return bc < 0 ? 'Ball out of bounds' : me ? 'You went out of bounds' : ours ? 'Your runner went out of bounds' : 'Carrier out of bounds';
    default: return me ? 'Tackled' : ours ? 'Your runner was tackled' : d.world.impact.firstContactTime < 0 ? 'Carrier down (no contact)' : 'Tackle — carrier down';
  }
}

if (params.get('bench') === '1') {
  // automation hook (bench/presets.ts): run the in-game benchmark and publish the results
  void (async () => {
    await mujocoEngine.init();
    document.getElementById('loading')!.textContent = 'Benchmarking…';
    const rs = await runBenchmark(canvas, undefined, params.get('skin') ?? undefined);
    (window as unknown as { __bench: unknown }).__bench = { results: rs, report: reportText(rs) };
    document.getElementById('loading')!.textContent = reportText(rs);
  })().catch((e) => console.error(e));
} else if (params.get('scenario')) void devScenario(params.get('scenario')!).catch((e) => console.error(e));
else {
  const app = new App();
  (window as unknown as { __app: App }).__app = app;
  app.boot().catch((e) => {
    console.error(e);
    const el0 = document.getElementById('loading');
    if (el0) el0.textContent = 'Failed to start: ' + (e instanceof Error ? e.message : String(e));
  });
}
