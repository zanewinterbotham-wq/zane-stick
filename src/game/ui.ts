/// <reference types="vite/client" />
// DOM overlay: menus, HUD, results card, performance overlay and panels. Menus work with a keyboard
// (arrows/Tab + Enter, Escape to go back), a controller (D-pad + A, B to go back) or the mouse.
import type { InventoryCategory } from './inventory';
import type { Settings } from './settings';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

/** A range input with a live value readout; `set` runs on every edit, then `changed`. */
export function range(label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, fmt: (v: number) => string, changed: () => void) {
  const out = el('span', { class: 'mono', text: fmt(value) });
  const r = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
  r.addEventListener('input', () => { const v = +r.value; out.textContent = fmt(v); set(v); changed(); });
  return [r, out] as const;
}

/** sfx: the sound category played on activation (default ui_select). */
export interface MenuItem { label: string; hint?: string; sfx?: string; action: () => void }

/** A focusable vertical menu. Returns the element; focus moves with arrows / D-pad. */
export function menu(title: string, items: MenuItem[], subtitle?: string): HTMLElement {
  const box = el('div', { class: 'panel menu', role: 'dialog', 'aria-label': title });
  box.append(el('h1', { text: title }));
  if (subtitle) box.append(el('p', { class: 'sub', text: subtitle }));
  const list = el('div', { class: 'items' });
  items.forEach((it) => {
    const b = el('button', { class: 'item', type: 'button', ...(it.sfx && { 'data-sfx': it.sfx }) }, it.label);
    if (it.hint) b.append(el('span', { class: 'hint', text: it.hint }));
    b.addEventListener('click', it.action);
    list.append(b);
  });
  box.append(list);
  return box;
}

/** The inventory: a tab per category, a card per item (preview, name, pitch, state, Equip). `equip` returns false
 *  when the item cannot be equipped; `escape` makes Esc go back (the pause menu keeps Esc for resuming). */
export function inventoryPanel(cats: InventoryCategory[], settings: Settings, hooks: { equip(cat: string, item: string): boolean; back(): void; escape?: boolean }, tab = cats[0].id): HTMLElement {
  let cur = cats.find((c) => c.id === tab) ?? cats[0];
  const root = el('div', { class: 'panel menu inventory', role: 'dialog', 'aria-label': 'Inventory' });
  const tabs = el('div', { class: 'inv-tabs', role: 'tablist' });
  const grid = el('div', { class: 'inv-grid' });
  const note = el('p', { class: 'sub', role: 'status' });
  const back = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_back' }, 'Back');
  back.addEventListener('click', hooks.back);
  const render = (focusId?: string) => {
    tabs.replaceChildren(...cats.map((c) => {
      const t = el('button', { type: 'button', role: 'tab', class: 'inv-tab', 'aria-selected': String(c === cur), 'data-cat': c.id, text: c.label });
      t.addEventListener('click', () => { cur = c; note.textContent = ''; render(); (tabs.querySelector('[aria-selected=true]') as HTMLElement).focus(); });
      return t;
    }));
    const equipped = cur.equipped(settings), items = cur.items();
    grid.dataset.cat = cur.id;
    grid.setAttribute('role', 'list');
    grid.replaceChildren(...items.map((it) => {
      const on = it.id === equipped;
      const pic = el('div', { class: 'pic' + (it.preview ? '' : ' none') });
      if (it.preview) pic.append(el('img', { src: import.meta.env.BASE_URL + it.preview, alt: `${it.label} preview`, loading: 'lazy', draggable: 'false' }));
      else pic.append(el('span', { text: it.label.slice(0, 1) }));
      const state = on ? 'Equipped' : it.unlocked ? 'Equip' : 'Locked';
      const btn = el('button', { type: 'button', class: 'equip', 'data-item': it.id, 'data-sfx': 'ui_confirm', 'aria-disabled': String(on || !it.unlocked), 'aria-label': `${state}: ${it.label}`, text: state });
      btn.addEventListener('click', () => {
        if (on || !it.unlocked || !hooks.equip(cur.id, it.id)) return;
        note.textContent = `${it.label} equipped. It shows from the next rep.`;
        render(it.id);
      });
      return el('article', { class: 'inv-card' + (on ? ' equipped' : '') + (it.unlocked ? '' : ' locked'), role: 'listitem', 'data-item': it.id },
        pic, el('div', { class: 'inv-info' }, el('h3', { text: it.label }), el('p', { text: it.pitch })), btn);
    }));
    if (focusId) grid.querySelector<HTMLElement>(`button[data-item="${focusId}"]`)?.focus();
  };
  tabs.addEventListener('keydown', (e) => {
    const i = cats.indexOf(cur), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    cur = cats[(i + d + cats.length) % cats.length];
    render();
    (tabs.querySelector('[aria-selected=true]') as HTMLElement).focus();
    e.preventDefault();
  });
  if (hooks.escape) root.addEventListener('keydown', (e) => { if (e.key === 'Escape') hooks.back(); });
  render();
  root.append(el('h1', { text: 'Inventory' }), el('p', { class: 'sub', text: 'Everything you can equip. Changes show from the next rep.' }), tabs, grid, note, back);
  return root;
}

/** Move focus within the topmost menu (keyboard arrows or gamepad D-pad). */
export function moveFocus(root: HTMLElement, dir: 1 | -1) {
  const items = [...root.querySelectorAll<HTMLElement>('button, input, select, textarea')].filter((x) => !x.hasAttribute('disabled'));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  items[(i + dir + items.length) % items.length].focus();
}

export class Hud {
  readonly root = document.getElementById('hud')!;
  private status = el('div', { class: 'panel status mono' });
  private keys = el('div', { class: 'panel keylist', 'aria-label': 'Controls' });
  private keysShown = '';
  private overlay = el('div', { class: 'panel overlay mono' });
  private result = el('div', { class: 'panel result' });
  private toast = el('div', { class: 'toast' });
  private speedoMs = el('b');
  private speedoMph = el('span');
  private speedo = el('div', { class: 'panel speedo mono', 'aria-label': 'Speed' }, this.speedoMs, ' m/s', el('br'), this.speedoMph);
  private toastTimer = 0;
  /** Multiplayer: the room and ping corner, the Tab roster, the 3-2-1. */
  private net = el('div', { class: 'panel netbadge mono', 'aria-label': 'Connection' });
  private roster = el('div', { class: 'panel roster-hud', 'aria-label': 'Players' });
  private count = el('div', { class: 'countdown', 'aria-live': 'assertive' });
  /** QB throw scheme: its name and controls, and the power / touch meter. */
  private pass = el('div', { class: 'panel passhud', 'aria-label': 'Throw scheme' });
  private passText = el('div', { class: 'pass-text' });
  private meterBar = el('i');
  private meter = el('div', { class: 'meter', role: 'meter', 'aria-label': 'Throw power' }, this.meterBar);
  private shown = new Map<HTMLElement, string>();
  constructor() {
    this.pass.append(this.passText, this.meter);
    this.root.append(this.status, this.keys, this.overlay, this.result, this.toast, this.speedo, this.net, this.roster, this.count, this.pass);
    this.showResult(null);
    this.setOverlay(null);
    for (const e of [this.net, this.roster, this.count, this.pass]) e.style.display = 'none';
  }
  /** The throw scheme panel (null: hidden) and its meter (0..1; null: no meter now). */
  setPass(text: string | null, meter: number | null = null) {
    this.put(this.pass, text, () => [this.passText, this.meter]);
    if (text === null) return;
    this.passText.textContent = text;
    this.meter.style.visibility = meter === null ? 'hidden' : '';
    this.meterBar.style.width = `${((meter ?? 0) * 100).toFixed(1)}%`;
  }
  /** Show `sig`'s content in `e` (built only when it changes), or hide it. */
  private put(e: HTMLElement, sig: string | null, build: () => (Node | string)[]) {
    if (this.shown.get(e) === (sig ?? '')) return;
    this.shown.set(e, sig ?? '');
    e.style.display = sig === null ? 'none' : '';
    if (sig !== null) e.replaceChildren(...build());
  }
  setNet(text: string | null) { this.put(this.net, text, () => [text!]); }
  setRoster(rows: [string, string, string][] | null) {
    this.put(this.roster, rows && JSON.stringify(rows), () => [el('h2', { text: 'Players' }), ...rows!.map(([n, p, ping]) => el('div', { class: 'row' }, el('b', { text: n }), el('span', { text: p }), el('span', { class: 'mono', text: ping })))]);
  }
  setCountdown(text: string | null) { this.put(this.count, text, () => [text!]); }
  setVisible(on: boolean) { for (const e of [this.status, this.keys, this.speedo]) e.style.display = on ? '' : 'none'; }
  setStatus(lines: string[]) { this.status.textContent = lines.join('\n'); }
  /** The control list: one key + action per row, and an optional note underneath. Rebuilt only on change. */
  setControls(rows: [string, string][], note = '') {
    const sig = JSON.stringify([rows, note]);
    if (sig === this.keysShown) return;
    this.keysShown = sig;
    this.keys.replaceChildren(...rows.map(([k, a]) => el('div', { class: 'row' }, el('kbd', { text: k }), el('span', { text: a }))),
      ...(note ? [el('p', { class: 'note', text: note })] : []));
  }
  /** Speedometer: speed in m/s, shown with mph. */
  setSpeed(v: number, mph: number) {
    this.speedoMs.textContent = v.toFixed(1);
    this.speedoMph.textContent = `${mph.toFixed(1)} mph`;
  }
  setOverlay(lines: string[] | null) {
    this.overlay.style.display = lines ? '' : 'none';
    if (lines) this.overlay.textContent = lines.join('\n');
  }
  showResult(card: { title: string; banner?: string; rows: [string, string][]; foot: string } | null) {
    this.result.style.display = card ? '' : 'none';
    if (!card) return;
    this.result.replaceChildren(el('h2', { text: card.title }), ...(card.banner ? [el('div', { class: 'banner', text: card.banner })] : []), ...card.rows.map(([k, v]) => el('div', { class: 'row' }, el('span', { text: k }), el('b', { text: v }))), el('p', { class: 'foot', text: card.foot }));
  }
  flash(msg: string) {
    this.toast.textContent = msg;
    this.toast.style.opacity = '1';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toast.style.opacity = '0'), 1600);
  }
}

/** Modal layer for menus and panels. */
export class Layer {
  readonly root = el('div', { class: 'layer' });
  constructor() { document.body.append(this.root); this.hide(); }
  show(content: HTMLElement) {
    this.root.replaceChildren(content);
    this.root.style.display = '';
    const first = content.querySelector<HTMLElement>('button, input, select, textarea');
    first?.focus();
  }
  hide() { this.root.style.display = 'none'; this.root.replaceChildren(); }
  get open() { return this.root.style.display !== 'none'; }
}
