// The Settings screen: one tabbed panel for every setting (title menu and pause menu both open it).
// To add a setting, add a row to GAMEPLAY_ROWS (or the matching tab builder) and a field to Settings.
import { CATCH_RANGES, catchTuning, type CatchTuning } from '../sim/modes/catching';
import { FUMBLE_RANGES, fumbleTuning, type FumbleTuning } from '../sim/fumble';
import { JUMP_RANGES, jumpTuning, type JumpTuning } from '../sim/anim/jump';
import { QB_RANGES, qbTuning, type QbTuning } from '../sim/brains/football/qbTuning';
import type { SupportSettings } from '../sim/anim/types';
import { DEFAULT_GAINS } from '../sim/control/hand';
import { keyName, keysText, RESERVED, type InputManager } from './input/input';
import { PERF_KNOBS, PRESET_ORDER, PRESETS, type Preset, type PresetName } from './presets';
import { GORE_LEVELS } from './render/effects';
import type { GameRenderer } from './render/renderer';
import { DEFAULT_SETTINGS, DIFFICULTY_PRESETS, PLAYER_BASE, difficultyOf, type Settings } from './settings';
import { el, range, type Layer } from './ui';

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
/** The bot QB knobs on the Advanced tab: [field, label, what it does, format]. */
const QB_ROWS: [keyof QbTuning, string, string, (v: number) => string][] = [
  ['skill', 'Bot QB skill', 'How fast he reads the field and how precise his reads and leads are (default 50 %; 100 % is elite).', (v) => `${Math.round(v * 100)} %`],
  ['look', 'Read time', 'The shortest time one read takes, before his reaction time adds to it.', (v) => `${v.toFixed(2)} s`],
  ['lookK', 'Reaction in reads', 'How much his reaction time adds to each read.', (v) => `${v.toFixed(2)}×`],
  ['aim', 'Lead error', 'How far off his lead can be at the release (per unit of noise).', (v) => `${v.toFixed(2)} m`],
  ['aimPerM', 'Lead error per metre', 'Extra lead error for every metre of the throw.', (v) => `${v.toFixed(3)} m`],
  ['nerves', 'Nerves under pressure', 'How much a defender on him adds to the lead error.', (v) => `${v.toFixed(1)}×`],
  ['misread', 'Misreads', 'How much he misjudges how open a receiver is.', (v) => `${v.toFixed(2)}×`],
  ['open', 'How open before he throws', 'How open a receiver must look before he throws to him (lower: riskier throws).', (v) => `${Math.round(v * 100)} %`],
];
/** The jump knobs on the Advanced tab: [knob, label, what it does, format]. */
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
  { kind: 'slider', label: 'Player strength', desc: 'Your muscle strength.', min: 0.5, max: 1.5, step: 0.01, get: (s) => s.strength, set: (s, v) => (s.strength = v), fmt: x },
  { kind: 'slider', label: 'Hit power', desc: 'Above 1 adds an arcade push to whoever a hit drives back (the bot can blow you back too); 1 is pure physics.', min: 1, max: 3, step: 0.1, get: (s) => s.hitPower, set: (s, v) => (s.hitPower = v), fmt: (v) => (v <= 1 ? '1.0 (pure physics)' : `${v.toFixed(1)}×`) },
  { kind: 'toggle', label: 'Big-hit slow motion', desc: 'Slow motion and a short freeze on the hardest hits.', get: (s) => s.slowMo, set: (s, v) => (s.slowMo = v) },
];

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
  return [rows];
}

/** The catching knobs on the Advanced tab: [field, label, what it does, format]. */
/** The fumble knobs on the Advanced tab: [knob, label, what it does, format]. */
const FUMBLE_ROWS: [keyof FumbleTuning, string, string, (v: number) => string][] = [
  ['hold', 'Ball security', 'How hard the ball is to knock loose: × the force the carrier’s grip on the ball holds (higher: fewer fumbles).', (v) => `${v.toFixed(2)}×`],
  ['window', 'Jolt window', 'How long a pull on the ball must last to strip it: a longer window lets short jolts pass.', (v) => `${(v * 1000).toFixed(0)} ms`],
];

const CATCH_ROWS: [keyof CatchTuning, string, string, (v: number) => string][] = [
  ['reach', 'Catch reach', 'How close the ball must come to a raised hand (or between both) to be caught.', m],
  ['twoHands', 'Two-hand chance', 'Both hands up (the diamond): the chance before the factors below.', pct],
  ['oneHand', 'One-hand chance', 'One hand up.', pct],
  ['body', 'Body catch chance', 'The ball hits the chest or stomach with no hand to it.', pct],
  ['edge', 'Off-centre catches', 'A ball at the very edge of the reach (100% = no harder than one into the hands).', pct],
  ['hard', 'Hard throws', 'A very hard throw (100% = as easy as a soft one).', pct],
  ['moving', 'Catching at full speed', 'Running flat out (100% = as easy as standing).', pct],
  ['air', 'Catching in the air', 'Jumping or diving for it.', pct],
  ['contact', 'Catching in contact', 'With a defender on you.', pct],
  ['blind', 'Not looking at the ball', 'A ball you are not looking at (100% = no harder).', pct],
];

/** The Advanced tab's tuning groups: a Settings field holding only the knobs moved, over the defaults its `tune` fills
 *  in (and clamps). `ranges`: [min, max, step?] per knob (no step: 0.01). To add a group, add a row here. */
interface TuningGroup { key: 'jump' | 'qb' | 'catching' | 'fumble'; title: string; note?: string; rows: [string, string, string, (v: number) => string][]; ranges: Record<string, readonly number[]>; tune(o: unknown): object; reset: string }
const TUNING: TuningGroup[] = [
  { key: 'jump', title: 'Jump', rows: JUMP_ROWS, ranges: JUMP_RANGES, tune: jumpTuning, reset: 'Reset jump to defaults' },
  { key: 'qb', title: 'Bot QB', rows: QB_ROWS, ranges: QB_RANGES, tune: qbTuning, reset: 'Reset QB to defaults' },
  { key: 'catching', title: 'Catching', note: 'How easy catching is, for you and the bots alike: the base chance for the hands times the factors below.', rows: CATCH_ROWS, ranges: CATCH_RANGES, tune: catchTuning, reset: 'Catching: back to the defaults' },
  { key: 'fumble', title: 'Fumbles', note: 'Fumbles stay physics, the same for you and the bots: the ball comes loose when a hit pulls on it harder than the grip holds.', rows: FUMBLE_ROWS, ranges: FUMBLE_RANGES, tune: fumbleTuning, reset: 'Reset fumbles to defaults' },
];
const tuned = (g: TuningGroup, s: Settings) => g.tune(s[g.key]) as Record<string, number>;

/** One tuning group's heading, sliders and reset (in place); `changed` runs after a reset. */
function tuningSection(host: SettingsHost, g: TuningGroup, changed: () => void): HTMLElement[] {
  const s = host.settings, list = el('div', { class: 'set-list' });
  const draw = () => list.replaceChildren(...g.rows.map(([k, label, desc, fmt]) => {
    const [min, max, step = 0.01] = g.ranges[k];
    return setRow(label, desc, ...range(label, tuned(g, s)[k], min, max, step, (v) => Object.assign(s, { [g.key]: { ...s[g.key], [k]: v } }), fmt, () => host.save()));
  }));
  draw();
  const reset = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm', text: g.reset });
  reset.addEventListener('click', () => { Object.assign(s, { [g.key]: {} }); host.save(); draw(); changed(); });
  return [el('h2', { class: 'set-h', text: g.title }), ...(g.note ? [el('p', { class: 'sub', text: g.note })] : []), list, el('div', { class: 'items' }, reset)];
}

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
  row('Player speed ×', s.speed, 0.7, 1.5, 0.01, (v) => (s.speed = v), (v) => v.toFixed(2));
  row('Player bone strength ×', s.boneStrength, 0.25, 4, 0.05, (v) => (s.boneStrength = v), (v) => v.toFixed(2));
  row('AI bone strength ×', s.aiBoneStrength, 0.25, 4, 0.05, (v) => (s.aiBoneStrength = v), (v) => v.toFixed(2));
  row('Steer assist', s.steerAssist, 0, 1, 0.05, (v) => (s.steerAssist = v), pct);
  row('Muscle strength ×', s.strength, 0.5, 1.5, 0.01, (v) => (s.strength = v), (v) => v.toFixed(2));
  row('Balance assist (no support)', s.assist, 0, 1, 0.01, (v) => (s.assist = v), pct);
  row('Cleat traction μ', s.traction, 0.5, 1.6, 0.01, (v) => (s.traction = v));
  for (const k of gainKeys) {
    const d = DEFAULT_GAINS[k], v = s.gains[k] ?? d;
    row(`Gain: ${k}`, v, d * 0.25, d * 4, d / 100, (g) => (s.gains[k] = g));
  }
  const exp = el('textarea', { readonly: 'true', 'aria-label': 'Exported values' });
  // every tweakable on this tab, with the defaults filled in: the JSON to make the new defaults
  const update = () => (exp.value = JSON.stringify({ support: sup, speed: PLAYER_BASE.speed * s.speed, strength: PLAYER_BASE.strength * s.strength, assist: s.assist, traction: s.traction,
    boneStrength: s.boneStrength, aiBoneStrength: s.aiBoneStrength, steerAssist: s.steerAssist, gains: { ...DEFAULT_GAINS, ...s.gains },
    ...Object.fromEntries(TUNING.map((g) => [g.key, tuned(g, s)])) }, null, 2));
  update();
  const copy = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Copy values');
  copy.addEventListener('click', () => { void navigator.clipboard?.writeText(exp.value).then(() => host.hud.flash('Copied'), () => { exp.select(); }); });
  const reset = el('button', { class: 'item', type: 'button', 'data-sfx': 'ui_confirm' }, 'Reset to defaults');
  reset.addEventListener('click', () => {
    for (const k of ['gains', 'assist', 'traction', 'support', 'speed', 'strength', 'boneStrength', 'aiBoneStrength', 'steerAssist'] as const) Object.assign(s, { [k]: structuredClone(DEFAULT_SETTINGS[k]) });
    host.save(); reopen();
  });
  // Jump, Bot QB, Catching: each knob over its defaults, the same for you and the bots
  const body = el('div', {}, el('h2', { class: 'set-h', text: 'Tuning' }), grid, ...TUNING.flatMap((g) => tuningSection(host, g, update)));
  body.addEventListener('input', update); // the export follows every slider on the tab
  return [
    el('div', { class: 'set-list' }, setRow('Performance overlay', 'Frame rate and physics cost, top right (also the ` key).', onOff('Performance overlay', () => s.overlay, (v) => { s.overlay = v; host.save(); }))),
    body, el('div', { class: 'items' }, reset),
    el('h2', { class: 'set-h', text: 'Export' }), el('p', { class: 'sub', text: 'Every value above: copy it to make them the new defaults.' }), exp, el('div', { class: 'items' }, copy),
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
