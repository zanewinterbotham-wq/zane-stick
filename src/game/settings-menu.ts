// The Settings screen: one tabbed panel for every setting (title menu and pause menu both open it).
// To add a setting, add a row to GAMEPLAY_ROWS (or the matching tab builder) and a field to Settings.
import { CATCH_RANGES, catchTuning, type CatchTuning } from '../sim/modes/catching';
import { JUMP_DEFAULTS, JUMP_RANGES, type JumpTuning } from '../sim/anim/jump';
import type { SupportSettings } from '../sim/anim/types';
import { DEFAULT_GAINS } from '../sim/control/hand';
import { keyName, keysText, RESERVED, type InputManager } from './input/input';
import { PERF_KNOBS, PRESET_ORDER, PRESETS, type Preset, type PresetName } from './presets';
import { GORE_LEVELS } from './render/effects';
import type { GameRenderer } from './render/renderer';
import { DIFFICULTY_PRESETS, GAME_SUPPORT, PLAYER_BASE, difficultyOf, type Settings } from './settings';
import { el, type Layer } from './ui';

/** What the screen needs from the running game (the App in main.ts implements it). */
export interface SettingsHost {
  settings: Settings;
  input: InputManager;
  layer: Layer;
  audio: { muted: boolean; play(cat: string, loud: number): void };
  hud: { flash(msg: string): void };
  cam: { mode: string };
  /** Null until the first rep has built it. */
  renderer: Pick<GameRenderer, 'xray' | 'setXray' | 'effortShading' | 'goreLevel'> | null;
  preset: Preset;
  save(): void;
  setAutoCamera(on: boolean): void;
  toggleCamera(): void;
  keyTest(back: () => void): void;
}

/** Rebindable actions on the Controls tab: binding name, what it does, controller button. */
const REBIND: [string, string, string][] = [
  ['moveUp', 'Move forward (relative to the camera)', 'Left stick'], ['moveLeft', 'Move left', 'Left stick'],
  ['moveDown', 'Move back', 'Left stick'], ['moveRight', 'Move right', 'Left stick'],
  ['sprint', 'Sprint (drives the legs in contact)', 'RT'],
  ['thrust', 'Thrust the hips: fire out along the pads, shoulder first', 'X'],
  ['jump', 'Jump (one press: dip, take off, land on your feet): rise for a high ball, hurdle a diver', 'A'],
  ['dive', 'Dive forward (one press: launch, fly, land)', 'B'],
  ['armL', 'Left arm: raise toward the aim (or a ball flying at you), grab what it touches, catch a ball near it', 'LB'],
  ['armR', 'Right arm: raise toward the aim (or a ball flying at you), grab what it touches, catch a ball near it', 'RB'],
  ['torsoDown', 'Lower the pads: torso down and hips low (also scroll up)', 'D-pad down / LT'],
  ['torsoUp', 'Raise the pads: torso up and hips high (also scroll down)', 'D-pad up'],
  ['shiftLock', 'Side shuffle on / off: face the camera way, A / D shuffle', 'L3 (stick click)'],
  ['throw', 'Throw where the ring is; hold longer for more loft (only this key throws: Left click stays the left arm)', 'Y'],
  ['reset', 'Reset rep', 'Start (tap)'], ['tuning', 'Tuning panel', 'menu'], ['overlay', 'Performance overlay', 'menu'],
];
/** Controls that are not rebindable. */
const FIXED: string[][] = [['Pads (torso and hips)', 'Scroll (up = lower the pads)', '—'], ['Look (aims the arms)', 'Mouse', 'Right stick'], ['Pause', 'Esc', 'Start (hold)']];

const DIFF_LABEL = { easy: 'Easy', normal: 'Normal', hard: 'Hard', custom: 'Custom' };
const x = (v: number) => `${v.toFixed(2)}×`, pct = (v: number) => `${(v * 100).toFixed(0)} %`;

/** A Gameplay row: a slider or an on/off switch on one Settings field. Append to GAMEPLAY_ROWS to add one. */
export type GameplayRow =
  | { kind: 'slider'; label: string; desc: string; min: number; max: number; step: number; get(s: Settings): number; set(s: Settings, v: number): void; fmt?: (v: number) => string }
  | { kind: 'toggle'; label: string; desc: string; get(s: Settings): boolean; set(s: Settings, v: boolean): void };

const sec = (v: number) => `${v.toFixed(2)} s`, m = (v: number) => `${v.toFixed(2)} m`;
/** The Advanced tab's Jump section: [knob, label, description, format]; ranges are JUMP_RANGES. */
const JUMP_ROWS: [keyof JumpTuning, string, string, (v: number) => string][] = [
  ['height', 'Jump height', 'Standing take-off strength (higher jumps higher).', x],
  ['runHeight', 'Running jump height', 'One-foot take-off strength off a run.', x],
  ['dip', 'Dip depth', 'How far the hips dip before a standing jump: deeper is higher but slower to leave the turf.', m],
  ['load', 'Dip time', 'How long the dip takes (the take-off delay): shorter is snappier and lower.', sec],
  ['push', 'Push time', 'Longest standing push off the turf.', sec],
  ['charge', 'Charge time', 'Hold Jump to charge: seconds to a full jump; it goes on the release. 0 = off (a tap is a full jump).', (v) => (v <= 0 ? 'off' : sec(v))],
  ['chargeMin', 'Charge: tap strength', 'With charge on, how strong a quick tap is.', pct],
  ['carry', 'Running jump carry', 'How much of the run\'s speed a running jump keeps.', pct],
  ['air', 'Air control', 'Steer toward your move direction in the air (m/s²); 0 = none, pure physics.', (v) => (v <= 0 ? 'off' : `${v.toFixed(1)} m/s²`)],
  ['soft', 'Landing softness', 'How much the legs give as they land.', pct],
  ['recover', 'Landing recovery', 'How long the legs take to firm up after a landing.', sec],
  ['cooldown', 'Cooldown', 'Time after a landing before the next jump.', sec],
  ['buffer', 'Press buffer', 'How long a press waits for a foot on the turf (a press mid-stride jumps on the next step).', sec],
  ['arms', 'Arm swing', 'How hard the arms swing up through the take-off.', x],
  ['tuck', 'Knee tuck', 'How high the knees come up in the air.', x],
];
export const GAMEPLAY_ROWS: GameplayRow[] = [
  { kind: 'slider', label: 'AI toughness (force needed to tackle the bot)', desc: 'How hard the bot is to knock off balance (its hit, stun and wrap-up thresholds).', min: 0.4, max: 2.5, step: 0.05, get: (s) => s.toughness, set: (s, v) => (s.toughness = v), fmt: x },
  { kind: 'slider', label: 'AI juking', desc: 'How well the bot carrier reads you, times his cuts and bursts away.', min: 0, max: 1, step: 0.05, get: (s) => s.juking, set: (s, v) => (s.juking = v), fmt: pct },
  { kind: 'slider', label: 'AI tackling', desc: 'How quickly bot tacklers read your jukes, how good their pursuit angles are, how hard they are to shake.', min: 0, max: 1, step: 0.05, get: (s) => s.tackling, set: (s, v) => (s.tackling = v), fmt: pct },
  { kind: 'slider', label: 'Player bone strength', desc: 'How hard a hit it takes to break one of your bones (lower breaks more easily).', min: 0.25, max: 4, step: 0.05, get: (s) => s.boneStrength, set: (s, v) => (s.boneStrength = v), fmt: (v) => `${v.toFixed(2)}x` },
  { kind: 'slider', label: 'AI bone strength', desc: 'The same for the bots.', min: 0.25, max: 4, step: 0.05, get: (s) => s.aiBoneStrength, set: (s, v) => (s.aiBoneStrength = v), fmt: (v) => `${v.toFixed(2)}x` },
  { kind: 'slider', label: 'Player strength', desc: 'Your muscle strength.', min: 0.5, max: 1.5, step: 0.01, get: (s) => s.strength, set: (s, v) => (s.strength = v), fmt: x },
  { kind: 'slider', label: 'Player speed', desc: 'How fast your joints can move.', min: 0.7, max: 1.5, step: 0.01, get: (s) => s.speed, set: (s, v) => (s.speed = v), fmt: x },
  { kind: 'slider', label: 'Hit power', desc: 'Above 1 adds an arcade push to whoever a hit drives back (the bot can blow you back too); 1 is pure physics.', min: 1, max: 3, step: 0.1, get: (s) => s.hitPower, set: (s, v) => (s.hitPower = v), fmt: (v) => (v <= 1 ? '1.0 (pure physics)' : `${v.toFixed(1)}×`) },
  { kind: 'slider', label: 'Steer assist', desc: 'Turns your run part way toward the ball carrier (or a loose ball) when he is near and ahead.', min: 0, max: 1, step: 0.05, get: (s) => s.steerAssist, set: (s, v) => (s.steerAssist = v), fmt: pct },
  { kind: 'toggle', label: 'Big-hit slow motion', desc: 'Slow motion and a short freeze on the hardest hits.', get: (s) => s.slowMo, set: (s, v) => (s.slowMo = v) },
];

/** A range input with a live value readout; `set` runs on every edit. */
function range(label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, fmt: (v: number) => string, changed: () => void) {
  const out = el('span', { class: 'mono', text: fmt(value) });
  const r = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
  r.addEventListener('input', () => { const v = +r.value; out.textContent = fmt(v); set(v); changed(); });
  return [r, out] as const;
}

/** A settings row: title and description on the left, the control on the right. */
const setRow = (label: string, desc: string, ...controls: HTMLElement[]) =>
  el('div', { class: 'set-row' }, el('div', { class: 'set-label' }, el('b', { text: label }), ...(desc ? [el('small', { text: desc })] : [])), el('div', { class: 'set-ctl' }, ...controls));

/** A segmented choice: one button per option, the current one pressed. */
function seg<T extends string | number | boolean>(label: string, opts: { value: T; text: string }[], get: () => T, set: (v: T) => void, onChange: () => void = () => {}) {
  const g = el('div', { class: 'seg', role: 'group', 'aria-label': label });
  const btns = opts.map((o) => {
    const b = el('button', { type: 'button', class: 'seg-btn', 'aria-label': `${label}: ${o.text}`, 'data-sfx': 'ui_confirm', text: o.text });
    b.addEventListener('click', () => { set(o.value); paint(); onChange(); });
    return [b, o.value] as const;
  });
  const paint = () => btns.forEach(([b, v]) => b.setAttribute('aria-pressed', String(v === get())));
  paint();
  g.append(...btns.map(([b]) => b));
  return g;
}

const onOff = (label: string, get: () => boolean, set: (v: boolean) => void, onChange?: () => void) =>
  seg<boolean>(label, [{ value: false, text: 'Off' }, { value: true, text: 'On' }], get, set, onChange);

type Ctx = { host: SettingsHost; status: HTMLElement; reopen: () => void; back: () => void };
const TABS: { id: string; label: string; build(c: Ctx): HTMLElement[] }[] = [
  { id: 'gameplay', label: 'Gameplay', build: gameplayTab },
  { id: 'controls', label: 'Controls', build: controlsTab },
  { id: 'camera', label: 'Camera', build: cameraTab },
  { id: 'graphics', label: 'Graphics', build: graphicsTab },
  { id: 'audio', label: 'Audio', build: audioTab },
  { id: 'gore', label: 'Gore', build: goreTab },
  { id: 'advanced', label: 'Advanced', build: advancedTab },
];
let lastTab = TABS[0].id;

/** Open the Settings screen. `back` returns to wherever it was opened from. */
export function openSettings(host: SettingsHost, back: () => void, tab = lastTab) {
  let cur = TABS.find((t) => t.id === tab) ?? TABS[0];
  const root = el('div', { class: 'panel menu wide settings', role: 'dialog', 'aria-label': 'Settings' });
  const tabs = el('div', { class: 'inv-tabs', role: 'tablist' });
  const body = el('div', { class: 'set-body', role: 'tabpanel' });
  const status = el('p', { class: 'sub', role: 'status' });
  const backBtn = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_back' }, 'Back');
  backBtn.addEventListener('click', back);
  const ctx: Ctx = { host, status, reopen: () => openSettings(host, back, cur.id), back };
  const render = () => {
    lastTab = cur.id;
    tabs.replaceChildren(...TABS.map((t) => {
      const b = el('button', { type: 'button', role: 'tab', class: 'inv-tab', 'aria-selected': String(t === cur), 'data-tab': t.id, text: t.label });
      b.addEventListener('click', () => { cur = t; status.textContent = ''; render(); tabs.querySelector<HTMLElement>('[aria-selected=true]')!.focus(); });
      return b;
    }));
    body.replaceChildren(...cur.build(ctx));
    body.scrollTop = 0;
  };
  tabs.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    cur = TABS[(TABS.indexOf(cur) + d + TABS.length) % TABS.length];
    status.textContent = '';
    render();
    tabs.querySelector<HTMLElement>('[aria-selected=true]')!.focus();
    e.preventDefault();
  });
  // Esc steps back to the previous menu; stopped here so the pause menu does not also resume the game
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); back(); } });
  render();
  root.append(el('h1', { text: 'Settings' }), tabs, body, status, backBtn);
  host.layer.show(root);
  tabs.querySelector<HTMLElement>('[aria-selected=true]')?.focus();
}

// ---------------------------------------------------------------- tabs
function gameplayTab({ host, status, reopen }: Ctx) {
  const s = host.settings;
  const presets = el('div', { class: 'seg', role: 'group', 'aria-label': 'Difficulty preset' });
  const rows = el('div', { class: 'set-list' });
  const refresh = () => {
    const now = difficultyOf(s);
    status.textContent = `Difficulty: ${DIFF_LABEL[now]}. Each setting moves on its own; changes apply from the next rep.`;
    presets.replaceChildren(...(Object.keys(DIFFICULTY_PRESETS) as (keyof typeof DIFFICULTY_PRESETS)[]).map((k) => {
      const b = el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(now === k), 'data-sfx': 'ui_confirm', text: DIFF_LABEL[k] });
      b.addEventListener('click', () => { Object.assign(s, DIFFICULTY_PRESETS[k]); host.save(); reopen(); });
      return b;
    }), el('span', { class: 'seg-note', text: now === 'custom' ? 'Custom' : '' }));
  };
  rows.append(setRow('Difficulty', 'Presets set AI toughness, AI juking, AI tackling and your strength and speed together.', presets));
  for (const r of GAMEPLAY_ROWS) {
    if (r.kind === 'slider') {
      const [input, out] = range(r.label, r.get(s), r.min, r.max, r.step, (v) => r.set(s, v), r.fmt ?? ((v) => v.toFixed(2)), () => { host.save(); refresh(); });
      rows.append(setRow(r.label, r.desc, input, out));
    } else rows.append(setRow(r.label, r.desc, onOff(r.label, () => r.get(s), (v) => { r.set(s, v); host.save(); })));
  }
  refresh();
  // catching (catching.ts): every knob, the same for you and the bots; empty = the defaults
  const c = () => catchTuning(s.catching), catchRows = el('div', { class: 'set-list' });
  const drawCatch = () => catchRows.replaceChildren(...CATCH_ROWS.map(([k, label, desc]) => {
    const [lo, hi] = CATCH_RANGES[k], fmt = k === 'reach' ? (v: number) => `${v.toFixed(2)} m` : pct;
    const [input, out] = range(label, c()[k], lo, hi, 0.01, (v) => { s.catching = { ...s.catching, [k]: v }; }, fmt, () => host.save());
    return setRow(label, desc, input, out);
  }));
  drawCatch();
  const resetCatch = el('button', { type: 'button', class: 'item', 'data-sfx': 'ui_back', text: 'Catching: back to the defaults' });
  resetCatch.addEventListener('click', () => { s.catching = {}; host.save(); drawCatch(); });
  return [rows, el('h2', { class: 'set-h', text: 'Catching' }), el('p', { class: 'sub', text: 'How easy catching is, for you and the bots alike. A ball comes to your raised hands; the chance is the base chance for the hands times the factors below. Applies from the next rep.' }), catchRows, el('div', { class: 'items' }, resetCatch)];
}

/** The catching knobs on the Gameplay tab: [field, label, what it does]. */
const CATCH_ROWS: [keyof CatchTuning, string, string][] = [
  ['reach', 'Catch reach', 'How close the ball must come to a raised hand (or between both) to be caught.'],
  ['twoHands', 'Two-hand chance', 'Both hands up (the diamond): the chance before the factors below.'],
  ['oneHand', 'One-hand chance', 'One hand up.'],
  ['body', 'Body catch chance', 'The ball hits the chest or stomach with no hand to it.'],
  ['edge', 'Off-centre catches', 'A ball at the very edge of the reach (100% = no harder than one into the hands).'],
  ['hard', 'Hard throws', 'A very hard throw (100% = as easy as a soft one).'],
  ['moving', 'Catching at full speed', 'Running flat out (100% = as easy as standing).'],
  ['air', 'Catching in the air', 'Jumping or diving for it.'],
  ['contact', 'Catching in contact', 'With a defender on you.'],
  ['blind', 'Not looking at the ball', 'A ball you are not looking at (100% = no harder).'],
];

function controlsTab({ host, status, reopen }: Ctx) {
  const s = host.settings;
  const keys = () => host.input.bindings.keyboard;
  status.textContent = 'Replace or Add, then press a key or mouse button. Esc, Alt, Tab and the Windows key stay with the browser and system.';
  const table = el('table', { class: 'controls' });
  const render = () => table.replaceChildren(
    el('tr', {}, ...['Action', 'Keyboard and mouse', 'Controller', ''].map((h) => el('th', { text: h }))),
    ...REBIND.map(([a, label, pad]) => {
      const rep = el('button', { class: 'bind', type: 'button', 'aria-label': `Replace ${label}` }, 'Replace');
      const add = el('button', { class: 'bind', type: 'button', 'aria-label': `Add a key to ${label}` }, 'Add');
      rep.addEventListener('click', () => listenForBind(host, a, label, false, status, render));
      add.addEventListener('click', () => listenForBind(host, a, label, true, status, render));
      return el('tr', { 'data-action': a }, el('td', { text: label }), el('td', { class: 'keys-cell', text: keysText(keys()[a] ?? []) }), el('td', { text: pad }), el('td', {}, rep, add));
    }),
    ...FIXED.map((r) => el('tr', {}, ...r.map((c) => el('td', { text: c })), el('td'))));
  render();
  // hold, or toggle (press on, press again off); every rep starts with it off
  const mode = (label: string, get: () => boolean, set: (on: boolean) => void) =>
    setRow(label, '', seg(label, [{ value: false, text: 'hold' }, { value: true, text: 'toggle (press on / off)' }], get, (v) => { set(v); host.save(); }));
  const reset = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Reset controls to defaults');
  reset.addEventListener('click', () => { s.bindings = {}; host.input.setKeyboard({}); host.save(); render(); status.textContent = 'Controls reset to the defaults.'; });
  const test = el('button', { class: 'item', type: 'button' }, 'Key test');
  test.addEventListener('click', () => host.keyTest(reopen));
  return [
    el('p', { class: 'sub', text: 'Contact mode is automatic: within about 4 m of the ball carrier your athlete settles into a ready stance with the arms up. No control is needed for balance; once you make contact, physics decides who stays up. J / L and I / K always work alongside the mouse, so a touchpad is enough.' }),
    table,
    el('div', { class: 'set-list' },
      mode('Sprint', () => s.sprintToggle, (on) => (s.sprintToggle = host.input.sprintToggle = on))),
    el('p', { class: 'sub', text: 'Click the field to capture the mouse; Esc frees it and pauses. Lowering the pads also gets the hips low; after a big hit they come back up to running.' }),
    el('div', { class: 'items' }, reset, test),
  ];
}

function cameraTab({ host, status }: Ctx) {
  const s = host.settings;
  status.textContent = 'Camera changes show at once.';
  return [el('div', { class: 'set-list' },
    setRow('Camera view', 'Chase: over the shoulder. Helmet: through the visor.',
      seg('Camera view', [{ value: 'chase', text: 'Chase' }, { value: 'helmet', text: 'Helmet' }], () => host.cam.mode as string, (v) => { if (host.cam.mode !== v) host.toggleCamera(); })),
    setRow('Automatic camera', 'On: the camera follows the athlete. Off: look with the mouse or right stick.',
      onOff('Automatic camera', () => s.autoCamera, (v) => host.setAutoCamera(v))))];
}

function graphicsTab({ host, status, reopen }: Ctx) {
  const s = host.settings;
  const r = host.renderer;
  status.textContent = 'Quality applies from the next rep (physics settings never change mid-rep).';
  const xray = onOff('Anatomy view', () => !!host.renderer?.xray, (v) => host.renderer?.setXray(v));
  if (!r) xray.querySelectorAll('button').forEach((b) => b.setAttribute('aria-disabled', 'true'));
  xray.addEventListener('click', (e) => { if (!host.renderer) { e.stopPropagation(); status.textContent = 'Anatomy view can be switched on once a rep has started.'; } }, true);
  // the ladder: one line per level, the chosen one marked
  const ladder = el('ul', { class: 'ladder', 'aria-label': 'Quality levels' }, ...PRESET_ORDER.map((k) => el('li', { 'aria-current': String(k === host.preset.name) },
    el('b', { text: PRESETS[k].label }), el('span', { text: ` ${PRESETS[k].desc}` }))));
  // Advanced: single knobs over the level ('Level' = the level's own value; absent physics options are the exact ones)
  const level = PRESETS[host.preset.name], EXACT: Record<string, unknown> = { tolerance: 1e-8, lod: 0, cone: 'elliptic', worker: false };
  const own = (k: (typeof PERF_KNOBS)[number]) => {
    const v = k.key === 'worker' ? level.worker : ((k.physics ? level.physics : level.render) as unknown as Record<string, unknown>)[k.key];
    return v === Infinity ? 999 : v ?? EXACT[k.key];
  };
  const knob = (k: (typeof PERF_KNOBS)[number]) => {
    const cur = k.choices.find((c) => c.value === own(k))?.text ?? String(own(k));
    const perf = s.perf as Record<string, unknown>;
    return setRow(k.label, k.desc, seg<string>(k.label, [{ value: 'level', text: `Level (${cur})` }, ...k.choices.map((c) => ({ value: JSON.stringify(c.value), text: c.text }))],
      () => (k.key in perf ? JSON.stringify(perf[k.key]) : 'level'),
      (v) => { if (v === 'level') delete perf[k.key]; else perf[k.key] = JSON.parse(v); host.save(); }));
  };
  const reset = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Use the level\'s values');
  reset.addEventListener('click', () => { s.perf = {}; host.save(); reopen(); });
  return [el('div', { class: 'set-list' },
    setRow('Quality', 'Physics precision, body detail and graphics together. High and Ultra run the same physics; the lower levels trade precision for speed.',
      seg<PresetName>('Quality', PRESET_ORDER.map((k) => ({ value: k, text: PRESETS[k].label })), () => host.preset.name, (v) => { s.preset = v; host.save(); }, () => reopen())),
    ladder,
    setRow('Anatomy view', 'Shows the muscles and skeleton instead of the skin.', xray),
    setRow('Effort shading (anatomy view)', 'Colours each muscle by how hard it is working.',
      onOff('Effort shading', () => s.effortShading, (v) => { s.effortShading = v; if (host.renderer) host.renderer.effortShading = v; host.save(); }))),
  el('h2', { class: 'set-h', text: 'Advanced: physics' }), el('div', { class: 'set-list' }, ...PERF_KNOBS.filter((k) => k.physics).map(knob)),
  el('h2', { class: 'set-h', text: 'Advanced: graphics' }), el('div', { class: 'set-list' }, ...PERF_KNOBS.filter((k) => !k.physics).map(knob)),
  el('div', { class: 'items' }, reset)];
}

function audioTab({ host, status }: Ctx) {
  const s = host.settings;
  status.textContent = '';
  return [el('div', { class: 'set-list' },
    setRow('Sound', 'Hits, crowd, whistles and menu sounds.',
      onOff('Sound', () => !s.mute, (v) => { s.mute = !v; host.audio.muted = s.mute; host.save(); })))];
}

function goreTab({ host, status }: Ctx) {
  const s = host.settings;
  const style = el('p', { class: 'sub', role: 'note' });
  const show = () => { status.textContent = ''; style.textContent = `Injury effects style: ${GORE_LEVELS[s.goreLevel]?.style ?? ''}.`; };
  show();
  return [
    el('p', { class: 'sub', text: 'How injuries look: from comic stars only to heavy blood. Shows at once.' }),
    el('div', { class: 'set-list' },
      setRow('Gore', '', seg<number>('Gore', GORE_LEVELS.map((g, i) => ({ value: i, text: g.label })), () => s.goreLevel, (v) => { s.goreLevel = v; if (host.renderer) host.renderer.goreLevel = v; host.save(); }, show))),
    style,
  ];
}

function advancedTab({ host, status, reopen }: Ctx) {
  const s = host.settings;
  status.textContent = 'Tuning changes apply from the next rep (physics settings never change mid-rep).';
  const gainKeys: (keyof typeof DEFAULT_GAINS)[] = ['torsoKp', 'torsoKd', 'footK', 'stepWidth', 'swingWn', 'stanceKnee', 'stanceHip', 'dcmK', 'heightKp', 'heightKd', 'spine'];
  const grid = el('div', { class: 'grid2' });
  const row = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, fmt = (v: number) => v.toFixed(3)) =>
    grid.append(el('label', { text: label }), ...range(label, value, min, max, step, set, fmt, () => host.save()));
  const deg = (v: number) => `${(v * 180 / Math.PI).toFixed(0)}°`;
  const sup = s.support;
  const supportRow = (label: string, k: keyof SupportSettings, min: number, max: number, step: number, fmt?: (v: number) => string) =>
    row(`Support: ${label}`, sup[k], min, max, step, (v) => (sup[k] = v), fmt);
  supportRow('strength', 'strength', 0, 1, 0.01, pct);
  supportRow('carry accel (m/s²)', 'carryAccel', 0, 15, 0.1, (v) => v.toFixed(1));
  supportRow('weight share', 'weightShare', 0, 1, 0.01, pct);
  supportRow('tilt fade start', 'tiltStart', 0.1, 1.2, 0.01, deg);
  supportRow('tilt fade end', 'tiltEnd', 0.2, 1.5, 0.01, deg);
  supportRow('big hit (N·s)', 'bigHit', 20, 400, 1, (v) => v.toFixed(0));
  supportRow('tracking stiffness ×', 'tracking', 0.25, 2, 0.01, (v) => v.toFixed(2));
  row('Athlete speed ×', s.speed, 0.7, 1.5, 0.01, (v) => (s.speed = v), (v) => v.toFixed(2));
  row('Muscle strength ×', s.strength, 0.5, 1.5, 0.01, (v) => (s.strength = v), (v) => v.toFixed(2));
  row('Balance assist (no support)', s.assist, 0, 1, 0.01, (v) => (s.assist = v), pct);
  row('Cleat traction μ', s.traction, 0.5, 1.6, 0.01, (v) => (s.traction = v));
  for (const k of gainKeys) {
    const d = DEFAULT_GAINS[k], v = s.gains[k] ?? d;
    row(`Gain: ${k}`, v, d * 0.25, d * 4, d / 100, (g) => (s.gains[k] = g));
  }
  const exp = el('textarea', { readonly: 'true', 'aria-label': 'Exported values' });
  const update = () => (exp.value = JSON.stringify({ support: sup, speed: PLAYER_BASE.speed * s.speed, strength: PLAYER_BASE.strength * s.strength, assist: s.assist, traction: s.traction, gains: { ...DEFAULT_GAINS, ...s.gains } }, null, 2));
  update();
  grid.addEventListener('input', update);
  const copy = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Copy values');
  copy.addEventListener('click', () => { void navigator.clipboard?.writeText(exp.value).then(() => host.hud.flash('Copied'), () => { exp.select(); }); });
  const reset = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Reset to defaults');
  reset.addEventListener('click', () => { s.gains = {}; s.assist = 0.2; s.traction = 1.2; s.support = { ...GAME_SUPPORT }; host.save(); reopen(); });
  // Jump: one slider per JumpTuning knob over the defaults (s.jump holds only the ones moved)
  const jumpRows = JUMP_ROWS.map(([k, label, desc, fmt]) => {
    const [min, max, step] = JUMP_RANGES[k];
    return setRow(label, desc, ...range(label, s.jump[k] ?? JUMP_DEFAULTS[k], min, max, step, (v) => (s.jump[k] = v), fmt, () => host.save()));
  });
  const jumpReset = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Reset jump to defaults');
  jumpReset.addEventListener('click', () => { s.jump = {}; host.save(); reopen(); });  return [
    el('div', { class: 'set-list' }, setRow('Performance overlay', 'Frame rate and physics cost, top right (also the ` key).', onOff('Performance overlay', () => s.overlay, (v) => { s.overlay = v; host.save(); }))),
    el('h2', { class: 'set-h', text: 'Tuning' }), grid, exp, el('div', { class: 'items' }, copy, reset),
    el('h2', { class: 'set-h', text: 'Jump' }), el('div', { class: 'set-list' }, ...jumpRows), el('div', { class: 'items' }, jumpReset),
  ];
}

// ---------------------------------------------------------------- key rebinding
/** Wait for the next key or mouse button and bind it to the action (Esc cancels). A key taken from another action
 *  leaves it, so one key never does two things. */
function listenForBind(host: SettingsHost, action: string, label: string, add: boolean, status: HTMLElement, done: () => void) {
  status.textContent = `Press a key or mouse button for "${label}"… (Esc cancels)`;
  (document.activeElement as HTMLElement | null)?.blur(); // a Space press must not re-click the button
  const swallow = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const finish = (code: string | null) => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
    // the click and context menu that follow a bound mouse press must not reach the menu
    setTimeout(() => { window.removeEventListener('click', swallow, true); window.removeEventListener('contextmenu', swallow, true); }, code?.startsWith('Mouse') ? 400 : 0);
    if (code) {
      const k = host.input.bindings.keyboard, next: Record<string, string[]> = {};
      for (const [a, codes] of Object.entries(k)) if (a !== action && codes.includes(code)) next[a] = codes.filter((c) => c !== code);
      next[action] = add ? [...new Set([...(k[action] ?? []), code])] : [code];
      host.settings.bindings = { ...host.settings.bindings, ...next };
      host.input.setKeyboard(host.settings.bindings);
      host.save();
      host.audio.play('ui_confirm', 1);
      status.textContent = `"${label}": ${keysText(host.input.bindings.keyboard[action])}`;
    } else status.textContent = 'Cancelled.';
    done();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!status.isConnected) { finish(null); return; } // the screen was left (controller B): stop listening
    swallow(e);
    if (e.code === 'Escape') finish(null);
    else if (RESERVED.test(e.code)) status.textContent = `${keyName(e.code)} stays with the browser and system: press another key (Esc cancels)`;
    else finish(e.code);
  };
  const onMouse = (e: MouseEvent) => { if (!status.isConnected) { finish(null); return; } swallow(e); finish(`Mouse${e.button}`); };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
  window.addEventListener('click', swallow, true);
  window.addEventListener('contextmenu', swallow, true);
}
