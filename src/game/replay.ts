// Instant replay (C) and photo mode (P). Render only: the sim never sees any of this.
// Replay keeps the last REPLAY_SECONDS of what was drawn (every athlete's segment poses and the props, sampled at
// REPLAY_HZ of game time, float32) in a ring buffer, and plays it back from REPLAY_BACK seconds before with a ghost
// camera the player flies. Photo mode freezes the live pose and flies the same camera. The game is paused meanwhile.
// Both are single player only (a shared multiplayer play cannot pause for one player).
import type * as THREE from 'three';
import type { World } from '../sim/world';
import { FreeCamera } from './camera';
import type { InputManager } from './input/input';
import { lerpPose, type GameRenderer } from './render/renderer';
import { el } from './ui';

export const REPLAY_SECONDS = 15, REPLAY_HZ = 60, REPLAY_BACK = 8;
/** Playback speeds on the 1 / 2 / 3 keys. */
export const SPEEDS = [0.25, 0.5, 1];

export interface ReplayFrame { t: number; pos: Float32Array; quat: Float32Array; props: Float32Array }

/** Ring buffer of frames, oldest first, at most one per 1/hz of time. */
export class ReplayBuffer {
  private frames: ReplayFrame[] = [];
  private head = 0;
  private n = 0;
  readonly cap: number;
  constructor(readonly seconds = REPLAY_SECONDS, readonly hz = REPLAY_HZ) { this.cap = Math.ceil(seconds * hz); }
  get length() { return this.n; }
  get start() { return this.n ? this.at(0).t : 0; }
  get end() { return this.n ? this.at(this.n - 1).t : 0; }
  clear() { this.n = this.head = 0; }
  /** Frame i, 0 = oldest. */
  at(i: number): ReplayFrame { return this.frames[(this.head + i) % this.cap]; }
  /** Record a frame (arrays concatenated in order); skipped when less than 1/hz after the last one (or time stood
   *  still: paused). Slots are reused once full. Returns whether it was kept. */
  push(t: number, pos: ArrayLike<number>[], quat: ArrayLike<number>[], props: ArrayLike<number>): boolean {
    if (this.n && t - this.end < 1 / this.hz - 1e-9) return false;
    const i = (this.head + this.n) % this.cap;
    if (this.n < this.cap) this.n++; else this.head = (this.head + 1) % this.cap;
    const size = (a: ArrayLike<number>[]) => a.reduce((s, x) => s + x.length, 0);
    let f = this.frames[i];
    if (!f || f.pos.length !== size(pos) || f.quat.length !== size(quat) || f.props.length !== props.length) {
      f = this.frames[i] = { t, pos: new Float32Array(size(pos)), quat: new Float32Array(size(quat)), props: new Float32Array(props.length) };
    }
    f.t = t;
    let o = 0;
    for (const a of pos) { f.pos.set(a, o); o += a.length; }
    o = 0;
    for (const a of quat) { f.quat.set(a, o); o += a.length; }
    f.props.set(props);
    return true;
  }
  /** The frames around time t: at(i).t <= t <= at(i + 1).t, alpha the way between (clamped to the ends). */
  locate(t: number): { i: number; alpha: number } {
    if (this.n < 2 || t <= this.start) return { i: 0, alpha: 0 };
    if (t >= this.end) return { i: this.n - 2, alpha: 1 };
    let lo = 0, hi = this.n - 1; // at(lo).t <= t < at(hi).t
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.at(m).t <= t) lo = m; else hi = m; }
    const a = this.at(lo).t, b = this.at(hi).t;
    return { i: lo, alpha: (t - a) / (b - a) };
  }
}

/** The playback cursor over a buffer: time, speed, pause. Starts REPLAY_BACK s before the end; holds at the end. */
export class Playback {
  t: number;
  speed = 1;
  paused = false;
  constructor(readonly buf: ReplayBuffer, readonly back = REPLAY_BACK) { this.t = this.from; }
  /** Where playback (re)starts. */
  get from() { return Math.max(this.buf.start, this.buf.end - this.back); }
  step(dt: number) {
    if (this.paused) return;
    this.t = Math.min(this.buf.end, this.t + dt * this.speed);
    if (this.t >= this.buf.end) this.paused = true;
  }
  /** Space: pause / play; play at the end starts over. */
  toggle() {
    if (this.paused && this.t >= this.buf.end) this.t = this.from;
    this.paused = !this.paused;
  }
  scrub(ds: number) { this.t = Math.max(this.buf.start, Math.min(this.buf.end, this.t + ds)); }
}

type Pose = { segPos: Float64Array; segQuat: Float64Array };
type Kind = 'replay' | 'photo';
/** Keys of the viewer's own controls (not rebindable; the move keys follow the player's bindings). */
const UP = ['KeyE', 'PageUp'], DOWN = ['KeyQ', 'PageDown'], FAST = ['ShiftLeft', 'ShiftRight'];

/** The replay / photo viewer the App drives: records every live frame, then while open draws the frame itself. */
export class Viewer {
  readonly buf = new ReplayBuffer();
  kind: Kind | null = null;
  private play: Playback | null = null;
  private cam = new FreeCamera();
  private recWorld: World | null = null;
  private props = new Float64Array(0);
  private out: Pose[] = [];
  private drag = false;
  private saveNext = false;
  private onExit = () => {};
  private box = el('div', { class: 'panel mono', role: 'dialog', 'aria-label': 'Replay', style: 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:calc(100vw - 32px);display:none;z-index:5;text-align:center' });
  private line = el('div');
  private bar = el('i', { style: 'display:block;height:100%;background:currentColor;width:0' });
  private track = el('div', { style: 'height:4px;margin:6px 0;background:rgba(127,127,127,.35)' }, this.bar);
  private hints = el('div', { style: 'opacity:.75;font-size:.85em' });
  private save = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Save picture');

  constructor(private canvas: HTMLCanvasElement, private hud: HTMLElement) {
    this.box.append(this.line, this.track, this.hints, this.save);
    document.body.append(this.box);
    this.save.addEventListener('click', () => { this.saveNext = true; this.save.blur(); });
    // drag on the view to look around (the cursor stays free for the Save button)
    canvas.addEventListener('mousedown', () => { if (this.kind) this.drag = true; });
    window.addEventListener('mouseup', () => { this.drag = false; });
    window.addEventListener('mousemove', (e) => { if (this.kind && this.drag) this.cam.look(e.movementX * 0.0025, e.movementY * 0.0025); });
    window.addEventListener('wheel', (e) => { if (this.kind) this.cam.wheel(e.deltaY * (e.deltaMode === 1 ? 40 : 1)); }, { passive: true });
  }

  get open() { return this.kind !== null; }

  /** Keep this live frame (call once a frame after the renderer's lerp). A new rep starts a new recording. */
  record(w: World, poses: readonly Pose[]) {
    if (this.kind) return;
    if (w !== this.recWorld) { this.buf.clear(); this.recWorld = w; this.out = []; }
    const np = w.setup.props?.length ?? 0;
    if (this.props.length !== 7 * np) this.props = new Float64Array(7 * np);
    for (let i = 0; i < np; i++) { const { pos, quat } = w.scene.propPose(i); this.props.set(pos, 7 * i); this.props.set(quat, 7 * i + 3); }
    this.buf.push(w.time, poses.map((p) => p.segPos), poses.map((p) => p.segQuat), this.props);
  }

  /** Open from the view `cam` shows now; false when there is nothing to replay yet. */
  start(kind: Kind, cam: THREE.Camera, onExit: () => void): boolean {
    if (kind === 'replay' && this.buf.length < 2) return false;
    this.kind = kind; this.onExit = onExit;
    this.play = kind === 'replay' ? new Playback(this.buf) : null;
    this.cam.from(cam);
    this.hud.style.display = 'none';
    this.save.style.display = kind === 'photo' ? '' : 'none';
    this.track.style.display = kind === 'replay' ? '' : 'none';
    this.box.setAttribute('aria-label', kind === 'replay' ? 'Instant replay' : 'Photo mode');
    this.box.style.display = '';
    return true;
  }

  close() {
    this.kind = null; this.play = null; this.drag = false;
    this.box.style.display = 'none';
    this.hud.style.display = '';
  }

  /** A key while open (window keydown). `open`: the key that opened this mode (it closes it too). */
  key(e: KeyboardEvent, open: string[]) {
    const p = this.play, c = e.code;
    if (c.startsWith('Arrow') || c === 'Space' || /^Digit[123]$/.test(c) || c === 'Enter') e.preventDefault();
    if (p && c === 'ArrowLeft') p.scrub(-0.25);
    else if (p && c === 'ArrowRight') p.scrub(0.25);
    if (e.repeat) return;
    if (c === 'Escape' || open.includes(c)) this.onExit();
    else if (p && c === 'Space') p.toggle();
    else if (p && /^Digit[123]$/.test(c)) p.speed = SPEEDS[+c[5] - 1];
    else if (this.kind === 'photo' && c === 'Enter') this.saveNext = true;
  }

  /** Draw this frame while open (camera, poses, render); false when closed (the App draws the live game). */
  frame(r: GameRenderer, w: World, dt: number, input: InputManager, focus: number): boolean {
    if (!this.kind) return false;
    const k = input.bindings.keyboard, held = (codes: string[] = []) => (codes.some((c) => input.keys.has(c)) ? 1 : 0);
    this.cam.update(r.camera, held(k.moveRight) - held(k.moveLeft), held(k.moveUp) - held(k.moveDown), held(UP) - held(DOWN), dt, !!held(FAST));
    r.hideHeadOf = -1;
    const p = this.play;
    if (p && w === this.recWorld) {
      p.step(dt);
      const { i, alpha } = this.buf.locate(p.t), a = this.buf.at(i), b = this.buf.at(Math.min(i + 1, this.buf.length - 1));
      let po = 0, qo = 0;
      w.scene.athletes.forEach((at, j) => {
        const np = at.state.segPos.length, nq = at.state.segQuat.length;
        let o = this.out[j];
        if (!o || o.segPos.length !== np) o = this.out[j] = { segPos: new Float64Array(np), segQuat: new Float64Array(nq) };
        lerpPose(a.pos.subarray(po, po + np), a.quat.subarray(qo, qo + nq), b.pos.subarray(po, po + np), b.quat.subarray(qo, qo + nq), alpha, o.segPos, o.segQuat);
        r.poses[j] = o;
        po += np; qo += nq;
      });
      const pp = new Float64Array(a.props.length);
      for (let j = 0; j < pp.length; j++) pp[j] = a.props[j] + (b.props[j] - a.props[j]) * alpha; // shortcut: ball quaternion lerped without renormalising, fine at 60 Hz
      // the renderer reads props from the scene: show the recorded ones for this one draw
      const sc = w.scene, real = sc.propPose;
      sc.propPose = (n: number) => ({ pos: [pp[7 * n], pp[7 * n + 1], pp[7 * n + 2]], quat: [pp[7 * n + 3], pp[7 * n + 4], pp[7 * n + 5], pp[7 * n + 6]] });
      try { r.render(w, focus); } finally { sc.propPose = real; }
      const len = this.buf.end - this.buf.start || 1;
      this.bar.style.width = `${(100 * (p.t - this.buf.start) / len).toFixed(1)}%`;
      this.text(`REPLAY  ·  ${(p.t - this.buf.end).toFixed(1)} s  ·  ${p.speed}×${p.paused ? '  ·  PAUSED' : ''}`,
        'Drag: look  ·  WASD: fly  ·  E / Q: up / down  ·  Shift: fast  ·  Scroll: fly speed  ·  Space: pause  ·  ← / →: scrub  ·  1 / 2 / 3: ¼ ½ 1× speed  ·  C / Esc: back');
    } else {
      r.render(w, focus);
      this.text('PHOTO MODE', 'Drag: look  ·  WASD: fly  ·  E / Q: up / down  ·  Shift: fast  ·  Scroll: fly speed  ·  Enter: save picture  ·  P / Esc: back');
    }
    if (this.saveNext) { // right after the draw: a WebGL canvas is only readable in the task that drew it
      this.saveNext = false;
      const a = el('a', { href: this.canvas.toDataURL('image/png'), download: `zane-stick-${Date.now()}.png` });
      a.click();
    }
    return true;
  }

  private text(line: string, hints: string) {
    if (this.line.textContent !== line) this.line.textContent = line;
    if (this.hints.textContent !== hints) this.hints.textContent = hints;
  }
}
