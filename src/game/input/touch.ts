// Touch controls (phones and tablets only): a stick to move, buttons that press each action's bound key, and a drag
// on the field to look. ✎ lets the player drag every control to a new place (saved on this device; Reset puts them back).
import { el } from '../ui';
import type { InputManager } from './input';

/** [action, label, x %, y %]: the default spot of each control's centre. 'stick' is the move stick. */
const CONTROLS: [string, string, number, number][] = [
  ['stick', '', 14, 74],
  ['jump', 'Jump', 90, 80], ['sprint', 'Sprint', 79, 88], ['dive', 'Dive', 90, 62], ['thrust', 'Thrust', 79, 70],
  ['armL', 'L arm', 68, 88], ['armR', 'R arm', 68, 70], ['throw', 'Throw', 79, 52], ['shiftLock', 'Shuffle', 68, 52],
  ['torsoUp', 'Pads ▲', 95, 28], ['torsoDown', 'Pads ▼', 95, 46],
  ['pause', 'II', 96, 7], ['reset', '↻', 89, 7],
];
const KEY = 'zane-stick-touch-v1';
const STICK = { moveUp: [0, -1], moveDown: [0, 1], moveLeft: [-1, 0], moveRight: [1, 0] } as const;

export function touchControls(input: InputManager, view: HTMLElement) {
  if (!matchMedia('(pointer: coarse)').matches) return;
  let pos: Record<string, [number, number]> = {};
  try { pos = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* storage unavailable: the defaults */ }
  const root = el('div', { class: 'touch', 'aria-hidden': 'true' });
  document.body.append(root);
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
      try { b.setPointerCapture(ev.pointerId); } catch { /* the finger already lifted */ }
      if (editing) return;
      if (id === 'stick') stick(ev); else press(id, true);
    });
    b.addEventListener('pointermove', (ev) => {
      if (!active) return;
      if (editing) { pos[id] = [ev.clientX / innerWidth * 100, ev.clientY / innerHeight * 100]; place(b, id, 0, 0); }
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
  edit.style.left = '82%'; edit.style.top = '7%'; reset.style.left = '50%'; reset.style.top = '7%';
  edit.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); editing = !editing;
    root.classList.toggle('editing', editing); edit.textContent = editing ? 'Done' : '✎'; reset.hidden = !editing;
  });
  reset.addEventListener('pointerdown', (ev) => { ev.preventDefault(); pos = {}; try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } placeAll(); });
  root.append(edit, reset);
  placeAll();

  // drag on the field to look (no pointer lock on touch screens); no mouse-button events from the touch either
  let last: { x: number; y: number } | null = null;
  view.addEventListener('pointerdown', (ev) => { if (ev.pointerType === 'touch') { ev.preventDefault(); last = { x: ev.clientX, y: ev.clientY }; } });
  view.addEventListener('pointermove', (ev) => {
    if (ev.pointerType !== 'touch' || !last) return;
    input.addLook((ev.clientX - last.x) * 2, (ev.clientY - last.y) * 2);
    last = { x: ev.clientX, y: ev.clientY };
  });
  view.addEventListener('pointerup', () => (last = null));
}
