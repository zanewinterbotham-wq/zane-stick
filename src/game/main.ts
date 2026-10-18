// Browser entry: title menu, open-field drill, HUD, pause menu, panels. The simulation runs on a fixed
// timestep; slow motion only changes how fast real time feeds the fixed steps.
import { DEFAULT_SUPPORT, type SupportSettings } from '../sim/anim/types';
import { HumanBrain } from '../sim/brains/human';
import { DIFFICULTY } from '../sim/brains/carrier';
import { DEFAULT_GAINS } from '../sim/control/hand';
import { DEFAULT_OPEN_FIELD, OpenFieldDrill } from '../sim/drills/openField';
import { headingOf, qrot } from '../sim/math';
import { mujocoEngine } from '../sim/physics/mujoco';
import { pushScenario, runScenario, standScenario, type Scenario } from '../sim/scenarios';
import { World, type PhysicsSettings } from '../sim/world';
import { Audio } from './audio';
import { chooseBest, reportText, runBenchmark } from './benchmark';
import { ChaseCamera } from './camera';
import { HitMeter, hitFeel, MPH } from './feel';
import { InputManager, type InputFrame } from './input/input';
import { PRESETS, type PresetName } from './presets';
import { GameRenderer, RENDER_PRESETS } from './render/renderer';
import { loadSettings, saveSettings, type Settings } from './settings';
import { el, Hud, Layer, menu, moveFocus } from './ui';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;

// ------------------------------------------------------------------ dev scenarios (?scenario=…)
async function devScenario(name: string) {
  const physics: PhysicsSettings = { hz: +(params.get('hz') ?? 240), iterations: 30, detail: (params.get('detail') as PhysicsSettings['detail']) ?? 'standard' };
  const assist = +(params.get('assist') ?? 0);
  const sc: Scenario = name === 'push' ? pushScenario(physics, +(params.get('dir') ?? 0), +(params.get('imp') ?? 60), assist)
    : name === 'walk' || name === 'jog' || name === 'sprint' ? runScenario(physics, name, { assist })
    : name === 'cut' ? runScenario(physics, 'jog', { assist, cutAt: 3 }) : standScenario(physics, assist);
  const world = await World.create(mujocoEngine, sc.setup);
  const r = new GameRenderer(canvas, RENDER_PRESETS[(params.get('gfx') as 'minimum' | 'high') ?? 'high']);
  r.setWorld(world);
  r.setXray(params.get('xray') === '1');
  const cam = new ChaseCamera();
  cam.mode = (params.get('cam') as ChaseCamera['mode']) ?? 'chase';
  const heading = () => { const q = world.scene.athletes[0].state.segQuat; return headingOf(qrot([q[0], q[1], q[2], q[3]], [0, 0, 1])); };
  cam.snap(r.camera, world, heading());
  document.getElementById('loading')?.remove();
  const stepOnce = () => { sc.onStep?.(world); world.step(); };
  (window as unknown as { __zs: unknown }).__zs = {
    world,
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
  speed = 0;         // smoothed human ground speed for the speedometer and FOV kick, m/s
  acc = 0;
  last = performance.now();
  fps = 0; physMs = 0;
  rep = 0;
  peakShown = false;
  startHeld = 0;
  pausedAt = 0;
  /** Keyboard lock is active (fullscreen): Ctrl+W reaches the game instead of closing the tab. */
  kbLocked = false;
  private padPrev: boolean[] = [];

  async boot() {
    this.input.capture = false;
    this.cam.mode = this.settings.camera;
    this.cam.follow = this.input.autoCamera = this.settings.autoCamera;
    this.audio.muted = this.settings.mute;
    canvas.addEventListener('click', () => { if (!this.paused) this.lockPointer(); });
    document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) this.lostFocus(); });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { this.kbLocked = false; this.lostFocus(); } });
    window.addEventListener('resize', () => this.renderer?.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: false });
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
    this.hud.setVisible(false);
    this.hud.showResult(null);
    this.input.capture = false;
    document.exitPointerLock?.();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.layer.show(menu('ZANE STICK', [
      { label: 'Open field: tackle the carrier', hint: 'Enter / A', action: () => this.startDrill() },
      { label: 'Controls', action: () => this.controls() },
      { label: 'Key test', action: () => this.keyTest() },
      { label: `Quality: ${this.preset.label}`, hint: 'next rep', action: () => { this.cyclePreset(); this.title(); } },
      { label: 'Benchmark', action: () => this.benchmark() },
    ], 'Physics football. Every movement is muscles on a simulated body.'));
  }

  async startDrill() {
    this.layer.hide();
    this.enterPlay();
    this.audio.unlock();
    this.hud.setVisible(true);
    this.input.capture = true;
    await this.newRep();
    this.paused = false;
  }

  async newRep() {
    this.drill?.destroy();
    this.hud.showResult(null);
    this.peakShown = false;
    this.input.resetTorso();
    const p = this.preset;
    const s = this.settings;
    this.drill = await OpenFieldDrill.create(mujocoEngine, {
      ...DEFAULT_OPEN_FIELD, physics: p.physics, assist: s.assist, seed: 1, difficulty: DIFFICULTY.normal,
      human: { ...DEFAULT_OPEN_FIELD.human, strength: s.strength, speed: s.speed }, traction: s.traction, gains: s.gains,
      support: { ...DEFAULT_SUPPORT, ...s.support },
    }, this.human, this.rep++);
    if (!this.renderer || this.rendererPreset !== p.name) {
      this.renderer?.renderer.dispose();
      this.renderer = new GameRenderer(canvas, p.render);
      this.rendererPreset = p.name;
    }
    this.renderer.setWorld(this.drill.world);
    this.renderer.setXray(this.renderer.xray);
    this.renderer.effortShading = s.effortShading;
    this.cam.snap(this.renderer.camera, this.drill.world, this.humanHeading());
    this.acc = 0;
  }

  pauseMenu() {
    this.paused = true;
    this.pausedAt = performance.now();
    this.input.capture = false;
    document.exitPointerLock?.();
    const s = this.settings;
    this.layer.show(menu('Paused', [
      { label: 'Resume', hint: 'Esc / Start', action: () => this.resume() },
      { label: 'Reset rep', hint: 'Enter', action: () => { this.resume(); void this.newRep(); } },
      { label: `Quality: ${this.preset.label}`, hint: 'next rep', action: () => { this.cyclePreset(); this.pauseMenu(); } },
      { label: `Anatomy view: ${this.renderer?.xray ? 'on' : 'off'}`, action: () => { this.renderer?.setXray(!this.renderer.xray); this.pauseMenu(); } },
      { label: `Effort shading (anatomy view): ${s.effortShading ? 'on' : 'off'}`, action: () => { s.effortShading = !s.effortShading; if (this.renderer) this.renderer.effortShading = s.effortShading; this.save(); this.pauseMenu(); } },
      { label: `Big-hit slow motion: ${s.slowMo ? 'on' : 'off'}`, action: () => { s.slowMo = !s.slowMo; this.save(); this.pauseMenu(); } },
      { label: `Camera: ${this.cam.mode}`, action: () => { this.toggleCamera(); this.pauseMenu(); } },
      { label: `Automatic camera: ${s.autoCamera ? 'on (arms J / L, torso I / K)' : 'off (mouse look)'}`, action: () => { this.setAutoCamera(!s.autoCamera); this.pauseMenu(); } },
      { label: `Sound: ${s.mute ? 'off' : 'on'}`, action: () => { s.mute = !s.mute; this.audio.muted = s.mute; this.save(); this.pauseMenu(); } },
      { label: 'Tuning panel', hint: 'T', action: () => this.tuning() },
      { label: 'Controls', action: () => this.controls(() => this.pauseMenu()) },
      { label: 'Key test', action: () => this.keyTest(() => this.pauseMenu()) },
      { label: 'Quit to title', action: () => { this.drill?.destroy(); this.drill = null; this.title(); } },
    ]));
  }

  resume() { this.layer.hide(); this.input.capture = true; this.paused = false; this.last = performance.now(); this.enterPlay(); }

  /** Playing: pointer lock for mouse look, and fullscreen with keyboard lock so Ctrl+W (sink + forward) cannot
   *  close the tab. Each can be refused (no user gesture, headless, unsupported); the game works without them. */
  enterPlay() {
    this.lockPointer();
    const kb = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard;
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    document.documentElement.requestFullscreen()
      .then(() => { this.lockPointer(); return kb?.lock ? kb.lock().then(() => { this.kbLocked = !!document.fullscreenElement; }) : undefined; })
      .catch(() => {});
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

  /** Gameplay controls: HUD label, controls-screen action, keyboard and mouse, controller. */
  controlRows(): [string, string, string, string][] {
    const auto = this.settings.autoCamera;
    return [
      ['Move', 'Move (relative to the camera)', 'W A S D', 'Left stick'],
      ['Sprint', 'Sprint (drives the legs in contact)', 'Shift', 'RT'],
      ['Sink', 'Sink the hips (hold longer = lower)', this.kbLocked ? 'Ctrl' : 'Ctrl / C', 'LT (depth)'],
      ['Thrust', 'Thrust the hips (overrides sink and torso)', 'Space', 'A'],
      ['Dive', 'Dive forward (one press: launch, fly, land)', 'E', 'B'],
      ['Left arm, grab', 'Raise the left arm toward the aim; grabs what it touches until released', auto ? 'J' : 'Left click', 'LB'],
      ['Right arm, grab', 'Raise the right arm toward the aim; grabs what it touches until released', auto ? 'L' : 'Right click', 'RB'],
      ['Torso up / down', 'Angle the torso up / down', auto ? 'I / K' : 'Scroll', 'D-pad up / down'],
      ...(auto ? [] : [['Look', 'Camera (aims the arms)', 'Mouse', 'Right stick'] as [string, string, string, string]]),
    ];
  }

  controls(back = () => this.title()) {
    const table = (head: string[], rows: string[][]) => el('table', { class: 'controls' }, el('tr', {}, ...head.map((h) => el('th', { text: h }))),
      ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', { text: c })))));
    const play = table(['Action', this.settings.autoCamera ? 'Keyboard' : 'Keyboard and mouse', 'Controller'], this.controlRows().map(([, a, k, g]) => [a, k, g]));
    const meta = table(['Game', 'Keyboard', 'Controller'], [
      ['Reset rep', 'Enter', 'Start (tap)'], ['Pause', 'Esc', 'Start (hold)'], ['Tuning panel', 'T', 'menu'], ['Performance overlay', '`', 'menu'],
      ['Anatomy view, camera view, quality, automatic camera', 'pause menu', 'pause menu'],
    ]);
    const box = el('div', { class: 'panel menu wide' }, el('h1', { text: 'Controls' }),
      el('p', { class: 'sub', text: 'Contact mode is automatic: within about 4 m of the ball carrier your athlete settles into a ready stance with the arms up. No control is needed for balance; once you make contact, physics decides who stays up.' }),
      play, el('p', { class: 'sub' }), meta);
    const b = el('button', { class: 'item', type: 'button' }, 'Back');
    b.addEventListener('click', back);
    box.append(el('p', { class: 'sub', text: this.settings.autoCamera ? 'Automatic camera is on: no mouse is needed.' : 'Click the field to capture the mouse; Esc frees it and pauses. Ctrl+W can close the tab unless the browser grants keyboard lock in fullscreen, so C also sinks.' }), b);
    this.layer.show(box);
  }

  keyTest(back = () => this.title()) {
    const box = el('div', { class: 'panel menu wide' }, el('h1', { text: 'Key test' }), el('p', { class: 'sub', text: 'Hold keys or buttons. Everything that registers shows below, so you can see which combinations your keyboard drops.' }));
    const keys = el('div', { class: 'keys' });
    const acts = el('p', { class: 'sub mono' });
    const b = el('button', { class: 'item', type: 'button' }, 'Back (Esc)');
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

  tuning() {
    const s = this.settings;
    const gainKeys: (keyof typeof DEFAULT_GAINS)[] = ['torsoKp', 'torsoKd', 'footK', 'stepWidth', 'swingWn', 'stanceKnee', 'stanceHip', 'dcmK', 'heightKp', 'heightKd', 'spine'];
    const grid = el('div', { class: 'grid2' });
    const row = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, fmt = (v: number) => v.toFixed(3)) => {
      const out = el('span', { class: 'mono', text: fmt(value) });
      const r = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
      r.addEventListener('input', () => { const v = +r.value; out.textContent = fmt(v); set(v); this.save(); });
      grid.append(el('label', { text: label }), r, out);
    };
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
    const update = () => (exp.value = JSON.stringify({ support: sup, speed: s.speed, strength: s.strength, assist: s.assist, traction: s.traction, gains: { ...DEFAULT_GAINS, ...s.gains } }, null, 2));
    update();
    grid.addEventListener('input', update);
    const copy = el('button', { class: 'item', type: 'button' }, 'Copy values');
    copy.addEventListener('click', () => { void navigator.clipboard?.writeText(exp.value).then(() => this.hud.flash('Copied'), () => { exp.select(); }); });
    const reset = el('button', { class: 'item', type: 'button' }, 'Reset to defaults');
    reset.addEventListener('click', () => { s.gains = {}; s.assist = 0.2; s.strength = 1; s.speed = 1; s.traction = 1.2; s.support = { ...DEFAULT_SUPPORT }; this.save(); this.tuning(); });
    const back = el('button', { class: 'item', type: 'button' }, 'Back');
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
    const copy = el('button', { class: 'item', type: 'button' }, 'Copy results');
    copy.addEventListener('click', () => { void navigator.clipboard?.writeText(out.value).then(() => this.hud.flash('Copied'), () => out.select()); });
    const use = el('button', { class: 'item', type: 'button' }, `Use recommended preset (${PRESETS[chooseBest(rs)].label})`);
    use.addEventListener('click', () => { this.settings.preset = chooseBest(rs); this.save(); this.title(); });
    const back = el('button', { class: 'item', type: 'button' }, 'Back');
    back.addEventListener('click', () => this.title());
    box.append(copy, use, back);
    copy.focus();
  }

  cyclePreset() { this.settings.preset = this.settings.preset === 'high' ? 'minimum' : 'high'; this.save(); this.hud.flash(`Quality: ${this.preset.label} (next rep)`); }
  toggleCamera() { this.cam.mode = this.cam.mode === 'chase' ? 'helmet' : 'chase'; this.settings.camera = this.cam.mode as Settings['camera']; this.save(); }
  save() { saveSettings(this.settings); }

  // ---------------------------------------------------------------- input
  onKey(e: KeyboardEvent) {
    this.audio.unlock();
    if (this.layer.open) {
      if (e.code === 'ArrowDown') { moveFocus(this.layer.root, 1); e.preventDefault(); }
      else if (e.code === 'ArrowUp') { moveFocus(this.layer.root, -1); e.preventDefault(); }
      // the Esc that released the pointer can also arrive as a key press: it must not resume at once
      else if (e.code === 'Escape' && this.drill && performance.now() - this.pausedAt > 300) this.resume();
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
      if (edge(13)) moveFocus(this.layer.root, 1);
      if (edge(12)) moveFocus(this.layer.root, -1);
      if (edge(0)) (document.activeElement as HTMLElement | null)?.click();
      if (edge(1) && this.drill) this.resume();
    } else if (this.drill) {
      if (down(9)) { this.startHeld += dt; if (this.startHeld > 0.6 && this.startHeld - dt <= 0.6) this.pauseMenu(); }
      else { if (this.startHeld > 0 && this.startHeld < 0.6) void this.newRep(); this.startHeld = 0; }
    }
    this.padPrev = p.buttons.map((b) => b.pressed);
  }

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
        this.human.latest = { move: f.move, torso: f.torso, sprint: f.sprint, sink: f.sink, armL: f.armL, armR: f.armR, held: f.held, cameraYaw: this.cam.yaw, aimPitch: this.cam.aimPitch };
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
    const w = this.drill!.world;
    if (this.meterWorld !== w) { this.meter = new HitMeter(); this.meterWorld = w; }
    const { sounds, bigNow } = this.meter.step(w);
    for (const s of sounds) this.audio.hit(s);
    const loud = sounds[0]?.loud ?? 0;
    const pad = navigator.getGamepads?.()[0] as (Gamepad & { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } }) | null;
    const rumble = (r: { duration: number; strong: number; weak: number }) => pad?.vibrationActuator?.playEffect('dual-rumble', { duration: r.duration, strongMagnitude: r.strong, weakMagnitude: r.weak }).catch(() => {});
    if (!bigNow) {
      if (loud > 0.1) { this.cam.addShake(0.04 * loud * loud); rumble({ duration: 60, strong: 0.3 * loud, weak: 0.5 * loud }); }
      return false;
    }
    const fx = hitFeel(bigNow.impulse, bigNow.closing);
    this.cam.addShake(fx.shake);
    rumble(fx.rumble);
    this.hud.flash('BIG HIT');
    if (fx.slowMo && this.settings.slowMo && now / 1000 > this.slowUntil) { this.timeScale = 0.3; this.slowUntil = now / 1000 + 0.9; }
    const a = w.scene.athletes[0].state.com, b = w.scene.athletes[1].state.com;
    this.cam.punch(b[0] - a[0], b[2] - a[2], fx.punch);
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
      `OPEN FIELD  ·  Rep ${d.rep + 1}  ·  ${Math.min(d.repTime, d.cfg.timeLimit).toFixed(1)} s`,
      `Mode: ${mode}${this.timeScale < 1 ? '   SLOW MOTION' : ''}`,
      sup ? `Support ${((d.cfg.support?.strength ?? 1) * 100).toFixed(0)}%  ·  posture ${(sup.posture * 100).toFixed(0)}%  ·  carry ${(sup.carry * 100).toFixed(0)}%${sup.down ? '  ·  DOWN' : ''}`
        : `Balance assist ${(this.settings.assist * 100).toFixed(0)}%${me.assistLevel < 1 ? ` (fading ${(me.assistLevel * 100).toFixed(0)}%)` : ''}`,
    ]);
    this.hud.setSpeed(this.speed, this.speed * MPH);
    this.hud.setControls(this.controlRows().map(([h, , k]) => [k, h]), this.kbLocked ? '' : 'Ctrl+W can close the tab here: C also sinks');
    if (this.settings.overlay) {
      const st = w.scene.stats();
      this.hud.setOverlay([
        `FPS        ${this.fps.toFixed(0)}`, `physics    ${this.physMs.toFixed(2)} ms/frame`, `render     ${this.renderer!.lastMs.toFixed(2)} ms/frame`,
        `bodies     ${st.bodies}`, `contacts   ${st.contacts}`, `step rate  ${Math.round(1 / w.dt)} Hz`,
        `assist     ${(this.settings.assist * me.assistLevel * 100).toFixed(0)}%`, `preset     ${this.preset.label}`,
      ]);
    } else this.hud.setOverlay(null);
    if (d.ended && !this.peakShown && w.time - d.endTime > 0.6) {
      this.peakShown = true;
      const imp = w.impact;
      const title = d.ended === 'down' && imp.firstContactTime < 0 ? 'Carrier fell (no contact)' : d.ended === 'down' ? 'Tackle — carrier down' : d.ended === 'touchdown' ? 'Missed — touchdown' : d.ended === 'out of bounds' ? 'Pushed out of bounds' : 'Time';
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
    const rs = await runBenchmark(canvas);
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
