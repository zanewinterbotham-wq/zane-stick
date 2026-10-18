// Keyboard + gamepad input. Bindings are data (bindings.json). Produces a per-player InputFrame each
// render frame; the HumanBrain turns it into Commands each physics step. Mouse is never required.
import defaults from './bindings.json';

export type Action = keyof typeof defaults.keyboard | 'moveX' | 'moveY' | 'leanX' | 'leanY';
export interface Bindings { keyboard: Record<string, string[]>; gamepad: Record<string, string[]>; options: { contactModeHold: boolean; deadzone: number; sinkRampPerSecond: number } }

/** Analog state of every action for one player this frame (0..1, sticks −1..1). */
export interface InputFrame {
  move: { x: number; y: number };     // stick/keys: x right, y forward
  lean: { x: number; y: number };
  sprint: number; sink: number;
  armL: number; armR: number;
  held: Set<string>;                  // digital actions held this frame
  pressed: Set<string>;               // digital actions that went down this frame
  contactMode: boolean;
  device: 'keyboard' | 'gamepad';
}

const DIGITAL = ['sprint', 'contactMode', 'armL', 'armR', 'gripL', 'gripR', 'wrap', 'shoot', 'sink', 'thrustHips', 'chopFeet', 'headTuck', 'cutLeft', 'cutRight', 'dive', 'reset', 'pause', 'overlay', 'anatomy', 'camera', 'tuning', 'quality', 'leanFwd', 'leanBack', 'leanLeft', 'leanRight', 'moveUp', 'moveDown', 'moveLeft', 'moveRight'];

export class InputManager {
  bindings: Bindings = JSON.parse(JSON.stringify(defaults));
  readonly keys = new Set<string>();
  private keyCodes = new Set<string>();
  private prevHeld: Set<string>[] = [new Set(), new Set()];
  private contact = [false, false];
  private sinkRamp = [0, 0];
  /** While false (menus open), bound keys keep their normal browser behaviour (Tab moves focus, etc.). */
  capture = true;
  /** Which source drives each player: player 0 = keyboard by default, player 1 = first gamepad. */
  assignment: ('keyboard' | number)[] = ['keyboard', 0];

  constructor(target: Window = window) {
    this.rebuildKeySet();
    target.addEventListener('keydown', (e) => {
      if (this.capture && this.keyCodes.has(e.code)) e.preventDefault(); // stop Tab focus moves, Space scrolling, etc.
      this.keys.add(e.code);
    });
    target.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    target.addEventListener('blur', () => this.keys.clear());
  }

  rebuildKeySet() { this.keyCodes = new Set(Object.values(this.bindings.keyboard).flat()); }

  /** Read one player's input. Call once per render frame. */
  read(player: number, dt: number): InputFrame {
    const src = this.assignment[player];
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = typeof src === 'number' ? pads[src] ?? null : null;
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
    this.prevHeld[player] = held;

    const dz = this.bindings.options.deadzone;
    const axis = (name: string) => {
      if (!usePad) return 0;
      const a = this.bindings.gamepad[name]?.[0];
      if (!a) return 0;
      const v = pad!.axes[+a.slice(1)] ?? 0;
      return Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz);
    };
    let move = { x: axis('moveX'), y: -axis('moveY') };
    let lean = { x: axis('leanX'), y: -axis('leanY') };
    if (!usePad) {
      move = { x: val('moveRight') - val('moveLeft'), y: val('moveUp') - val('moveDown') };
      lean = { x: val('leanRight') - val('leanLeft'), y: val('leanFwd') - val('leanBack') };
    }
    // contact mode: toggle on press, or hold
    if (this.bindings.options.contactModeHold) this.contact[player] = held.has('contactMode');
    else if (pressed.has('contactMode')) this.contact[player] = !this.contact[player];
    // sink: trigger depth on a pad; on a keyboard, the longer it is held the lower it goes
    let sink: number;
    if (usePad) sink = val('sink');
    else {
      const rate = this.bindings.options.sinkRampPerSecond;
      this.sinkRamp[player] = held.has('sink') ? Math.min(1, this.sinkRamp[player] + rate * dt) : Math.max(0, this.sinkRamp[player] - 3 * rate * dt);
      sink = this.sinkRamp[player];
    }
    return {
      move, lean, sprint: usePad ? val('sprint') : held.has('sprint') ? 1 : 0, sink,
      armL: val('armL'), armR: val('armR'), held, pressed, contactMode: this.contact[player],
      device: usePad ? 'gamepad' : 'keyboard',
    };
  }

  /** Names of everything currently held on the keyboard and pads, for the key test screen. */
  rawHeld(): string[] {
    const out = [...this.keys];
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p) p.buttons.forEach((b, i) => { if (b.pressed) out.push(`pad${p.index}:b${i}`); });
    return out;
  }
}
