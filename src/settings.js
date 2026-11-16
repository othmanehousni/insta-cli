/*
 * Every control of the Devault ASCII generator, as data.
 *
 * Read from the app's own UI code (control types, ranges, steps, labels and the rules that decide
 * when a control is shown). Defaults and the preset "looks" live in the app's engine and are read at
 * run time; the copies here are for validating flags before a browser starts and for `--list`.
 * test/bridge.test.js compares them with the live app, so a redesign of the site shows up as a failing
 * test rather than a silent mismatch.
 */
import { UsageError } from './util.js';

export const STYLES = [
  { id: 'classic', label: 'Classic', text: true },
  { id: 'detailed', label: 'Detailed', text: true },
  { id: 'blocks', label: 'Shade blocks', text: true },
  { id: 'tiles', label: 'Letter tiles', text: true },
  { id: 'minimal', label: 'Sparse', text: true },
  { id: 'binary', label: 'Binary', text: true },
  { id: 'braille', label: 'Braille', text: true },
  { id: 'dots', label: 'Round dots', text: true },
  { id: 'dither', label: 'Dither', text: true },
  { id: 'lego', label: 'Bricks', text: true },
  { id: 'particle', label: 'Particle', text: false },
  { id: 'film', label: 'Film', text: false },
  { id: 'custom', label: 'Custom', text: true },
];
export const STYLE_IDS = STYLES.map((s) => s.id);
/** Styles drawn with a font (the ones that have the Font and Letter spacing controls). */
export const FONT_STYLES = ['classic', 'detailed', 'minimal', 'binary', 'custom'];
export const PIXEL_ONLY_STYLES = STYLES.filter((s) => !s.text).map((s) => s.id);

export const PALETTE_IDS = ['devault', 'phosphor', 'amber', 'ice', 'sunset', 'cyber', 'mono'];

/** The app's preset looks (its "Presets" rail). Their settings are read from the engine at run time. */
export const APP_LOOKS = [
  ['devault', 'Devault'],
  ['mono', 'Mono'],
  ['terminal', 'Old monitor'],
  ['amber', 'Amber glow'],
  ['matrix', 'Digital rain'],
  ['newsprint', 'Printed page'],
  ['braille', 'Braille'],
  ['halftone', 'Halftone'],
  ['colour', 'True colour'],
  ['bricks', 'Brick mosaic'],
  ['tiles', 'Letter tiles'],
  ['film', 'Film'],
  ['particle', 'Particle'],
  ['tiles-grey', 'Grey tiles'],
  ['ascii-gradient', 'ASCII Gradient'],
  ['binary-gradient', 'Binary Gradient'],
  ['dither-gradient', 'Dither Gradient'],
  ['halftone-gradient', 'Halftone Gradient'],
].map(([id, label]) => ({ id, label }));

/**
 * Looks that belong to this CLI rather than the app. They are applied on top of the app's own
 * "reset" look, exactly like the app's presets are, and use only the app's own settings.
 */
export const OWN_LOOKS = [
  {
    id: 'photo',
    label: 'Photo-real',
    hint: 'The picture stays visible underneath detailed, true-colour letters: realistic, with the ASCII texture intact. Raise Image visibility (underlay) for more photo, lower it for more ASCII.',
    patch: {
      style: 'detailed',
      colorMode: 'source',
      boost: 30,
      overlay: true,
      underlay: 45,
      glyphOpacity: 90,
      glyphFade: 0,
      blend: 'normal',
      gamma: 1.3,
      cutoff: 0,
      edges: false,
      bloom: 0,
      vignette: 0,
      cols: 200,
    },
  },
];
OWN_LOOKS.push({
  id: 'ascii',
  label: 'Pure ASCII',
  hint: 'Only characters, on a plain background: the picture is built out of the letters and nothing shows through. Coloured by the picture, with a little extra contrast. This is what picking a --style on its own gives you.',
  patch: {
    colorMode: 'source',
    boost: 30,
    overlay: false,
    edges: true,
    bloom: 0,
    vignette: 0,
    contrast: 20,
    cutoff: 2,
    cols: 250,
  },
});
export const LOOK_IDS = [...OWN_LOOKS.map((l) => l.id), ...APP_LOOKS.map((l) => l.id)];
export const DEFAULT_LOOK = 'photo';
/** The look to start from: the realistic one by default, pure characters once you have chosen a style yourself. */
export const lookFor = ({ look, style, ramp }) => look ?? (style || ramp ? 'ascii' : DEFAULT_LOOK);

/** Settings that belong to this CLI rather than the app (the engine never sees them). */
export const OWN_DEFAULTS = { glyphs: 'shape', sharpen: 80 };
export const OWN_KEYS = Object.keys(OWN_DEFAULTS);

/** The app's defaults (engine `defaults`), kept for validation and `--list`. */
export const DEFAULTS = {
  style: 'classic',
  customRamp: ' .:-=+*#%@',
  font: 'geist',
  cols: 130,
  spacing: 0.5,
  tileGap: 30,
  tileSoft: 50,
  tileInk: 'auto',
  tileAccent: 100,
  tileFlip: 100,
  fGrain: 45,
  fGlow: 50,
  fBlur: 30,
  fFringe: 35,
  fWarm: 55,
  pAmount: 100,
  pDrift: 35,
  pSplash: 55,
  pGather: 70,
  pDepth: 50,
  pMelt: false,
  brightness: 0,
  contrast: 0,
  gamma: 1,
  cutoff: 6,
  scatter: 0,
  autoLevels: true,
  invert: false,
  colorMode: 'palette',
  monoColor: '#F4F4F7',
  palette: 'devault',
  boost: 25,
  bgMode: 'dark',
  bgColor: '#0D0D12',
  edges: true,
  edgeStrength: 55,
  edgeSmooth: 40,
  bloom: 22,
  scanlines: 0,
  curvature: 0,
  chroma: 0,
  vignette: 18,
  grain: 0,
  flicker: 0,
  shimmer: 0,
  animate: false,
  overlay: false,
  underlay: 100,
  glyphOpacity: 70,
  glyphFade: 0,
  blend: 'normal',
  ditherPattern: 'bayer4',
  exportScale: 2,
  exportSeconds: 5,
};

/** Every setting with its starting value: the app's own plus this CLI's. */
export const ALL_DEFAULTS = { ...DEFAULTS, ...OWN_DEFAULTS };

const sty = (...ids) => (s) => ids.includes(s.style);
const notPixel = (s) => s.style !== 'particle' && s.style !== 'film';
const on = (key) => (s) => !!s[key];
const signed = (n) => `${n > 0 ? '+' : ''}${n}`;
const choice = (...values) => values.map((v) => ({ value: v, label: v }));

/**
 * Sections and controls, in the order the app shows them.
 * type: range | toggle | choice | color | text
 * `where` says how each is honoured in a plain-text terminal: 'text' (fully), 'text~' (approximated or
 * emulated), 'image' (only visible in image / blocks rendering, which shows the app's own canvas).
 */
export const SECTIONS = [
  {
    id: 'style',
    title: 'Style',
    controls: [
      { key: 'style', type: 'choice', label: 'Style', choices: STYLES.map((s) => ({ value: s.id, label: s.label })), where: 'text' },
      { key: 'customRamp', type: 'text', label: 'Custom characters, sparse → dense', max: 40, visible: sty('custom'), where: 'text' },
      { key: 'ditherPattern', type: 'choice', label: 'Dither pattern', choices: choice('bayer4', 'bayer8', 'noise'), visible: sty('dither'), where: 'text' },
      { key: 'font', type: 'choice', label: 'Font', choices: choice('geist', 'system'), visible: (s) => FONT_STYLES.includes(s.style), where: 'image' },
      { key: 'cols', type: 'range', label: 'Detail (columns)', min: 20, max: 400, step: 1, visible: notPixel, where: 'text~', note: 'text mode never uses more columns than fit the terminal' },
      { key: 'spacing', type: 'range', label: 'Letter spacing', min: 0.4, max: 0.9, step: 0.01, fmt: (n) => n.toFixed(2), visible: (s) => FONT_STYLES.includes(s.style), where: 'text~' },
      { key: 'tileGap', type: 'range', label: 'Tile gaps', min: 0, max: 100, step: 1, fmt: (n) => (n === 0 ? 'None' : `${n}`), visible: sty('tiles'), where: 'text' },
      { key: 'tileSoft', type: 'range', label: 'Soft edges', min: 0, max: 100, step: 1, fmt: (n) => (n === 0 ? 'None' : `${n}`), visible: sty('tiles'), where: 'text' },
    ],
  },
  {
    id: 'particles',
    title: 'Particles',
    visible: sty('particle'),
    controls: [
      { key: 'pAmount', type: 'range', label: 'Amount', min: 2, max: 100, step: 1, fmt: (n) => `${Math.round((n / 100) * 524).toLocaleString('en')}k`, where: 'image' },
      { key: 'pDrift', type: 'range', label: 'Drift', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'pSplash', type: 'range', label: 'Splash', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'pGather', type: 'range', label: 'Gather', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'pDepth', type: 'range', label: 'Depth', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'pMelt', type: 'toggle', label: 'Melt (sparks sink)', where: 'image' },
    ],
  },
  {
    id: 'film',
    title: 'Film',
    visible: sty('film'),
    controls: [
      { key: 'fGrain', type: 'range', label: 'Grain', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'fGlow', type: 'range', label: 'Glow', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'fBlur', type: 'range', label: 'Soft blur', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'fFringe', type: 'range', label: 'Colour fringe', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'fWarm', type: 'range', label: 'Warmth', min: 0, max: 100, step: 1, where: 'image' },
    ],
  },
  {
    id: 'letters',
    title: 'Letters',
    visible: sty('tiles'),
    controls: [
      { key: 'tileInk', type: 'choice', label: 'Letter colour', choices: [{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'White' }, { value: 'dark', label: 'Black' }], where: 'text' },
      { key: 'tileAccent', type: 'range', label: 'Coloured letters', min: 0, max: 100, step: 1, fmt: (n) => (n === 0 ? 'None' : `${n}`), where: 'text' },
      { key: 'tileFlip', type: 'range', label: 'Opposite letters', min: 0, max: 100, step: 1, fmt: (n) => (n === 0 ? 'None' : `${n}`), where: 'text' },
    ],
  },
  {
    id: 'onimage',
    title: 'On image',
    visible: notPixel,
    controls: [
      { key: 'overlay', type: 'toggle', label: 'Keep the image underneath', where: 'text~', note: 'text mode: cell backgrounds take the picture\'s colour' },
      { key: 'underlay', type: 'range', label: 'Image visibility', min: 0, max: 100, step: 1, visible: on('overlay'), where: 'text~' },
      { key: 'glyphOpacity', type: 'range', label: 'Glyph opacity', min: 0, max: 100, step: 1, visible: on('overlay'), where: 'text~' },
      { key: 'glyphFade', type: 'range', label: 'Fade in shadows', min: 0, max: 100, step: 1, visible: on('overlay'), where: 'text~' },
      { key: 'blend', type: 'choice', label: 'Blend', choices: [{ value: 'normal', label: 'Normal' }, { value: 'overlay', label: 'Overlay' }, { value: 'soft', label: 'Soft' }, { value: 'screen', label: 'Screen' }, { value: 'multiply', label: 'Multiply' }], visible: on('overlay'), where: 'image', note: 'text mode always blends normally' },
    ],
  },
  {
    id: 'tone',
    title: 'Tone',
    controls: [
      { key: 'brightness', type: 'range', label: 'Brightness', min: -100, max: 100, step: 1, fmt: signed, where: 'text' },
      { key: 'contrast', type: 'range', label: 'Contrast', min: -100, max: 100, step: 1, fmt: signed, where: 'text' },
      { key: 'gamma', type: 'range', label: 'Gamma', min: 0.4, max: 2.5, step: 0.05, fmt: (n) => n.toFixed(2), where: 'text' },
      { key: 'cutoff', type: 'range', label: 'Hide shadows', min: 0, max: 60, step: 1, fmt: (n) => `${n}%`, where: 'text' },
      { key: 'scatter', type: 'range', label: 'Irregularity', min: 0, max: 100, step: 1, where: 'text' },
      { key: 'autoLevels', type: 'toggle', label: 'Auto levels', where: 'text' },
      { key: 'invert', type: 'toggle', label: 'Invert', where: 'text' },
    ],
  },
  {
    id: 'colour',
    title: 'Colour',
    visible: (s) => s.style !== 'film',
    controls: [
      { key: 'colorMode', type: 'choice', label: 'Glyph colour', choices: [{ value: 'mono', label: 'Mono' }, { value: 'source', label: 'Original' }, { value: 'palette', label: 'Palette' }], where: 'text' },
      { key: 'monoColor', type: 'color', label: 'Ink', visible: (s) => s.colorMode === 'mono', where: 'text' },
      { key: 'palette', type: 'choice', label: 'Palette', choices: choice(...PALETTE_IDS), visible: (s) => s.colorMode === 'palette', where: 'text' },
      { key: 'boost', type: 'range', label: 'Colour boost', min: -50, max: 100, step: 1, fmt: signed, visible: (s) => s.colorMode === 'source', where: 'text' },
      { key: 'bgMode', type: 'choice', label: 'Background', choices: [{ value: 'dark', label: 'Dark' }, { value: 'black', label: 'Black' }, { value: 'paper', label: 'Paper' }, { value: 'custom', label: 'Custom' }, { value: 'transparent', label: 'Clear' }], where: 'text', note: 'Clear leaves your terminal\'s own background' },
      { key: 'bgColor', type: 'color', label: 'Background colour', visible: (s) => s.bgMode === 'custom', where: 'text' },
    ],
  },
  {
    id: 'contours',
    title: 'Contours',
    visible: notPixel,
    controls: [
      { key: 'edges', type: 'toggle', label: 'Trace edges', where: 'text' },
      { key: 'edgeStrength', type: 'range', label: 'Strength', min: 5, max: 100, step: 1, visible: on('edges'), where: 'text' },
      { key: 'edgeSmooth', type: 'range', label: 'Smoothing', min: 0, max: 100, step: 1, visible: on('edges'), where: 'text' },
    ],
  },
  {
    id: 'text',
    title: 'Text rendering',
    own: true,
    visible: (s) => FONT_STYLES.includes(s.style),
    controls: [
      {
        key: 'glyphs',
        type: 'choice',
        label: 'Character choice',
        choices: [{ value: 'shape', label: 'Shape-matched' }, { value: 'brightness', label: 'Brightness (app)' }],
        where: 'text',
        own: true,
        note: 'shape: each cell\'s letter is chosen by how well its shape fits the detail inside the cell',
      },
      { key: 'sharpen', type: 'range', label: 'Detail boost', min: 0, max: 100, step: 5, visible: (s) => s.glyphs === 'shape', where: 'text', own: true },
    ],
  },
  {
    id: 'effects',
    title: 'Effects',
    controls: [
      { key: 'animate', type: 'toggle', label: 'Animate', where: 'text~', note: 'moving grain, flicker and twinkle' },
      { key: 'bloom', type: 'range', label: 'Bloom', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'scanlines', type: 'range', label: 'Scanlines', min: 0, max: 100, step: 1, where: 'text~' },
      { key: 'curvature', type: 'range', label: 'Curvature', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'chroma', type: 'range', label: 'Chromatic aberration', min: 0, max: 100, step: 1, where: 'image' },
      { key: 'vignette', type: 'range', label: 'Vignette', min: 0, max: 100, step: 1, where: 'text~' },
      { key: 'grain', type: 'range', label: 'Grain', min: 0, max: 100, step: 1, where: 'text~' },
      { key: 'flicker', type: 'range', label: 'Flicker', min: 0, max: 100, step: 1, where: 'text~' },
      { key: 'shimmer', type: 'range', label: 'Twinkle', min: 0, max: 100, step: 1, where: 'text' },
    ],
  },
];

export const CONTROLS = SECTIONS.flatMap((s) => s.controls.map((c) => ({ ...c, section: s.id })));
export const CONTROL_BY_KEY = Object.fromEntries(CONTROLS.map((c) => [c.key, c]));

export const sectionVisible = (section, state) => (section.visible ? section.visible(state) : true);
export const controlVisible = (control, state) => (control.visible ? control.visible(state) : true);

/** What the app would show for this state: sections with their currently visible controls. */
export function visibleLayout(state) {
  return SECTIONS.filter((s) => sectionVisible(s, state))
    .map((s) => ({ ...s, controls: s.controls.filter((c) => controlVisible(c, state)) }))
    .filter((s) => s.controls.length);
}

export function formatValue(control, value) {
  if (control.type === 'toggle') return value ? 'on' : 'off';
  if (control.type === 'choice') return control.choices.find((c) => c.value === value)?.label ?? String(value);
  if (control.type === 'range') return control.fmt ? control.fmt(value) : String(value);
  return String(value);
}

const TRUE = ['1', 'true', 'on', 'yes', 'y'];
const FALSE = ['0', 'false', 'off', 'no', 'n'];

/** Parse and validate one `--set key=value`. Returns [key, value]. */
export function parseSetting(arg) {
  const eq = arg.indexOf('=');
  if (eq < 1) throw new UsageError(`--set expects key=value (got "${arg}"). See: insta-ascii --list settings`);
  const key = arg.slice(0, eq).trim();
  const raw = arg.slice(eq + 1).trim();
  const c = CONTROL_BY_KEY[key];
  if (!c) throw new UsageError(`Unknown setting "${key}". See: insta-ascii --list settings`);
  return [key, coerce(c, raw)];
}

export function coerce(c, raw) {
  switch (c.type) {
    case 'toggle': {
      const v = String(raw).toLowerCase();
      if (TRUE.includes(v)) return true;
      if (FALSE.includes(v)) return false;
      throw new UsageError(`${c.key} is on/off (got "${raw}")`);
    }
    case 'range': {
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n) || n < c.min || n > c.max) {
        throw new UsageError(`${c.key} must be a number from ${c.min} to ${c.max} (got "${raw}")`);
      }
      return n;
    }
    case 'choice': {
      const v = String(raw).toLowerCase();
      const hit = c.choices.find((x) => x.value.toLowerCase() === v || x.label.toLowerCase() === v);
      if (!hit) throw new UsageError(`${c.key} must be one of: ${c.choices.map((x) => x.value).join(', ')} (got "${raw}")`);
      return hit.value;
    }
    case 'color': {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(raw).trim());
      if (!m) throw new UsageError(`${c.key} must be a colour like #FF8800 (got "${raw}")`);
      return `#${m[1].toUpperCase()}`;
    }
    default: {
      const s = String(raw);
      if (c.max && Array.from(s).length > c.max) throw new UsageError(`${c.key} is at most ${c.max} characters`);
      return s;
    }
  }
}

/** Step a control by `dir` (+1 / -1); `big` moves ten steps. Returns the new value. */
export function stepValue(control, value, dir, big = false) {
  if (control.type === 'toggle') return !value;
  if (control.type === 'choice') {
    const i = control.choices.findIndex((c) => c.value === value);
    return control.choices[(i + dir + control.choices.length) % control.choices.length].value;
  }
  if (control.type === 'range') {
    const next = Math.min(control.max, Math.max(control.min, value + dir * control.step * (big ? 10 : 1)));
    return Number((Math.round(next / control.step) * control.step).toFixed(4)); // no 0.30000000000000004
  }
  return value;
}

/**
 * Resolve the full settings object.
 * Order (like the app): its defaults -> the chosen look -> named flags -> --set.
 * @param info      what the engine reported: { defaults, base, looks: [{id, label, patch}] }
 * @param flags     { look, style, ramp, colorMode, palette, edges, invert, cols } (undefined = not given)
 * @param sets      [[key, value], ...] from --set
 */
export function resolveSettings(info, { look = DEFAULT_LOOK, flags = {}, sets = [] } = {}) {
  const state = { ...info.defaults, ...OWN_DEFAULTS };
  Object.assign(state, lookPatch(info, look));
  for (const [k, v] of Object.entries(flags)) if (v !== undefined) state[k] = v;
  for (const [k, v] of sets) state[k] = v;
  return state;
}

/** The settings a look changes. The app's presets carry the engine's reset base; ours sit on top of it. */
export function lookPatch(info, id) {
  const app = info.looks.find((l) => l.id === id);
  if (app) return { ...app.patch };
  const own = OWN_LOOKS.find((l) => l.id === id);
  if (own) return { ...info.base, ...own.patch };
  throw new UsageError(`Unknown look "${id}". See: insta-ascii --list looks`);
}

export function allLooks(info) {
  const labels = new Map([...OWN_LOOKS, ...APP_LOOKS].map((l) => [l.id, l]));
  return LOOK_IDS.map((id) => ({ id, label: labels.get(id).label, hint: labels.get(id).hint, own: OWN_LOOKS.some((l) => l.id === id) }));
}

/** Text for `insta-ascii --list <what>`. */
export function listing(what) {
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n);
  if (what === 'looks') {
    lines.push('Looks (--look <id>); the first is added by this CLI, the rest are the app\'s own presets:');
    for (const l of [...OWN_LOOKS, ...APP_LOOKS]) lines.push(`  ${pad(l.id, 18)} ${l.label}${l.hint ? ` — ${l.hint}` : ''}`);
  } else if (what === 'styles') {
    lines.push('Styles (--style <id>):');
    for (const s of STYLES) lines.push(`  ${pad(s.id, 10)} ${pad(s.label, 14)} ${s.text ? '' : '(image rendering only)'}`);
  } else if (what === 'palettes') {
    lines.push(`Palettes (--palette <id>, with --color palette): ${PALETTE_IDS.join(', ')}`);
  } else if (what === 'settings') {
    lines.push('Settings for --set key=value  (default in brackets; "text" = honoured in text rendering, "image" = needs image/blocks rendering)');
    for (const s of SECTIONS) {
      lines.push('', `${s.title}${s.own ? '  (settings of this CLI, not the app)' : s.visible ? '  (only for some styles)' : ''}`);
      for (const c of s.controls) {
        const range =
          c.type === 'range' ? `${c.min}..${c.max}` : c.type === 'toggle' ? 'on|off' : c.type === 'choice' ? c.choices.map((x) => x.value).join('|') : c.type === 'color' ? '#RRGGBB' : `text, ≤${c.max}`;
        lines.push(`  ${pad(c.key, 14)} ${pad(range, 38)} [${ALL_DEFAULTS[c.key]}]  ${c.label}${c.own ? '  (this CLI)' : c.where === 'image' ? '  (image)' : c.where === 'text~' ? '  (text: approximated)' : ''}`);
      }
    }
  } else {
    throw new UsageError('--list takes: looks, styles, palettes or settings');
  }
  return `${lines.join('\n')}\n`;
}
