// Touch controls (phones and tablets only): a stick to move, buttons that press each action's bound key, and a drag
// on the field to look. ✎ lets the player drag every control to a new place (saved on this device; Reset puts them back).
// Shown only in play (input.capture), inside the safe area (notch, home bar). No explicit pointer capture: a touch is
// captured by the element it started on anyway, and a lost capture would leave a key held.
import { el } from '../ui';
import type { InputManager } from './input';

/** [action, label, x %, y %]: the default spot of each control's centre. 'stick' is the move stick. */
const CONTROLS: [string, string, number, number][] = [
  ['stick', '', 14, 72],   // the bottom-right corner stays clear for the speed meter
  ['armL', 'L arm', 66, 86], ['sprint', 'Sprint', 77, 86],
  ['armR', 'R arm', 66, 68], ['thrust', 'Thrust', 77, 68], ['jump', 'Jump', 88, 64],
  ['shiftLock', 'Shuffle', 66, 50], ['throw', 'Throw', 77, 50], ['dive', 'Dive', 88, 44],
  ['torsoUp', 'Pads ▲', 66, 30], ['torsoDown', 'Pads ▼', 77, 30],
  ['pause', 'II', 95, 9], ['reset', '↻', 87, 9],
];
const KEY = 'zane-stick-touch-v1';
const STICK = { moveUp: [0, -1], moveDown: [0, 1], moveLeft: [-1, 0], moveRight: [1, 0] } as const;

export function touchControls(input: InputManager, view: HTMLElement) {
  if (!matchMedia('(pointer: coarse)').matches) return;
  let pos: Record<string, [number, number]> = {};
  try { pos = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* storage unavailable: the defaults */ }
  const root = el('div', { class: 'touch', 'aria-hidden': 'true' });
  document.body.append(root);
  setInterval(() => { const off = !input.capture; if (root.hidden !== off) root.hidden = off; }, 200); // menus: no controls
  let editing = false;
  // a control presses the action's first bound key, as the keyboard would (pause and reset reach the game's key handler too)
  const press = (action: string, down: boolean) => {
    const code = input.bindings.keyboard[action]?.[0];
    if (code) window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
  };
  const place = (e: HTMLElement, id: string, x: number, y: number) => { [x, y] = pos[id] ?? [x, y]; e.style.left = `${x}%`; e.style.top = `${y}%`; };
  const placeAll = () => { for (const [id, , x, y] of CONTROLS) place(root.querySelector<HTMLElement>(`[data-id="${id}"]`)!, id, x, y); };

  for (const [id, label] of CONTROLS) {
    const b = el('div', { class: id === 'stick' ? 'tstick' : 'tbtn', 'data-id': id }, id === 'stick' ? el('div', { class: 'knob' }) : label);
    root.append(b);
    const held = new Set<string>(); // the stick's direction keys down now
    let active = false;
    const stick = (ev: PointerEvent | null) => {
      const r = b.getBoundingClientRect(), R = r.width / 2;
      const dx = ev ? Math.max(-1, Math.min(1, (ev.clientX - r.left - R) / R)) : 0, dy = ev ? Math.max(-1, Math.min(1, (ev.clientY - r.top - R) / R)) : 0;
      (b.firstChild as HTMLElement).style.transform = `translate(${dx * R * 0.5}px, ${dy * R * 0.5}px)`;
      for (const [a, [sx, sy]] of Object.entries(STICK)) {
        const on = sx * dx + sy * dy > 0.35;
        if (on !== held.has(a)) { press(a, on); if (on) held.add(a); else held.delete(a); }
      }
    };
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); active = true; b.classList.add('on');
      if (editing) return;
      if (id === 'stick') stick(ev); else press(id, true);
    });
    b.addEventListener('pointermove', (ev) => {
      if (!active) return;
      if (editing) { const r = root.getBoundingClientRect(); pos[id] = [(ev.clientX - r.left) / r.width * 100, (ev.clientY - r.top) / r.height * 100]; place(b, id, 0, 0); }
      else if (id === 'stick') stick(ev);
    });
    const up = () => {
      if (!active) return;
      active = false; b.classList.remove('on');
      if (editing) { try { localStorage.setItem(KEY, JSON.stringify(pos)); } catch { /* not saved */ } return; }
      if (id === 'stick') stick(null); else press(id, false);
    };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  }
  const edit = el('div', { class: 'tbtn small', text: '✎' }), reset = el('div', { class: 'tbtn small', text: 'Reset', hidden: '' });
  const full = el('div', { class: 'tbtn small', text: '⛶' });
  edit.style.left = '79%'; edit.style.top = '9%'; reset.style.left = '50%'; reset.style.top = '9%'; full.style.left = '71%'; full.style.top = '9%';
  // fullscreen hides the browser bars; landscape where the phone allows the lock
  full.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    void document.documentElement.requestFullscreen?.().then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => {});
  });
  edit.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); editing = !editing;
    root.classList.toggle('editing', editing); edit.textContent = editing ? 'Done' : '✎'; reset.hidden = !editing;
  });
  reset.addEventListener('pointerdown', (ev) => { ev.preventDefault(); pos = {}; try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } placeAll(); });
  root.append(edit, reset, full, el('div', { class: 'trotate', text: 'Turn your phone sideways to play' }));
  placeAll();

  // drag on the field to look (no pointer lock on touch screens); no mouse-button events from the touch either
  let last: { id: number; x: number; y: number } | null = null; // one finger looks; a second one is ignored
  view.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'touch') return;
    ev.preventDefault();
    if (!last) last = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
  });
  view.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== last?.id) return;
    input.addLook((ev.clientX - last.x) * 2, (ev.clientY - last.y) * 2);
    last = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
  });
  const lift = (ev: PointerEvent) => { if (ev.pointerId === last?.id) last = null; };
  view.addEventListener('pointerup', lift); view.addEventListener('pointercancel', lift);
}
