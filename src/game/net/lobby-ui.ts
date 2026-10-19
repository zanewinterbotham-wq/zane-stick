// Multiplayer screens: host or join (name, room code), and the lobby: room code to share, players with their path
// and ping, the mode (host picks, guests watch it change), and the position menu: both teams side by side, a card per
// position with its player or a bot. Players click a slot to take it; the host also drags players between slots, picks
// from each slot's dropdown, auto-assigns and adds positions. Keyboard, mouse and touch; one column at phone width.
import { CODE_ALPHABET, CODE_LENGTH, normCode } from '../../net/protocol';
import { MODES, modeById, SLOW_ATHLETES } from '../../sim/modes/registry';
import type { ModeOptions } from '../../sim/modes/types';
import { control, modeCard, preview, savedOptions } from '../modes';
import { TEAMS } from '../render/athleteMesh';
import type { Settings } from '../settings';
import { el } from '../ui';
import { countInfo, countOptions, notReady, slotsOf, TEAM_NAMES, type Lobby, type LobbyPlayer } from './lobby';
import type { Session } from './session';

/** Player colours in join order (chips, the roster). */
export const PALETTE = ['#ffb547', '#6bdaff', '#ff7a93', '#8de36b', '#c59bff', '#ffe066', '#4dd6c1', '#ff9a4d', '#9fb8ff', '#e0e0e0'];
export const playerColor = (l: Lobby, id: string) => PALETTE[Math.max(0, l.players.findIndex((p) => p.id === id)) % PALETTE.length];
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** Transport errors and close reasons, as a player reads them. */
export function netMessage(reason: string): string {
  return ({
    'Room not found': 'No room has that code. Check it with the host (it ends when the host leaves).',
    'Room closed': 'That room has closed.',
    'Could not reach the room server': 'Could not reach the room server. Check your connection and try again.',
    'host-left': 'The host left, so the room has closed.',
    disconnected: 'The connection to the room was lost.',
    kicked: 'The host removed you from the room.',
  } as Record<string, string>)[reason] ?? reason;
}

export const pingText = (p: Pick<LobbyPlayer, 'via' | 'rtt'>) => p.via === 'self' ? 'host'
  : p.via === 'connecting' ? 'connecting…' : `${p.via === 'rtc' ? 'direct' : 'relay'} · ${p.rtt ? `${Math.round(p.rtt * 1000)} ms` : '…'}`;

/** A typed or pasted code (or a whole invite link) → the characters a code can have, at most 5. */
export function codeChars(typed: string): string {
  const link = /[?&]join=([^&#\s]+)/i.exec(typed);
  return [...(link ? decodeURIComponent(link[1]) : typed).toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).join('').slice(0, CODE_LENGTH);
}

/** The invite link for a room: this page with ?join=CODE (a ?server= override is kept). */
export function joinLink(code: string): string {
  const u = new URL(location.href), server = u.searchParams.get('server');
  u.search = ''; u.hash = '';
  u.searchParams.set('join', code);
  if (server) u.searchParams.set('server', server);
  return u.href;
}

function copyButton(label: string, text: () => string): HTMLButtonElement {
  const b = el('button', { type: 'button', class: 'copy', 'data-sfx': 'ui_confirm' }, label);
  b.addEventListener('click', () => {
    const done = (msg: string) => { b.textContent = msg; setTimeout(() => (b.textContent = label), 1400); };
    if (!navigator.clipboard) return done('Copy failed'); // plain http on another device: no clipboard API
    void navigator.clipboard.writeText(text()).then(() => done('Copied'), () => done('Copy failed'));
  });
  return b;
}

// ---------------------------------------------------------------- host or join
export interface MpScreenHooks {
  name: string; code?: string; msg?: string; autoJoin?: boolean;
  rename(name: string): void;
  host(name: string): Promise<void>;
  join(code: string, name: string): Promise<void>;
  back(): void;
}

export function mpScreen(o: MpScreenHooks): HTMLElement {
  const name = el('input', { type: 'text', maxlength: '24', value: o.name, 'aria-label': 'Your name', autocomplete: 'nickname', spellcheck: 'false', class: 'name-input' });
  const code = el('input', { type: 'text', class: 'code-input mono', 'aria-label': 'Room code', placeholder: 'ABCDE', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text', value: codeChars(o.code ?? '') });
  const host = el('button', { type: 'button', class: 'item start', 'data-sfx': 'ui_confirm' }, 'Host a game', el('span', { class: 'hint', text: 'make a room and get a code' }));
  const join = el('button', { type: 'button', class: 'item start join', 'data-sfx': 'ui_confirm' }, 'Join');
  const back = el('button', { type: 'button', class: 'item', 'data-sfx': 'ui_back' }, 'Back');
  const status = el('p', { class: 'sub mp-status' + (o.msg ? ' error' : ''), role: 'status', text: o.msg ?? '' });
  const who = () => name.value.trim() || 'Player';
  const valid = () => { join.disabled = !normCode(code.value); };
  let busy = false;
  const run = async (what: string, f: () => Promise<void>) => {
    if (busy) return;
    busy = true; status.className = 'sub mp-status'; status.textContent = what;
    for (const b of [host, join, back]) b.disabled = true;
    try { await f(); } catch (e) {
      status.className = 'sub mp-status error'; status.textContent = netMessage(e instanceof Error ? e.message : String(e));
      for (const b of [host, back]) b.disabled = false;
      valid();
    }
    busy = false;
  };
  const doJoin = () => { if (normCode(code.value)) void run(`Joining ${normCode(code.value)}…`, () => o.join(normCode(code.value)!, who())); };
  name.addEventListener('change', () => o.rename(who()));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') code.focus(); });
  code.addEventListener('input', () => {
    const raw = code.value, c = codeChars(raw);
    if (c !== raw) code.value = c;
    // a dropped character is one a code never has (0 O 1 I L): say so rather than eat it silently
    if (!/join=/i.test(raw) && raw.replace(/[\s-]/g, '').length > c.length && c.length < CODE_LENGTH) { status.className = 'sub mp-status'; status.textContent = 'Codes never use 0, O, 1, I or L.'; }
    valid();
  });
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });
  host.addEventListener('click', () => void run('Making a room…', () => o.host(who())));
  join.addEventListener('click', doJoin);
  back.addEventListener('click', o.back);
  valid();
  const root = el('div', { class: 'panel menu mp-screen', role: 'dialog', 'aria-label': 'Multiplayer' },
    el('h1', { text: 'Multiplayer' }), el('p', { class: 'sub', text: 'Play with friends: one of you hosts and shares the room code.' }),
    el('label', { class: 'field' }, el('span', { text: 'Your name' }), name),
    host,
    el('div', { class: 'or', text: 'or join a friend' }),
    el('div', { class: 'join-row' }, code, join),
    status, back);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); o.back(); } });
  queueMicrotask(() => (code.value ? join : host).focus());
  if (o.autoJoin && normCode(code.value)) queueMicrotask(doJoin);
  return root;
}

// ---------------------------------------------------------------- the lobby
export interface LobbyHooks {
  start(force: boolean): void;
  leave(): void;
  save(): void;
  /** In a game (the pause menu's Positions): back to the play, and the host's next rep with these positions. */
  back?(): void;
  nextRep?(): void;
}
export interface LobbyView { root: HTMLElement; update(): void }

export function lobbyPanel(net: Session, s: Settings, hooks: LobbyHooks): LobbyView {
  const me = net.selfId, host = net.isHost, inGame = !!hooks.back;
  let picking = false, dragging = false;
  const code = el('b', { class: 'room-code mono', text: net.room.code, 'aria-label': `Room code ${[...net.room.code].join(' ')}` });
  const head = el('div', { class: 'lobby-head' },
    el('div', {}, el('h1', { text: inGame ? 'Positions' : 'Lobby' }), el('p', { class: 'sub', text: inGame ? 'Changes take effect from the next rep.' : host ? 'Share the code. Friends type it in Multiplayer, or open the link.' : 'The host picks the mode and starts the game.' })),
    el('div', { class: 'code-box' }, el('span', { class: 'lbl', text: 'Room code' }), code,
      el('div', { class: 'row' }, copyButton('Copy code', () => net.room.code), copyButton('Copy link', () => joinLink(net.room.code)))));
  const modeSec = el('section', { class: 'lobby-mode', 'aria-label': 'Game mode' });
  const posSec = el('section', { class: 'positions', 'aria-label': 'Positions' });
  const playersSec = el('section', { class: 'players', 'aria-label': 'Players' });
  const actions = el('div', { class: 'lobby-actions' });
  const root = el('div', { class: 'panel menu lobby', role: 'dialog', 'aria-label': 'Multiplayer lobby' }, head,
    el('div', { class: 'lobby-body' }, el('div', { class: 'lobby-main' }, modeSec, posSec), el('aside', { class: 'lobby-side' }, playersSec, actions)));
  const sigs = new Map<HTMLElement, string>();
  /** Rebuild a section when its data changed, keeping the focused control (by data-key). */
  const section = (sec: HTMLElement, sig: string, build: () => (Node | string)[]) => {
    if (sigs.get(sec) === sig) return;
    sigs.set(sec, sig);
    const key = sec.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    sec.replaceChildren(...build());
    if (key) sec.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
  };
  const l = () => net.lobby;
  const nameOf = (id: string) => l().players.find((p) => p.id === id)?.name ?? '?';
  const chip = (id: string | null) => id
    ? el('span', { class: 'chip' + (id === me ? ' me' : ''), style: `--c:${playerColor(l(), id)}`, ...(host && { 'data-drag': id, title: 'Drag to another position' }) }, nameOf(id) + (id === me ? ' (you)' : ''))
    : el('span', { class: 'chip bot', text: 'BOT' });

  // ---- mode
  const setup = (mode: string, o: ModeOptions) => { s.modeOptions = { ...s.modeOptions, [mode]: { ...o } }; s.mode = mode; hooks.save(); net.setup(mode, o); };
  const buildMode = (): (Node | string)[] => {
    const lb = l(), def = modeById(lb.mode);
    if (picking && host) {
      const grid = el('div', { class: 'inv-grid mode-grid' }, ...MODES.map((m) => modeCard(m, () => { picking = false; setup(m.id, m.id === lb.mode ? lb.options : savedOptions(s, m)); update(); })));
      const cancel = el('button', { type: 'button', class: 'item', 'data-sfx': 'ui_back', 'data-key': 'cancel-mode' }, 'Keep ' + def.title);
      cancel.addEventListener('click', () => { picking = false; update(); });
      grid.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); picking = false; update(); } });
      queueMicrotask(() => grid.querySelector<HTMLElement>(`[data-mode="${lb.mode}"]`)?.focus());
      return [el('h2', { text: 'Pick a mode' }), grid, cancel];
    }
    const o = { ...lb.options }, grid = el('div', { class: 'grid2 mode-options' });
    for (const d of def.options) {
      const cells = control(d, o, () => setup(lb.mode, { ...o }));
      cells.forEach((c) => c.querySelectorAll<HTMLElement>('input, button').forEach((x) => (x.dataset.key = `opt-${d.id}-${x.dataset.choice ?? ''}`)));
      cells.forEach((c) => { if (c.dataset.option) c.dataset.key = `opt-${d.id}`; });
      grid.append(...cells);
    }
    if (!host) grid.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((x) => { x.disabled = true; });
    const n = def.athletes(lb.options);
    const change = el('button', { type: 'button', class: 'copy', 'data-key': 'change-mode' }, 'Change mode');
    change.addEventListener('click', () => { picking = true; update(); });
    return [el('div', { class: 'mode-head' }, el('div', { class: 'pic' }, preview(def)),
      el('div', {}, el('h3', { text: def.title }), el('p', { class: 'sub', text: def.pitch }), ...(host ? [change] : []))),
      ...(def.options.length ? [grid] : []),
      el('p', { class: 'sub note', text: `${n} athletes on the field.${n > SLOW_ATHLETES ? ' May run slowly on low-end devices (the host simulates everyone).' : ''}` })];
  };

  // ---- positions
  const buildPositions = (): (Node | string)[] => {
    const lb = l(), def = modeById(lb.mode), slots = slotsOf(lb), mine = lb.assign.indexOf(me);
    const counts = host ? countOptions(def).map((d) => ({ d, ...countInfo(def, lb.options, d) })) : [];
    const stepper = (c: (typeof counts)[number]) => {
      const v = +lb.options[c.d.id], minus = el('button', { type: 'button', class: 'step', 'aria-label': `Remove a ${c.noun}`, 'data-key': `cnt-${c.d.id}-` }, '−');
      const plus = el('button', { type: 'button', class: 'step add', 'aria-label': `Add a ${c.noun}`, 'data-key': `cnt-${c.d.id}+` }, `+ Add ${c.noun}`);
      minus.disabled = v <= c.d.min; plus.disabled = v >= c.d.max;
      minus.addEventListener('click', () => net.count(c.d.id, -1));
      plus.addEventListener('click', () => net.count(c.d.id, 1));
      return el('div', { class: 'stepper' }, el('span', { class: 'lbl', text: c.d.label }), minus, el('b', { class: 'mono', text: String(v) }), plus);
    };
    const card = (i: number) => {
      const sl = slots[i], id = lb.assign[i], own = id === me;
      const b = el('button', { type: 'button', class: 'slot' + (own ? ' mine' : id ? ' taken' : ''), 'data-slot': String(i), 'data-key': `slot-${i}`,
        'aria-label': `${sl.label}: ${id ? nameOf(id) : 'bot'}${own ? '. Yours: click to give it to a bot' : id ? '' : '. Click to play it'}` },
      el('span', { class: 'pos', text: sl.label }), chip(id));
      b.addEventListener('click', () => { if (!dragging) net.want(i); });
      const wrap = el('div', { class: 'slot-wrap', 'data-slot': String(i) }, b);
      if (host) {
        const pick = el('select', { class: 'slot-pick', 'aria-label': `Who plays ${sl.label}`, 'data-key': `pick-${i}` },
          el('option', { value: '', text: 'Bot' }), ...lb.players.map((p) => el('option', { value: p.id, text: p.name + (p.id === me ? ' (you)' : '') })));
        pick.value = id ?? '';
        pick.addEventListener('change', () => net.place(i, pick.value || null));
        wrap.append(pick);
      }
      return wrap;
    };
    const teams = ([0, 1] as const).map((t) => {
      const idx = slots.flatMap((sl, i) => (sl.team === t ? [i] : [])), groups = [...new Set(idx.map((i) => slots[i].group).filter(Boolean))];
      return el('div', { class: 'team', style: `--team:${hex(TEAMS[t].jersey)};--glow:${hex(TEAMS[t].glow)}`, 'aria-label': TEAM_NAMES[t] },
        el('header', {}, el('h3', { text: groups.join(' / ') || TEAM_NAMES[t] }), el('span', { text: groups.length ? TEAM_NAMES[t] : `${idx.length} position${idx.length === 1 ? '' : 's'}` })),
        el('div', { class: 'slots' }, ...idx.map(card)),
        ...counts.filter((c) => c.teams.length === 1 && c.teams[0] === t).map(stepper));
    });
    const spectators = lb.players.filter((p) => !lb.assign.includes(p.id));
    const out: (Node | string)[] = [el('div', { class: 'pos-head' }, el('h2', { text: 'Positions' }),
      ...(host ? [btn('Auto-assign', 'auto', () => net.autoAssign(), 'Put everyone without a position on an open one, alternating teams'), btn('Everyone to bots', 'bots', () => net.allBots())] : []))];
    if (spectators.length && !lb.assign.includes(null)) out.push(el('p', { class: 'hint-box', text: `${lb.players.length} players, ${slots.length} positions: ${host ? 'add positions below so everyone plays' : 'ask the host to add positions'}.` }));
    out.push(el('div', { class: 'teams' }, ...teams), ...counts.filter((c) => c.teams.length !== 1).map(stepper));
    const watch = mine >= 0 ? [btn('Watch instead', 'watch', () => net.want(null))] : [];
    out.push(el('div', { class: 'spectators', 'data-drop': 'spectators' }, el('span', { class: 'lbl', text: 'Watching' }),
      ...(spectators.length ? spectators.map((p) => chip(p.id)) : [el('span', { class: 'empty', text: host ? 'nobody (drag a player here)' : 'nobody' })]), ...watch));
    out.push(el('p', { class: 'sub tip', text: host ? 'Click a position to take it. Drag players between positions (or use each dropdown) to place and swap them.' : 'Click an open (bot) position to take it, or your own to give it back to a bot.' }));
    return out;
  };

  // ---- players and actions
  const buildPlayers = (): (Node | string)[] => {
    const lb = l(), slots = slotsOf(lb);
    return [el('h2', { text: `Players (${lb.players.length})` }), el('ul', { class: 'roster' }, ...lb.players.map((p) => {
      const at = lb.assign.indexOf(p.id), kick = host && !p.host ? [btn('×', `kick-${p.id}`, () => net.kick(p.id), `Remove ${p.name} from the room`)] : [];
      return el('li', { class: 'player' + (p.id === me ? ' me' : '') },
        el('span', { class: 'dot', style: `--c:${playerColor(lb, p.id)}` }),
        el('span', { class: 'who' }, el('b', { text: p.name }), ...(p.host ? [el('span', { class: 'crown', title: 'Host', text: '♛' })] : []), ...(p.id === me ? [el('span', { class: 'you', text: 'you' })] : []),
          el('small', { text: `${at >= 0 ? slots[at].label : 'watching'}  ·  ${pingText(p)}` })),
        el('span', { class: 'ready' + (p.ready || p.host ? ' on' : ''), text: p.host ? 'host' : p.ready ? 'ready' : 'not ready' }), ...kick);
    }))];
  };
  const buildActions = (): (Node | string)[] => {
    const lb = l(), waiting = notReady(lb), self = lb.players.find((p) => p.id === me), out: (Node | string)[] = [];
    if (inGame) {
      out.push(btn('Back to game', 'back', () => hooks.back!(), undefined, 'item start'));
      if (hooks.nextRep) out.push(btn('Vote for the next rep (with these positions)', 'next', () => hooks.nextRep!(), undefined, 'item'));
    } else if (host) {
      const start = btn('Start', 'start', () => hooks.start(false), undefined, 'item start');
      start.disabled = waiting.length > 0;
      out.push(start);
      if (waiting.length) out.push(el('p', { class: 'sub wait', text: `Waiting for ${waiting.map((p) => p.name).join(', ')} to get ready.` }), btn('Start anyway', 'force', () => hooks.start(true), undefined, 'item'));
    } else {
      const r = btn(self?.ready ? 'Ready ✓' : 'Ready up', 'ready', () => net.ready(!self?.ready), undefined, 'item start ready-btn');
      r.setAttribute('aria-pressed', String(!!self?.ready));
      out.push(r, el('p', { class: 'sub wait', text: self?.ready ? 'Waiting for the host to start.' : 'Ready up when you have your position.' }));
    }
    out.push(btn('Leave room', 'leave', () => hooks.leave(), undefined, 'item'));
    if (host) out.push(el('p', { class: 'sub warn', text: 'Keep this tab in front while you host: the game runs on your device, and browsers slow down background tabs.' }));
    return out;
  };

  function update() {
    if (!root.isConnected && sigs.size) return;
    const lb = l(), players = lb.players.map((p) => [p.id, p.name, p.ready]);
    // the host's own option controls are not rebuilt under his hands (a slider mid-drag)
    if (!(host && !picking && modeSec.contains(document.activeElement) && sigs.has(modeSec))) section(modeSec, JSON.stringify([lb.mode, lb.options, picking]), buildMode);
    if (!dragging) section(posSec, JSON.stringify([lb.mode, lb.options, lb.assign, players]), buildPositions);
    section(playersSec, JSON.stringify([lb.players, lb.assign]), buildPlayers);
    section(actions, JSON.stringify([players, lb.assign]), buildActions);
  }

  // ---- the host drags player chips onto positions (or onto Watching); pointer events, so touch works too
  if (host) {
    posSec.addEventListener('pointerdown', (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>('[data-drag]');
      if (!c || e.button !== 0) return;
      const id = c.dataset.drag!, x0 = e.clientX, y0 = e.clientY;
      let ghost: HTMLElement | null = null, over: HTMLElement | null = null;
      const target = (ev: PointerEvent) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.slot-wrap, [data-drop]') ?? null;
      const move = (ev: PointerEvent) => {
        if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        if (!ghost) { dragging = true; ghost = c.cloneNode(true) as HTMLElement; ghost.classList.add('ghost'); document.body.append(ghost); root.classList.add('dragging'); }
        ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`;
        const t = target(ev);
        if (t !== over) { over?.classList.remove('over'); over = t; over?.classList.add('over'); }
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        if (!ghost) return;
        ghost.remove(); over?.classList.remove('over'); root.classList.remove('dragging');
        const t = ev.type === 'pointerup' ? target(ev) : null;
        if (t?.dataset.slot) net.place(+t.dataset.slot, id);
        else if (t?.dataset.drop) { const at = l().assign.indexOf(id); if (at >= 0) net.place(at, null); }
        setTimeout(() => { dragging = false; update(); }); // after the click this pointerup makes, which must not count
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
  }
  update();
  return { root, update };
}

function btn(label: string, key: string, action: () => void, title?: string, cls = 'copy'): HTMLButtonElement {
  const b = el('button', { type: 'button', class: cls, 'data-key': key, ...(title && { title, 'aria-label': title }) }, label);
  b.addEventListener('click', action);
  return b;
}

/** The in-game roster (Tab): name, position, ping, by team. */
export function rosterRows(l: Lobby, assign: (string | null)[], labels: string[]): [string, string, string][] {
  return l.players.map((p) => {
    const at = assign.indexOf(p.id);
    return [p.name + (p.host ? ' ♛' : ''), at >= 0 ? labels[at] : 'watching', pingText(p)];
  });
}

