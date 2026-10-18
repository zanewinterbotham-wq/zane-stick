/// <reference types="vite/client" />
// The Play screen: a card per game mode (preview, name, pitch), like the inventory. A card opens the mode's setup:
// its options as sliders, toggles and choices (remembered per mode in the settings), and Start.
import { MODES, resolveOptions, SLOW_ATHLETES } from '../sim/modes/registry';
import type { ModeDef, ModeOptions, OptionDesc } from '../sim/modes/types';
import type { Settings } from './settings';
import { el } from './ui';

export interface ModeHooks {
  /** Put a screen on the menu layer. */
  show(e: HTMLElement): void;
  start(def: ModeDef, options: ModeOptions): void;
  back(): void;
  save(): void;
}

/** A mode's options as last set, validated against its descriptors. */
export const savedOptions = (s: Settings, def: ModeDef) => resolveOptions(def, s.modeOptions?.[def.id]);

const preview = (def: ModeDef) => el('img', { src: import.meta.env.BASE_URL + def.preview, alt: `${def.title} preview`, loading: 'lazy', draggable: 'false' });
const escapeTo = (root: HTMLElement, go: () => void) => root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); go(); } });

/** The grid of modes. `focus`: the mode whose card gets the focus (coming back from its setup). */
export function modeMenu(s: Settings, hooks: ModeHooks, focus?: string): HTMLElement {
  const grid = el('div', { class: 'inv-grid mode-grid' });
  for (const def of MODES) {
    const card = el('button', { type: 'button', class: 'inv-card mode-card', 'data-mode': def.id, 'aria-label': `${def.title}: ${def.pitch}` },
      el('div', { class: 'pic' }, preview(def)), el('div', { class: 'inv-info' }, el('h3', { text: def.title }), el('p', { text: def.pitch })));
    card.addEventListener('click', () => hooks.show(modeSetup(def, s, hooks)));
    grid.append(card);
  }
  const back = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_back' }, 'Back');
  back.addEventListener('click', hooks.back);
  const root = el('div', { class: 'panel menu inventory', role: 'dialog', 'aria-label': 'Play' },
    el('h1', { text: 'Play' }), el('p', { class: 'sub', text: 'Pick a game mode, set it up, and go.' }), grid, back);
  escapeTo(root, hooks.back);
  if (focus) queueMicrotask(() => grid.querySelector<HTMLElement>(`[data-mode="${focus}"]`)?.focus());
  return root;
}

/** One mode's setup: its options and Start. */
export function modeSetup(def: ModeDef, s: Settings, hooks: ModeHooks): HTMLElement {
  const o = savedOptions(s, def);
  const note = el('p', { class: 'sub', role: 'status' });
  const changed = () => {
    s.modeOptions = { ...s.modeOptions, [def.id]: { ...o } };
    hooks.save();
    const n = def.athletes(o);
    note.textContent = `${n} athletes on the field.` + (n > SLOW_ATHLETES ? ' May run slowly on low-end devices.' : '');
  };
  const grid = el('div', { class: 'grid2 mode-options' });
  for (const d of def.options) grid.append(...control(d, o, changed));
  changed();
  const start = el('button', { class: 'item start', type: 'button', 'data-sfx': 'ui_confirm' }, 'Start');
  start.addEventListener('click', () => hooks.start(def, { ...o }));
  const back = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_back' }, 'Back');
  const toGrid = () => hooks.show(modeMenu(s, hooks, def.id));
  back.addEventListener('click', toGrid);
  const root = el('div', { class: 'panel menu wide mode-setup', role: 'dialog', 'aria-label': `${def.title} setup` },
    el('h1', { text: def.title }), el('div', { class: 'mode-head' }, el('div', { class: 'pic' }, preview(def)), el('p', { class: 'sub', text: def.pitch })),
    grid, note, start, back);
  escapeTo(root, toGrid);
  queueMicrotask(() => start.focus());
  return root;
}

/** The label, control and value cells of one option in the .grid2 table. */
function control(d: OptionDesc, o: ModeOptions, changed: () => void): HTMLElement[] {
  const label = el('label', { text: d.label });
  if (d.kind === 'range') {
    const fmt = (v: number) => `${v}${d.unit ? ' ' + d.unit : ''}`;
    const out = el('span', { class: 'mono', text: fmt(o[d.id] as number) });
    const r = el('input', { type: 'range', min: String(d.min), max: String(d.max), step: String(d.step), value: String(o[d.id]), 'aria-label': d.label, 'data-option': d.id });
    r.addEventListener('input', () => { o[d.id] = +r.value; out.textContent = fmt(+r.value); changed(); });
    return [label, r, out];
  }
  if (d.kind === 'toggle') {
    const b = el('button', { type: 'button', class: 'toggle', 'data-option': d.id, 'aria-label': d.label });
    const show = () => { b.textContent = o[d.id] ? 'On' : 'Off'; b.setAttribute('aria-pressed', String(!!o[d.id])); };
    b.addEventListener('click', () => { o[d.id] = !o[d.id]; show(); changed(); });
    show();
    return [label, b, el('span')];
  }
  const row = el('div', { class: 'choices', role: 'group', 'aria-label': d.label, 'data-option': d.id });
  const show = () => row.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.choice === o[d.id])));
  for (const c of d.choices) {
    const b = el('button', { type: 'button', 'data-choice': c.id }, c.label);
    b.addEventListener('click', () => { o[d.id] = c.id; show(); changed(); });
    row.append(b);
  }
  show();
  return [label, row, el('span')];
}
