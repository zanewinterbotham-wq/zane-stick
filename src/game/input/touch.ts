// Touch controls (phones and tablets only): a stick to move, buttons that press their actions' bound keys, a pads
// slider, and a drag on the field to look. Settings → Controls → Edit touch layout (TOUCH_EDIT) lets the player drag,
// remove (×) and add back controls on the play screen; the layout is saved on this device, Reset restores the defaults.
// Shown only in play (input.capture), inside the safe area (notch, home bar). No explicit pointer capture: a touch is
// captured by the element it started on anyway, and a lost capture would leave a key held.
import { el } from '../ui';
import type { InputManager } from './input';

/** One touch control. A button presses the first bound key of each of its actions together (default: its id;
 *  'fullscreen' is the browser's); `aims`: moving the finger while holding it aims like a field drag. x, y: the default
 *  centre in % of the safe area; `name`: its name in the Add list when the label is a symbol. */
type Control = { id: string; label: string; name?: string; kind: 'button' | 'stick' | 'slider'; actions?: string[]; aims?: boolean; small?: boolean; x: number; y: number; shown: boolean };
/** Every control a player can have; a new control is one row. The bottom-right corner stays clear for the speed meter. */
const CONTROLS: Control[] = [
  { id: 'stick', label: 'Move stick', kind: 'stick', x: 15, y: 66, shown: true },
  { id: 'shiftLock', label: 'Shuffle', kind: 'button', x: 26, y: 87, shown: true },
  { id: 'dive', label: 'Dive', kind: 'button', x: 68.5, y: 39, shown: true },
  { id: 'arms', label: 'Both hands', kind: 'button', actions: ['armL', 'armR'], x: 78, y: 39, shown: true },
  { id: 'thrust', label: 'Thrust', kind: 'button', x: 68.5, y: 61, shown: true },
  { id: 'throw', label: 'Throw', kind: 'button', aims: true, x: 78, y: 61, shown: true },
  { id: 'sprint', label: 'Sprint', kind: 'button', x: 68.5, y: 84, shown: true },
  { id: 'jump', label: 'Jump', kind: 'button', x: 78, y: 84, shown: true },
  { id: 'torso', label: 'Pads slider', kind: 'slider', x: 89.5, y: 43, shown: true },
  { id: 'fullscreen', label: '⛶', name: 'Fullscreen', kind: 'button', small: true, x: 68.5, y: 8.5, shown: true },
  { id: 'reset', label: '↻', name: 'Restart', kind: 'button', small: true, x: 78, y: 8.5, shown: true },
  { id: 'pause', label: 'II', name: 'Pause', kind: 'button', small: true, x: 89.5, y: 8.5, shown: true },
  { id: 'armL', label: 'L arm', kind: 'button', x: 59, y: 39, shown: false },
  { id: 'armR', label: 'R arm', kind: 'button', x: 59, y: 61, shown: false },
  { id: 'slide', label: 'Slide', kind: 'button', x: 59, y: 84, shown: false },
];
/** Window event that starts editing the layout (Settings → Controls). */
export const TOUCH_EDIT = 'zane-stick-touch-edit';
const KEY = 'zane-stick-touch-v2'; // v1 held positions of the old layout only: dropped, they would scatter the new grid
const LOOK = 3; // touch look sensitivity: screen px → mouse px
const STICK = { moveUp: [0, -1], moveDown: [0, 1], moveLeft: [-1, 0], moveRight: [1, 0] } as const;
type Saved = Record<string, { x: number; y: number; shown: boolean }>;

export function touchControls(input: InputManager, view: HTMLElement) {
  if (!matchMedia('(pointer: coarse)').matches) return;
  let saved: Saved = {};
  try {
    localStorage.removeItem('zane-stick-touch-v1');
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (s && typeof s === 'object') saved = s;
  } catch { /* storage unavailable or corrupt: the defaults */ }
  const store = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* not saved */ } };
  const pct = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : d);
  const lay = (c: Control) => { const s = saved[c.id]; return { x: pct(s?.x, c.x), y: pct(s?.y, c.y), shown: typeof s?.shown === 'boolean' ? s.shown : c.shown }; };
  const els: Record<string, HTMLElement> = {};
  const apply = (c: Control) => { const l = lay(c), e = els[c.id]; e.style.left = `${l.x}%`; e.style.top = `${l.y}%`; e.hidden = !l.shown; };
  const set = (c: Control, patch: Partial<Saved[string]>) => { saved[c.id] = { ...lay(c), ...patch }; apply(c); };

  const root = el('div', { class: 'touch', 'aria-hidden': 'true' });
  document.body.append(root);
  let setKnob = (_v: number) => {}; // the pads slider follows the torso when something else moves it (a big hit, a new rep)
  let sliding = false;
  setInterval(() => { const off = !input.capture; if (root.hidden !== off) root.hidden = off; if (!sliding) setKnob(input.torsoAim());
    for (const c of CONTROLS) if (c.kind === 'button') els[c.id].classList.toggle('lit', (c.actions ?? [c.id]).every((a) => input.toggled(a))); }, 100); // menus: no controls

  // a button presses each action's first bound key, as the keyboard would (pause and reset reach the game's key handler too)
  const press = (action: string, down: boolean) => {
    if (action === 'fullscreen') { // hides the browser bars; landscape where the phone allows the lock
      if (down) void document.documentElement.requestFullscreen?.().then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => {});
      return;
    }
    const code = input.bindings.keyboard[action]?.[0];
    if (code) window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
  };

  // edit mode: drag a control to move it, × removes it, the toolbar adds hidden ones back
  let editing = false;
  const bar = el('div', { class: 'tbar', hidden: '' });
  const renderBar = () => {
    const btn = (text: string, fn: () => void) => { const b = el('button', { type: 'button' }, text); b.addEventListener('click', fn); return b; };
    bar.replaceChildren(
      btn('Done', () => setEditing(false)),
      btn('Reset', () => { saved = {}; store(); CONTROLS.forEach(apply); renderBar(); }),
      ...CONTROLS.filter((c) => !lay(c).shown).map((c) => btn(`+ ${c.name ?? c.label}`, () => { set(c, { shown: true }); store(); renderBar(); })));
  };
  const setEditing = (on: boolean) => { editing = on; root.classList.toggle('editing', on); bar.hidden = !on; if (on) renderBar(); };
  window.addEventListener(TOUCH_EDIT, () => setEditing(true));

  for (const c of CONTROLS) {
    const id = c.id, acts = c.actions ?? [id];
    const b = el('div', { class: c.kind === 'stick' ? 'tstick' : c.kind === 'slider' ? 'tslider' : c.small ? 'tbtn small' : 'tbtn', 'data-id': id },
      c.kind === 'button' ? c.label : el('div', { class: 'knob' }));
    const x = el('div', { class: 'tx', text: '×' });
    x.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ev.stopPropagation(); set(c, { shown: false }); store(); renderBar(); });
    b.append(x);
    root.append(b);
    els[id] = b;
    const knob = b.firstChild as HTMLElement;
    const held = new Set<string>(); // the stick's direction keys down now
    let active = false, lx = 0, ly = 0;
    const stick = (ev: PointerEvent | null) => {
      const r = b.getBoundingClientRect(), R = r.width / 2;
      const dx = ev ? Math.max(-1, Math.min(1, (ev.clientX - r.left - R) / R)) : 0, dy = ev ? Math.max(-1, Math.min(1, (ev.clientY - r.top - R) / R)) : 0;
      knob.style.transform = `translate(${dx * R * 0.5}px, ${dy * R * 0.5}px)`;
      for (const [a, [sx, sy]] of Object.entries(STICK)) {
        const on = sx * dx + sy * dy > 0.35;
        if (on !== held.has(a)) { press(a, on); if (on) held.add(a); else held.delete(a); }
      }
    };
    // pads slider: top = pads high (torso up), bottom = low and sunk. The knob's centre stays in [R, H − R] so it never
    // leaves the track, and the finger maps to the torso over that same inner range.
    const inner = () => { const R = knob.offsetHeight / 2; return [R, b.clientHeight - 2 * R] as const; };
    const slide = (ev: PointerEvent) => {
      const [R, L] = inner(), y = ev.clientY - b.getBoundingClientRect().top - b.clientTop;
      if (L > 0) input.setTorso(((y - R) / L) * 2 - 1);
      setKnob(input.torsoAim());
    };
    if (c.kind === 'slider') setKnob = (v) => { const [R, L] = inner(); if (L > 0) knob.style.top = `${R + ((v + 1) / 2) * L}px`; };
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); active = true; b.classList.add('on'); lx = ev.clientX; ly = ev.clientY;
      if (editing) return;
      if (c.kind === 'stick') stick(ev); else if (c.kind === 'slider') { sliding = true; slide(ev); } else for (const a of acts) press(a, true);
    });
    b.addEventListener('pointermove', (ev) => {
      if (!active) return;
      if (editing) { const r = root.getBoundingClientRect(); set(c, { x: (ev.clientX - r.left) / r.width * 100, y: (ev.clientY - r.top) / r.height * 100 }); }
      else if (c.kind === 'stick') stick(ev);
      else if (c.kind === 'slider') slide(ev);
      else if (c.aims) { input.addLook((ev.clientX - lx) * LOOK, (ev.clientY - ly) * LOOK); lx = ev.clientX; ly = ev.clientY; } // aim the throw
    });
    const up = () => {
      if (!active) return;
      active = false; b.classList.remove('on');
      if (editing) { store(); return; }
      if (c.kind === 'stick') stick(null); else if (c.kind === 'slider') sliding = false; else for (const a of acts) press(a, false);
    };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    apply(c);
  }
  root.append(bar, el('div', { class: 'trotate', text: 'Turn your phone sideways to play' }));

  // drag on the field to look (no pointer lock on touch screens); no mouse-button events from the touch either
  let last: { id: number; x: number; y: number } | null = null; // one finger looks; a second one is ignored
  view.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'touch') return;
    ev.preventDefault();
    if (!last) last = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
  });
  view.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== last?.id) return;
    input.addLook((ev.clientX - last.x) * LOOK, (ev.clientY - last.y) * LOOK);
    last = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
  });
  const lift = (ev: PointerEvent) => { if (ev.pointerId === last?.id) last = null; };
  view.addEventListener('pointerup', lift); view.addEventListener('pointercancel', lift);
}
