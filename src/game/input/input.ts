// Keyboard, mouse and gamepad input. Bindings are data (bindings.json). Produces a per-player InputFrame each
// render frame; the HumanBrain turns it into Commands each physics step.
import defaults from './bindings.json';

export interface Bindings {
  keyboard: Record<string, string[]>; autoCamera: Record<string, string[]>; gamepad: Record<string, string[]>;
  options: { deadzone: number; sinkRampPerSecond: number; mouseSensitivity: number; padLookRate: number; wheelPerFullTorso: number; torsoRatePerSecond: number };
}

/** Analog state of every action for one player this frame (0..1, sticks −1..1). */
export interface InputFrame {
  move: { x: number; y: number };     // stick/keys: x right, y forward
  /** Camera turn this frame (rad): x = turn right, y = look down. Mouse (pointer locked) or right stick. */
  look: { x: number; y: number };
  /** Torso angle −1 (up) .. 1 (down), set by the wheel or I/K and eased. */
  torso: number;
  sprint: number; sink: number;
  armL: number; armR: number;
  held: Set<string>;                  // digital actions held this frame
  pressed: Set<string>;               // digital actions that went down this frame
  device: 'keyboard' | 'gamepad';
}

const DIGITAL = ['sprint', 'sink', 'thrust', 'dive', 'armL', 'armR', 'torsoUp', 'torsoDown', 'reset', 'pause', 'overlay', 'tuning', 'moveUp', 'moveDown', 'moveLeft', 'moveRight'];

export class InputManager {
  bindings: Bindings = JSON.parse(JSON.stringify(defaults));
  readonly keys = new Set<string>();
  private keyCodes = new Set<string>();
  /** Keys pressed since the last keyboard read: a tap shorter than one frame still counts as a press. */
  private tapped = new Set<string>();
  private prevHeld: Set<string>[] = [new Set(), new Set()];
  private sinkRamp = [0, 0];
  private torsoTarget = [0, 0];
  private torso = [0, 0];
  private mouse = { x: 0, y: 0, wheel: 0 };
  private auto = false;
  /** While false (menus open), bound keys keep their normal browser behaviour (Tab moves focus, etc.). */
  capture = true;
  /** Which source drives each player: player 0 = keyboard and mouse (or the first gamepad once it is used), player 1 = first gamepad. */
  assignment: ('keyboard' | number)[] = ['keyboard', 0];
  /** The device player 0 touched last: a controller takes over when used and hands back on a key or mouse press. */
  private lastDevice: 'keyboard' | 'gamepad' = 'keyboard';

  constructor(target: Window = window) {
    this.rebuildKeySet();
    target.addEventListener('keydown', (e) => {
      // Ctrl is the sink key: also stop Ctrl+D, Ctrl+S, … (Ctrl+W only yields to keyboard lock)
      if (this.capture && (this.keyCodes.has(e.code) || e.ctrlKey)) e.preventDefault();
      if (!e.repeat) this.tapped.add(e.code);
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
    });
    target.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    target.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('mousedown', (e) => {
      if (!this.capture) return;
      e.preventDefault();
      this.tapped.add(`Mouse${e.button}`);
      this.keys.add(`Mouse${e.button}`);
      this.lastDevice = 'keyboard';
    });
    target.addEventListener('mouseup', (e) => this.keys.delete(`Mouse${e.button}`));
    target.addEventListener('contextmenu', (e) => { if (this.capture) e.preventDefault(); });
    target.addEventListener('mousemove', (e) => {
      if (!this.capture || !document.pointerLockElement) return;
      this.mouse.x += e.movementX; this.mouse.y += e.movementY;
    });
    // not passive: Ctrl+wheel would zoom the page
    target.addEventListener('wheel', (e) => {
      if (!this.capture) return;
      e.preventDefault();
      this.mouse.wheel += e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
    }, { passive: false });
  }

  /** Automatic camera: arms and torso move from the mouse to J/L and I/K. Rebinds immediately. */
  get autoCamera() { return this.auto; }
  set autoCamera(on: boolean) {
    this.auto = on;
    this.bindings.keyboard = { ...this.bindings.keyboard, ...(on ? defaults.autoCamera : { armL: defaults.keyboard.armL, armR: defaults.keyboard.armR, torsoUp: [], torsoDown: [] }) };
    this.keys.clear();
    this.rebuildKeySet();
  }

  rebuildKeySet() { this.keyCodes = new Set(Object.values(this.bindings.keyboard).flat()); }

  resetTorso() { this.torso = [0, 0]; this.torsoTarget = [0, 0]; this.mouse.wheel = 0; }

  /** Read one player's input. Call once per render frame. */
  read(player: number, dt: number): InputFrame {
    const src = this.assignment[player];
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad0 = pads[0] ?? null;
    if (src === 'keyboard' && pad0?.connected && (pad0.buttons.some((b) => b.pressed) || pad0.axes.some((a) => Math.abs(a) > 0.5))) this.lastDevice = 'gamepad';
    const pad = typeof src === 'number' ? pads[src] ?? null : this.lastDevice === 'gamepad' ? pad0 : null;
    const usePad = pad !== null && pad.connected;
    const held = new Set<string>();
    const val = (action: string): number => {
      if (usePad) {
        let v = 0;
        for (const b of this.bindings.gamepad[action] ?? []) {
          if (b[0] === 'b') { const btn = pad!.buttons[+b.slice(1)]; if (btn) v = Math.max(v, btn.value ?? (btn.pressed ? 1 : 0)); }
        }
        return v;
      }
      return (this.bindings.keyboard[action] ?? []).some((k) => this.keys.has(k)) ? 1 : 0;
    };
    for (const a of DIGITAL) if (val(a) > 0.5) held.add(a);
    const prev = this.prevHeld[player];
    const pressed = new Set([...held].filter((a) => !prev.has(a)));
    if (!usePad) {
      for (const a of DIGITAL) if ((this.bindings.keyboard[a] ?? []).some((k) => this.tapped.has(k))) pressed.add(a);
      this.tapped.clear();
    }
    this.prevHeld[player] = held;

    const o = this.bindings.options, dz = o.deadzone;
    const axis = (name: string) => {
      if (!usePad) return 0;
      const a = this.bindings.gamepad[name]?.[0];
      if (!a) return 0;
      const v = pad!.axes[+a.slice(1)] ?? 0;
      return Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz);
    };
    let move = { x: axis('moveX'), y: -axis('moveY') };
    let look = { x: axis('lookX') * o.padLookRate * dt, y: axis('lookY') * o.padLookRate * dt };
    let torsoStep = (val('torsoDown') - val('torsoUp')) * o.torsoRatePerSecond * dt;
    if (!usePad) {
      move = { x: val('moveRight') - val('moveLeft'), y: val('moveUp') - val('moveDown') };
      look = this.auto ? { x: 0, y: 0 } : { x: this.mouse.x * o.mouseSensitivity, y: this.mouse.y * o.mouseSensitivity };
      if (!this.auto) torsoStep += this.mouse.wheel / o.wheelPerFullTorso;
    }
    this.mouse.x = this.mouse.y = this.mouse.wheel = 0;
    // torso: an accumulated angle, eased so a wheel notch does not jerk the trunk
    this.torsoTarget[player] = Math.max(-1, Math.min(1, this.torsoTarget[player] + torsoStep));
    this.torso[player] += (this.torsoTarget[player] - this.torso[player]) * Math.min(1, dt / 0.12);
    // sink: trigger depth on a pad; on a keyboard, the longer it is held the lower it goes
    let sink: number;
    if (usePad) sink = val('sink');
    else {
      this.sinkRamp[player] = held.has('sink') ? Math.min(1, this.sinkRamp[player] + o.sinkRampPerSecond * dt) : Math.max(0, this.sinkRamp[player] - 3 * o.sinkRampPerSecond * dt);
      sink = this.sinkRamp[player];
    }
    return {
      move, look, torso: this.torso[player], sprint: usePad ? val('sprint') : held.has('sprint') ? 1 : 0, sink,
      armL: val('armL'), armR: val('armR'), held, pressed,
      device: usePad ? 'gamepad' : 'keyboard',
    };
  }

  /** Names of everything currently held on the keyboard, mouse and pads, for the key test screen. */
  rawHeld(): string[] {
    const out = [...this.keys];
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p) p.buttons.forEach((b, i) => { if (b.pressed) out.push(`pad${p.index}:b${i}`); });
    return out;
  }
}
