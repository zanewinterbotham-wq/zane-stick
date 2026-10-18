// DOM overlay: menus, HUD, results card, performance overlay and panels. Menus work with a keyboard
// (arrows/Tab + Enter, Escape to go back), a controller (D-pad + A, B to go back) or the mouse.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

export interface MenuItem { label: string; hint?: string; action: () => void }

/** A focusable vertical menu. Returns the element; focus moves with arrows / D-pad. */
export function menu(title: string, items: MenuItem[], subtitle?: string): HTMLElement {
  const box = el('div', { class: 'panel menu', role: 'dialog', 'aria-label': title });
  box.append(el('h1', { text: title }));
  if (subtitle) box.append(el('p', { class: 'sub', text: subtitle }));
  const list = el('div', { class: 'items' });
  items.forEach((it) => {
    const b = el('button', { class: 'item', type: 'button' }, it.label);
    if (it.hint) b.append(el('span', { class: 'hint', text: it.hint }));
    b.addEventListener('click', it.action);
    list.append(b);
  });
  box.append(list);
  return box;
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
  constructor() {
    this.root.append(this.status, this.keys, this.overlay, this.result, this.toast, this.speedo);
    this.showResult(null);
    this.setOverlay(null);
  }
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
