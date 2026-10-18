// Browser entry: title menu, open-field drill, HUD, pause menu, panels. The simulation runs on a fixed
// timestep; slow motion only changes how fast real time feeds the fixed steps.
import './testLock'; // first: tests must not capture the owner's real cursor
import type { SupportSettings } from '../sim/anim/types';
import { HumanBrain } from '../sim/brains/human';
import { carrierSkill } from '../sim/brains/carrier';
import { DEFAULT_GAINS } from '../sim/control/hand';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../sim/drills/openField';
import { headingOf, qrot } from '../sim/math';
import { mujocoEngine } from '../sim/physics/mujoco';
import { carrierVsTacklerScenario, pushScenario, runScenario, standScenario, type Scenario } from '../sim/scenarios';
import { World, type PhysicsSettings } from '../sim/world';
import { Audio } from './audio';
import { chooseBest, reportText, runBenchmark } from './benchmark';
import { ChaseCamera } from './camera';
import { SoundCues } from './cues';
import { HitMeter, hitFeel, MPH } from './feel';
import { InputManager, keyName, keysText, RESERVED, type InputFrame } from './input/input';
import { PRESETS, type PresetName } from './presets';
import { GameRenderer, RENDER_PRESETS } from './render/renderer';
import { DEFAULT_SETTINGS, DIFFICULTY_PRESETS, GAME_SUPPORT, PLAYER_BASE, difficultyOf, loadSettings, saveSettings, type Settings } from './settings';
import { skinById, unlockedSkins } from './render/skin';
import { el, Hud, Layer, menu, moveFocus } from './ui';

/** Rebindable actions on the Controls screen: binding name, what it does, controller button. */
const REBIND: [string, string, string][] = [
  ['moveUp', 'Move forward (relative to the camera)', 'Left stick'], ['moveLeft', 'Move left', 'Left stick'],
  ['moveDown', 'Move back', 'Left stick'], ['moveRight', 'Move right', 'Left stick'],
  ['sprint', 'Sprint (drives the legs in contact)', 'RT'],
  ['sink', 'Sink the hips (hold longer = lower)', 'LT (depth)'],
  ['thrust', 'Thrust the hips forward (overrides sink and torso)', 'A'],
  ['dive', 'Dive forward (one press: launch, fly, land)', 'B'],
  ['armL', 'Left arm: raise toward the aim, grab what it touches', 'LB'],
  ['armR', 'Right arm: raise toward the aim, grab what it touches', 'RB'],
  ['torsoDown', 'Angle the torso down, to level (also scroll up)', 'D-pad down'],
  ['torsoUp', 'Angle the torso up (also scroll down)', 'D-pad up'],
  ['shiftLock', 'Side shuffle on / off: face the camera way, A / D shuffle', 'L3 (stick click)'],
  ['reset', 'Reset rep', 'Start (tap)'], ['tuning', 'Tuning panel', 'menu'], ['overlay', 'Performance overlay', 'menu'],
];
/** Controls that are not rebindable. */
const FIXED: string[][] = [['Torso angle', 'Scroll (up = lower the shoulders)', '—'], ['Look (aims the arms)', 'Mouse', 'Right stick'], ['Pause', 'Esc', 'Start (hold)']];

const DIFF_LABEL = { easy: 'Easy', normal: 'Normal', hard: 'Hard', custom: 'Custom' };
/** A labelled range slider row in a .grid2 panel; `changed` runs after every edit. */
const sliderRow = (grid: HTMLElement, changed: () => void) =>
  (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, fmt = (v: number) => v.toFixed(3)) => {
    const out = el('span', { class: 'mono', text: fmt(value) });
    const r = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
    r.addEventListener('input', () => { const v = +r.value; out.textContent = fmt(v); set(v); changed(); });
    grid.append(el('label', { text: label }), r, out);
  };
const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;

// ------------------------------------------------------------------ dev scenarios (?scenario=…)
async function devScenario(name: string) {
  const physics: PhysicsSettings = { hz: +(params.get('hz') ?? 240), iterations: 30, detail: (params.get('detail') as PhysicsSettings['detail']) ?? 'standard' };
  const assist = +(params.get('assist') ?? 0);
  const sc: Scenario = name === 'push' ? pushScenario(physics, +(params.get('dir') ?? 0), +(params.get('imp') ?? 60), assist)
    : name === 'walk' || name === 'jog' || name === 'sprint' ? runScenario(physics, name, { assist })
    : name === 'cut' ? runScenario(physics, 'jog', { assist, cutAt: 3 })
    : name === 'hit' ? carrierVsTacklerScenario(physics, { hitPower: +(params.get('hp') ?? 1) }) : standScenario(physics, assist);
  const world = await World.create(mujocoEngine, sc.setup);
  const r = new GameRenderer(canvas, RENDER_PRESETS[(params.get('gfx') as 'minimum' | 'high') ?? 'high']);
  await r.setSkin(params.get('skin') ?? DEFAULT_SETTINGS.skin);
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
  drill: OpenFieldDrill | null = null;
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
  /** Open-field mode: tackle the bot carrier, or carry the ball past the bot tackler. */
  drillMode: 'tackle' | 'carry' = 'tackle';
  startHeld = 0;
  pausedAt = 0;
  /** Keyboard lock is active (fullscreen): Ctrl+W reaches the game instead of closing the tab. */
  kbLocked = false;
  private padPrev: boolean[] = [];

  async boot() {
    this.input.capture = false;
    this.cam.mode = this.settings.camera;
    this.cam.follow = this.input.autoCamera = this.settings.autoCamera;
    this.input.sprintToggle = this.settings.sprintToggle; this.input.sinkToggle = this.settings.sinkToggle;
    this.input.setKeyboard(this.settings.bindings);
    this.audio.muted = this.settings.mute;
    // Alt+Tab (or any switch away): pause, which frees the mouse; Resume or a click on the field captures it again
    window.addEventListener('blur', () => this.lostFocus());
    canvas.addEventListener('click', () => { if (!this.paused) this.lockPointer(); });
    document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) this.lostFocus(); });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { this.kbLocked = false; this.lostFocus(); } });
    window.addEventListener('resize', () => this.renderer?.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
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
  title() {
    this.paused = true;
    this.audio.loop(null);
    this.hud.setVisible(false);
    this.hud.showResult(null);
    this.input.capture = false;
    document.exitPointerLock?.();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.layer.show(menu('ZANE STICK', [
      { label: 'Open field: tackle the carrier', hint: 'Enter / A', action: () => this.startDrill('tackle') },
      { label: 'Open field: carry the ball (the bot tackles)', action: () => this.startDrill('carry') },
      { label: `Difficulty: ${DIFF_LABEL[difficultyOf(this.settings)]}`, hint: 'next rep', action: () => this.difficulty() },
      { label: 'Controls', action: () => this.controls() },
      { label: 'Key test', action: () => this.keyTest() },
      { label: `Quality: ${this.preset.label}`, hint: 'next rep', action: () => { this.cyclePreset(); this.title(); } },
      { label: `Skin: ${skinById(this.settings.skin).label}`, action: () => { this.cycleSkin(); this.title(); } },
      { label: 'Benchmark', action: () => this.benchmark() },
    ], 'Physics football. Every movement is muscles on a simulated body.'));
  }

  async startDrill(mode: 'tackle' | 'carry' = 'tackle') {
    this.drillMode = mode;
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
    this.drill?.destroy();
    this.hud.showResult(null);
    this.peakShown = false;
    this.endWhistled = false;
    this.input.resetToggles();
    // The rep's pre-roll steps the human brain with the last input: a camera still turned from the previous rep
    // (e.g. running back after a fumble) and a held key would turn the athlete around before the rep starts.
    // Start from the spawn heading (+Z) with no movement.
    this.cam.yaw = 0;
    this.human.latest = null;
    const p = this.preset;
    const s = this.settings;
    this.human.steerAssist = s.steerAssist;
    this.drill = await OpenFieldDrill.create(mujocoEngine, {
      ...DEFAULT_OPEN_FIELD, physics: p.physics, assist: s.assist, seed: 1, difficulty: carrierSkill(s.juking), toughness: s.toughness, hitPower: s.hitPower,
      mode: this.drillMode, human: { ...DEFAULT_OPEN_FIELD.human, strength: PLAYER_BASE.strength * s.strength, speed: PLAYER_BASE.speed * s.speed }, traction: s.traction, gains: s.gains,
      support: { ...GAME_SUPPORT, ...s.support },
    }, this.human, this.rep++);
    if (!this.renderer || this.rendererPreset !== p.name) {
      this.renderer?.renderer.dispose();
      this.renderer = new GameRenderer(canvas, p.render);
      this.rendererPreset = p.name;
    }
    await this.renderer.setSkin(s.skin);
    this.renderer.setWorld(this.drill.world);
    this.renderer.setXray(this.renderer.xray);
    this.renderer.effortShading = s.effortShading;
    this.cam.snap(this.renderer.camera, this.drill.world, this.humanHeading());
    this.input.clearLook(); // mouse movement during loading must not spin the fresh camera
    this.acc = 0;
    this.audio.play('game_whistle_start', 1);
  }

  pauseMenu() {
    this.paused = true;
    this.pausedAt = performance.now();
    this.input.capture = false;
    document.exitPointerLock?.();
    const s = this.settings;
    this.layer.show(menu('Paused', [
      { label: 'Resume', hint: 'Esc / Start', action: () => this.resume() },
      { label: 'Reset rep', hint: 'Enter', sfx: 'ui_confirm', action: () => { this.resume(); void this.newRep(); } },
      { label: `Difficulty: ${DIFF_LABEL[difficultyOf(s)]}`, hint: 'next rep', action: () => this.difficulty(() => this.pauseMenu()) },
      { label: `Quality: ${this.preset.label}`, hint: 'next rep', action: () => { this.cyclePreset(); this.pauseMenu(); } },
      { label: `Skin: ${skinById(s.skin).label}`, action: () => { this.cycleSkin(); this.pauseMenu(); } },
      { label: `Anatomy view: ${this.renderer?.xray ? 'on' : 'off'}`, action: () => { this.renderer?.setXray(!this.renderer.xray); this.pauseMenu(); } },
      { label: `Effort shading (anatomy view): ${s.effortShading ? 'on' : 'off'}`, action: () => { s.effortShading = !s.effortShading; if (this.renderer) this.renderer.effortShading = s.effortShading; this.save(); this.pauseMenu(); } },
      { label: `Big-hit slow motion: ${s.slowMo ? 'on' : 'off'}`, action: () => { s.slowMo = !s.slowMo; this.save(); this.pauseMenu(); } },
      { label: `Camera: ${this.cam.mode}`, action: () => { this.toggleCamera(); this.pauseMenu(); } },
      { label: `Automatic camera: ${s.autoCamera ? 'on (follows the athlete)' : 'off (mouse look)'}`, action: () => { this.setAutoCamera(!s.autoCamera); this.pauseMenu(); } },
      { label: `Sound: ${s.mute ? 'off' : 'on'}`, action: () => { s.mute = !s.mute; this.audio.muted = s.mute; this.save(); this.pauseMenu(); } },
      { label: 'Tuning panel', hint: 'T', action: () => this.tuning() },
      { label: 'Controls', action: () => this.controls(() => this.pauseMenu()) },
      { label: 'Key test', action: () => this.keyTest(() => this.pauseMenu()) },
      { label: 'Quit to title', sfx: 'ui_back', action: () => { this.drill?.destroy(); this.drill = null; this.title(); } },
    ]));
  }

  resume() { this.layer.hide(); this.input.capture = true; this.paused = false; this.last = performance.now(); this.enterPlay(); }

  /** Playing: pointer lock for mouse look, and fullscreen with keyboard lock so Ctrl+W (sink + forward) cannot
   *  close the tab. Each can be refused (no user gesture, headless, unsupported); the game works without them. */
  enterPlay() {
    this.lockPointer();
    if (document.fullscreenElement) { void this.lockKeys(); return; } // bindings may have changed while paused
    if (!document.documentElement.requestFullscreen) return;
    document.documentElement.requestFullscreen().then(() => { this.lockPointer(); return this.lockKeys(); }).catch(() => {});
  }

  /** Lock only the bound keys: a bare lock() would also take Alt+Tab and the Windows key from the system. */
  lockKeys() {
    const kb = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } }).keyboard;
    return kb?.lock?.(this.input.lockKeys()).then(() => { this.kbLocked = !!document.fullscreenElement; }).catch(() => {});
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
      ['Move', move], ['Sprint', t('sprint')], ['Sink', t('sink')], ['Thrust', t('thrust')], ['Dive', t('dive')],
      ['Left arm, grab', t('armL')], ['Right arm, grab', t('armR')],
      ['Torso down / up (scroll up = down)', `Scroll, ${t('torsoDown')} / ${t('torsoUp')}`],
      ['Side shuffle (toggle)', t('shiftLock')],
      ...(this.settings.autoCamera ? [] : [['Look', 'Mouse'] as [string, string]]),
    ];
  }

  /** Controls screen: every rebindable action with its keys; Replace or Add listens for the next key or mouse button. */
  controls(back = () => this.title()) {
    const k = () => this.input.bindings.keyboard;
    const status = el('p', { class: 'sub', role: 'status', text: 'Replace or Add, then press a key or mouse button. Esc, Alt, Tab and the Windows key stay with the browser and system.' });
    const table = el('table', { class: 'controls' });
    const render = () => table.replaceChildren(
      el('tr', {}, ...['Action', 'Keyboard and mouse', 'Controller', ''].map((h) => el('th', { text: h }))),
      ...REBIND.map(([a, label, pad]) => {
        const rep = el('button', { class: 'bind', type: 'button', 'aria-label': `Replace ${label}` }, 'Replace');
        const add = el('button', { class: 'bind', type: 'button', 'aria-label': `Add a key to ${label}` }, 'Add');
        rep.addEventListener('click', () => this.listenForBind(a, label, false, status, render));
        add.addEventListener('click', () => this.listenForBind(a, label, true, status, render));
        return el('tr', { 'data-action': a }, el('td', { text: label }), el('td', { class: 'keys-cell', text: keysText(k()[a] ?? []) }), el('td', { text: pad }), el('td', {}, rep, add));
      }),
      ...FIXED.map((r) => el('tr', {}, ...r.map((c) => el('td', { text: c })), el('td'))));
    render();
    // hold or toggle (press on, press again off) for sprint and sink; every rep starts with both off
    const s = this.settings;
    const mode = (label: string, get: () => boolean, set: (on: boolean) => void) => {
      const btn = el('button', { class: 'item', type: 'button' }, '');
      const show = () => (btn.textContent = `${label}: ${get() ? 'toggle (press on / off)' : 'hold'}`);
      btn.addEventListener('click', () => { set(!get()); this.save(); show(); });
      show();
      return btn;
    };
    const sprintMode = mode('Sprint', () => s.sprintToggle, (on) => (s.sprintToggle = this.input.sprintToggle = on));
    const sinkMode = mode('Sink hips', () => s.sinkToggle, (on) => (s.sinkToggle = this.input.sinkToggle = on));
    const reset = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Reset controls to defaults');
    reset.addEventListener('click', () => { this.settings.bindings = {}; this.input.setKeyboard({}); this.save(); render(); status.textContent = 'Controls reset to the defaults.'; });
    const b = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_back' }, 'Back');
    b.addEventListener('click', back);
    const box = el('div', { class: 'panel menu wide' }, el('h1', { text: 'Controls' }),
      el('p', { class: 'sub', text: 'Contact mode is automatic: within about 4 m of the ball carrier your athlete settles into a ready stance with the arms up. No control is needed for balance; once you make contact, physics decides who stays up. J / L and I / K always work alongside the mouse, so a touchpad is enough.' }),
      status, table, sprintMode, sinkMode,
      el('p', { class: 'sub', text: 'Click the field to capture the mouse; Esc frees it and pauses. Ctrl+W can close the tab unless the browser grants keyboard lock in fullscreen, so C also sinks. Anatomy view, camera view, quality and automatic camera are in the pause menu.' }),
      reset, b);
    this.layer.show(box);
  }

  /** Wait for the next key or mouse button and bind it to the action (Esc cancels). A key taken from another action
   *  leaves it, so one key never does two things. */
  listenForBind(action: string, label: string, add: boolean, status: HTMLElement, done: () => void) {
    status.textContent = `Press a key or mouse button for "${label}"… (Esc cancels)`;
    (document.activeElement as HTMLElement | null)?.blur(); // a Space press must not re-click the button
    const swallow = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const finish = (code: string | null) => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      // the click and context menu that follow a bound mouse press must not reach the menu
      setTimeout(() => { window.removeEventListener('click', swallow, true); window.removeEventListener('contextmenu', swallow, true); }, code?.startsWith('Mouse') ? 400 : 0);
      if (code) {
        const k = this.input.bindings.keyboard, next: Record<string, string[]> = {};
        for (const [a, codes] of Object.entries(k)) if (a !== action && codes.includes(code)) next[a] = codes.filter((c) => c !== code);
        next[action] = add ? [...new Set([...(k[action] ?? []), code])] : [code];
        this.settings.bindings = { ...this.settings.bindings, ...next };
        this.input.setKeyboard(this.settings.bindings);
        this.save();
        this.audio.play('ui_confirm', 1);
        status.textContent = `"${label}": ${keysText(this.input.bindings.keyboard[action])}`;
      } else status.textContent = 'Cancelled.';
      done();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!status.isConnected) { finish(null); return; } // the screen was left (controller B): stop listening
      swallow(e);
      if (e.code === 'Escape') finish(null);
      else if (RESERVED.test(e.code)) status.textContent = `${keyName(e.code)} stays with the browser and system: press another key (Esc cancels)`;
      else finish(e.code);
    };
    const onMouse = (e: MouseEvent) => { if (!status.isConnected) { finish(null); return; } swallow(e); finish(`Mouse${e.button}`); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('contextmenu', swallow, true);
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

  /** Difficulty: presets and the independent axes (AI toughness, AI juking, the player's strength and speed), and
   *  hit power. Applies from the next rep. */
  difficulty(back = () => this.title()) {
    const s = this.settings;
    const status = el('p', { class: 'sub', role: 'status' });
    const presets = el('div', { class: 'items' });
    const grid = el('div', { class: 'grid2' });
    const render = () => {
      const now = difficultyOf(s);
      status.textContent = `Difficulty: ${DIFF_LABEL[now]}. Each slider moves on its own; changes apply from the next rep.`;
      presets.replaceChildren(...(Object.keys(DIFFICULTY_PRESETS) as (keyof typeof DIFFICULTY_PRESETS)[]).map((k) => {
        const b = el('button', { class: 'item', type: 'button', 'aria-pressed': String(now === k), 'data-sfx': 'ui_confirm' }, DIFF_LABEL[k] + (now === k ? ' ✓' : ''));
        b.addEventListener('click', () => { Object.assign(s, DIFFICULTY_PRESETS[k]); this.save(); this.difficulty(back); });
        return b;
      }));
    };
    const x = (v: number) => `${v.toFixed(2)}×`, pct = (v: number) => `${(v * 100).toFixed(0)} %`;
    const row = sliderRow(grid, () => { this.save(); render(); });
    row('AI toughness (force needed to tackle the bot)', s.toughness, 0.4, 2.5, 0.05, (v) => (s.toughness = v), x);
    row('AI juking', s.juking, 0, 1, 0.05, (v) => (s.juking = v), pct);
    row('Player strength', s.strength, 0.5, 1.5, 0.01, (v) => (s.strength = v), x);
    row('Player speed', s.speed, 0.7, 1.5, 0.01, (v) => (s.speed = v), x);
    row('Hit power', s.hitPower, 1, 3, 0.1, (v) => (s.hitPower = v), (v) => (v <= 1 ? '1.0 (pure physics)' : `${v.toFixed(1)}×`));
    row('Steer assist', s.steerAssist, 0, 1, 0.05, (v) => (s.steerAssist = v), pct);
    render();
    const b = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_back' }, 'Back');
    b.addEventListener('click', back);
    this.layer.show(el('div', { class: 'panel menu wide', role: 'dialog', 'aria-label': 'Difficulty' }, el('h1', { text: 'Difficulty' }), status, presets, grid,
      el('p', { class: 'sub', text: 'AI toughness: how hard the bot is to knock off balance (its hit, stun and wrap-up thresholds). AI juking: how well the bot carrier reads you, times his cuts and bursts away. Hit power above 1 adds an arcade push to whoever a hit drives back (the bot can blow you back too); 1 is pure physics. Steer assist turns your run part way toward the ball carrier (or a loose ball) when he is near and ahead.' }),
      b));
  }

  tuning() {
    const s = this.settings;
    const gainKeys: (keyof typeof DEFAULT_GAINS)[] = ['torsoKp', 'torsoKd', 'footK', 'stepWidth', 'swingWn', 'stanceKnee', 'stanceHip', 'dcmK', 'heightKp', 'heightKd', 'spine'];
    const grid = el('div', { class: 'grid2' });
    const row = sliderRow(grid, () => this.save());
    const pct = (v: number) => `${(v * 100).toFixed(0)} %`, deg = (v: number) => `${(v * 180 / Math.PI).toFixed(0)}°`;
    const sup = s.support;
    const supportRow = (label: string, k: keyof SupportSettings, min: number, max: number, step: number, fmt?: (v: number) => string) =>
      row(`Support: ${label}`, sup[k], min, max, step, (v) => (sup[k] = v), fmt);
    supportRow('strength', 'strength', 0, 1, 0.01, pct);
    supportRow('carry accel (m/s²)', 'carryAccel', 0, 15, 0.1, (v) => v.toFixed(1));
    supportRow('weight share', 'weightShare', 0, 1, 0.01, pct);
    supportRow('tilt fade start', 'tiltStart', 0.1, 1.2, 0.01, deg);
    supportRow('tilt fade end', 'tiltEnd', 0.2, 1.5, 0.01, deg);
    supportRow('big hit (N·s)', 'bigHit', 20, 400, 1, (v) => v.toFixed(0));
    supportRow('tracking stiffness ×', 'tracking', 0.25, 2, 0.01, (v) => v.toFixed(2));
    row('Athlete speed ×', s.speed, 0.7, 1.5, 0.01, (v) => (s.speed = v), (v) => v.toFixed(2));
    row('Muscle strength ×', s.strength, 0.5, 1.5, 0.01, (v) => (s.strength = v), (v) => v.toFixed(2));
    row('Balance assist (no support)', s.assist, 0, 1, 0.01, (v) => (s.assist = v), pct);
    row('Cleat traction μ', s.traction, 0.5, 1.6, 0.01, (v) => (s.traction = v));
    for (const k of gainKeys) {
      const d = DEFAULT_GAINS[k], v = s.gains[k] ?? d;
      row(`Gain: ${k}`, v, d * 0.25, d * 4, d / 100, (x) => (s.gains[k] = x));
    }
    const exp = el('textarea', { readonly: 'true', 'aria-label': 'Exported values' });
    const update = () => (exp.value = JSON.stringify({ support: sup, speed: PLAYER_BASE.speed * s.speed, strength: PLAYER_BASE.strength * s.strength, assist: s.assist, traction: s.traction, gains: { ...DEFAULT_GAINS, ...s.gains } }, null, 2));
    update();
    grid.addEventListener('input', update);
    const copy = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Copy values');
    copy.addEventListener('click', () => { void navigator.clipboard?.writeText(exp.value).then(() => this.hud.flash('Copied'), () => { exp.select(); }); });
    const reset = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Reset to defaults');
    reset.addEventListener('click', () => { s.gains = {}; s.assist = 0.2; s.traction = 1.2; s.support = { ...GAME_SUPPORT }; this.save(); this.tuning(); });
    const back = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_back' }, 'Back');
    back.addEventListener('click', () => (this.drill ? this.pauseMenu() : this.title()));
    this.layer.show(el('div', { class: 'panel menu wide' }, el('h1', { text: 'Tuning' }), el('p', { class: 'sub', text: 'Changes apply from the next rep (physics settings never change mid-rep).' }), grid, exp, copy, reset, back));
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

  cyclePreset() { this.settings.preset = this.settings.preset === 'high' ? 'minimum' : 'high'; this.save(); this.hud.flash(`Quality: ${this.preset.label} (next rep)`); }
  toggleCamera() { this.cam.mode = this.cam.mode === 'chase' ? 'helmet' : 'chase'; this.settings.camera = this.cam.mode as Settings['camera']; this.save(); }
  cycleSkin() {
    const all = unlockedSkins(), i = all.findIndex((k) => k.id === this.settings.skin);
    this.settings.skin = all[(i + 1) % all.length].id;
    this.save();
    void this.renderer?.setSkin(this.settings.skin);
  }
  save() { saveSettings(this.settings); }

  // ---------------------------------------------------------------- input
  onKey(e: KeyboardEvent) {
    this.audio.unlock();
    if (this.layer.open) {
      if (e.code === 'ArrowDown') { this.focusMove(1); e.preventDefault(); }
      else if (e.code === 'ArrowUp') { this.focusMove(-1); e.preventDefault(); }
      // the Esc that released the pointer can also arrive as a key press: it must not resume at once
      else if (e.code === 'Escape' && this.drill && performance.now() - this.pausedAt > 300) { this.audio.play('ui_back', 1); this.resume(); }
      return;
    }
    if (!this.drill) return;
    const k = this.input.bindings.keyboard;
    if (k.pause.includes(e.code)) this.pauseMenu();
    else if (k.reset.includes(e.code)) void this.newRep();
    else if (k.overlay.includes(e.code)) { this.settings.overlay = !this.settings.overlay; this.save(); }
    else if (k.tuning.includes(e.code)) { this.paused = true; this.pausedAt = performance.now(); this.input.capture = false; document.exitPointerLock?.(); this.tuning(); }
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
    const q = this.drill!.world.scene.athletes[0].state.segQuat;
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
      if (!this.paused) {
        const f: InputFrame = this.input.read(0, dtReal);
        if (!this.cam.follow) this.cam.look(f.look.x, f.look.y);
        this.human.latest = { move: f.move, torso: f.torso, sprint: f.sprint, sink: f.sink, armL: f.armL, armR: f.armR, held: f.held, cameraYaw: this.cam.yaw, aimPitch: this.cam.aimPitch, shiftLock: f.shiftLock };
        if (f.pressed.has('shiftLock')) this.hud.flash(`Side shuffle ${f.shiftLock ? 'on' : 'off'}`);
        if (now / 1000 > this.slowUntil) this.timeScale = 1;
        // hit-stop freezes wall time only: the same fixed steps run afterwards, none are skipped mid-step
        if (now >= this.freezeUntil) this.acc += dtReal * this.timeScale;
        const t0 = performance.now();
        let steps = 0;
        while (this.acc >= w.dt && steps < 40) {
          d.step(); this.acc -= w.dt; steps++;
          if (this.feedback(now)) { this.acc = 0; break; }
        }
        if (steps >= 40) this.acc = 0; // never spiral: drop time rather than fall behind
        this.physMs += (performance.now() - t0 - this.physMs) * 0.1;
      }
      this.cam.update(r.camera, w, dtReal, this.humanHeading());
      r.hideHeadOf = this.cam.mode === 'helmet' ? this.cam.target : -1;
      const m = r.camera.matrixWorld.elements; // column 0: the camera's right axis
      this.audio.listen([r.camera.position.x, r.camera.position.y, r.camera.position.z], [m[0], m[1], m[2]]);
      const v = w.scene.athletes[0].state.comVel;
      this.speed += (Math.hypot(v[0], v[2]) - this.speed) * Math.min(1, dtReal * 8);
      // FOV kick so a full sprint reads as fast: +12° from jog to top speed
      const fov = 55 + 12 * Math.min(1, Math.max(0, (this.speed - 3) / 7));
      if (Math.abs(r.camera.fov - fov) > 0.05) { r.camera.fov = fov; r.camera.updateProjectionMatrix(); }
      r.render(w);
      this.updateHud();
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Every contact makes a sound and a light shake by how hard it was; only a big hit (impulse over 30 ms
   *  and closing speed) gets slow motion, hit-stop, the camera punch and the banner. Call after each step;
   *  returns true when a hit-stop starts. */
  feedback(now: number): boolean {
    const d = this.drill!, w = d.world;
    if (this.meterWorld !== w) { this.meter = new HitMeter(); this.cues = new SoundCues(d.ball); this.meterWorld = w; }
    const { sounds, bigNow } = this.meter.step(w);
    for (const s of sounds) this.audio.hit(s);
    for (const c of this.cues.step(w)) this.audio.play(c.cat, c.loud, c.pos);
    const loud = sounds[0]?.loud ?? 0;
    const pad = navigator.getGamepads?.()[0] as (Gamepad & { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } }) | null;
    const rumble = (r: { duration: number; strong: number; weak: number }) => pad?.vibrationActuator?.playEffect('dual-rumble', { duration: r.duration, strongMagnitude: r.strong, weakMagnitude: r.weak }).catch(() => {});
    if (!bigNow) {
      if (loud > 0.1) { this.cam.addShake(0.04 * loud * loud); rumble({ duration: 60, strong: 0.3 * loud, weak: 0.5 * loud }); }
      return false;
    }
    const fx = hitFeel(bigNow.impulse, bigNow.closing);
    const a = w.scene.athletes[0].state, b = w.scene.athletes[1].state;
    const n = [0, 1, 2].map((k) => b.com[k] - a.com[k]), along = (v: number[]) => v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
    this.audio.play('hit_big_layer', 0.5 + 0.5 * fx.k, [0, 1, 2].map((k) => (a.com[k] + b.com[k]) / 2));
    this.audio.play('crowd_ooh', 0.6 + 0.4 * fx.k);
    // the grunt comes from the athlete who was hit: the one closing less along the line between them
    const hit = along(a.comVel) >= -along(b.comVel) ? 1 : 0, hs = w.scene.athletes[hit].state, hi = w.athletes[hit].segIndex.get('head')!;
    this.audio.play('voice_grunt', 1, [hs.segPos[3 * hi], hs.segPos[3 * hi + 1], hs.segPos[3 * hi + 2]]);
    this.cam.addShake(fx.shake);
    rumble(fx.rumble);
    this.hud.flash('BIG HIT');
    if (fx.slowMo && this.settings.slowMo && now / 1000 > this.slowUntil) { this.timeScale = 0.3; this.slowUntil = now / 1000 + 0.9; }
    this.cam.punch(n[0], n[2], fx.punch);
    if (!fx.stopMs || now < this.nextStop) return false;
    this.freezeUntil = now + fx.stopMs;
    this.nextStop = now + 500;
    return true;
  }

  updateHud() {
    const d = this.drill!, w = d.world, me = w.athletes[0];
    const sup = w.view(me).support; // present once the world runs the active-ragdoll support
    const mode = this.human.contact ? 'CONTACT (auto)' : 'MOVEMENT';
    this.hud.setStatus([
      `${this.drillMode === 'carry' ? 'BALL CARRIER' : 'OPEN FIELD'}  ·  Rep ${d.rep + 1}  ·  ${Math.min(d.repTime, d.cfg.timeLimit).toFixed(1)} s`,
      `Ball: ${w.ballCarrier === d.human ? 'YOU HAVE IT — score at the far end zone' : w.ballCarrier < 0 ? 'LOOSE — dive on it' : 'carrier'}   ·   Mode: ${mode}${this.human.latest?.shiftLock ? '  ·  SIDE SHUFFLE' : ''}${this.timeScale < 1 ? '   SLOW MOTION' : ''}`,
      sup ? `Support ${((d.cfg.support?.strength ?? 1) * 100).toFixed(0)}%  ·  posture ${(sup.posture * 100).toFixed(0)}%  ·  carry ${(sup.carry * 100).toFixed(0)}%${sup.down ? '  ·  DOWN' : ''}`
        : `Balance assist ${(this.settings.assist * 100).toFixed(0)}%${me.assistLevel < 1 ? ` (fading ${(me.assistLevel * 100).toFixed(0)}%)` : ''}`,
    ]);
    this.hud.setSpeed(this.speed, this.speed * MPH);
    this.hud.setControls(this.controlRows().map(([h, k]) => [k, h]),this.kbLocked ? '' : 'Ctrl+W can close the tab here: C also sinks');
    if (this.settings.overlay) {
      const st = w.scene.stats();
      this.hud.setOverlay([
        `FPS        ${this.fps.toFixed(0)}`, `physics    ${this.physMs.toFixed(2)} ms/frame`, `render     ${this.renderer!.lastMs.toFixed(2)} ms/frame`,
        `bodies     ${st.bodies}`, `contacts   ${st.contacts}`, `step rate  ${Math.round(1 / w.dt)} Hz`,
        `assist     ${(this.settings.assist * me.assistLevel * 100).toFixed(0)}%`, `preset     ${this.preset.label}`,
      ]);
    } else this.hud.setOverlay(null);
    if (d.ended && !this.endWhistled) { this.endWhistled = true; this.audio.play('game_whistle_end', 1); }
    if (d.ended && !this.peakShown && w.time - d.endTime > 0.6) {
      this.peakShown = true;
      const imp = w.impact;
      const mine = w.ballCarrier === d.human;
      const result = d.ended === 'time' ? 'Time' : mine ? (d.ended === 'touchdown' ? 'Touchdown!' : 'Tackled')
        : d.ended === 'touchdown' ? 'Missed — touchdown' : imp.firstContactTime < 0 ? 'Carrier fell (no contact)' : 'Tackle — carrier down';
      const fumble = d.recoveredBy === d.human ? 'Fumble recovered by you' : d.recoveredBy >= 0 ? 'Fumble recovered by the carrier' : '';
      const title = fumble ? `${fumble}  ·  ${result}` : result;
      const ms = (v: number) => `${v.toFixed(1)} m/s (${(v * MPH).toFixed(1)} mph)`;
      // impulse over 30 ms, and the mean force it implies; the per-step peak force is a stiff-contact spike
      const J = (h: { impulse: number }) => `${h.impulse.toFixed(0)} N·s in 30 ms (${(h.impulse / 30).toFixed(1)} kN avg)`;
      const big = this.meter.big, best = this.meter.best;
      this.hud.showResult({
        title,
        banner: big ? `BIG HIT  ·  ${ms(big.closing)}  ·  ${J(big)}` : undefined,
        rows: imp.firstContactTime >= 0 ? [
          ['Closing speed', ms(imp.closingSpeed)],
          ['Hardest hit', best ? J(best) : '—'],
          ['Peak head accel (you)', `${imp.peakHeadG[0].toFixed(0)} g`],
          ['Peak head accel (carrier)', `${imp.peakHeadG[1].toFixed(0)} g`],
        ] : [['Contact', 'none']],
        foot: 'Enter / Start: next rep   ·   head acceleration is a 60 Hz-filtered estimate',
      });
    }
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
