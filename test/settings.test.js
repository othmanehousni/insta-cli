import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_DEFAULTS,
  APP_LOOKS,
  CONTROLS,
  CONTROL_BY_KEY,
  DEFAULTS,
  LOOK_IDS,
  OWN_LOOKS,
  PALETTE_IDS,
  OWN_DEFAULTS,
  OWN_KEYS,
  PIXEL_ONLY_STYLES,
  SECTIONS,
  STYLES,
  STYLE_IDS,
  coerce,
  listing,
  lookFor,
  lookPatch,
  parseSetting,
  resolveSettings,
  stepValue,
  visibleLayout,
} from '../src/settings.js';
import { UsageError } from '../src/util.js';

// What the engine reports, in the shape AsciiBridge.info has (used to test resolution without a browser).
const info = {
  defaults: { ...DEFAULTS },
  base: { style: 'classic', colorMode: 'mono', overlay: false, edges: false, bloom: 0, vignette: 0, underlay: 100 },
  looks: [
    { id: 'devault', label: 'Devault', patch: { style: 'classic', colorMode: 'palette', edges: true, bloom: 22, cols: 130 } },
    { id: 'film', label: 'Film', patch: { style: 'film', colorMode: 'source', animate: true } },
  ],
};

describe('the catalog covers every setting of the app', () => {
  const exportOnly = ['exportScale', 'exportSeconds']; // the app's own export dialog; handled by --out / x / r here

  it('every default setting has a control (except the export dialog\'s)', () => {
    for (const key of Object.keys(DEFAULTS)) {
      if (exportOnly.includes(key)) continue;
      assert.ok(CONTROL_BY_KEY[key], `no control for "${key}"`);
    }
  });
  it('every control has a default, a unique key, and a type its default fits', () => {
    const seen = new Set();
    for (const c of CONTROLS) {
      assert.ok(!seen.has(c.key), `duplicate ${c.key}`);
      seen.add(c.key);
      assert.ok(c.key in ALL_DEFAULTS, `${c.key} has no default`);
      const d = ALL_DEFAULTS[c.key];
      if (c.type === 'range') assert.ok(typeof d === 'number' && d >= c.min && d <= c.max, `${c.key} default ${d} outside ${c.min}..${c.max}`);
      if (c.type === 'toggle') assert.equal(typeof d, 'boolean', c.key);
      if (c.type === 'choice') assert.ok(c.choices.some((x) => x.value === d), `${c.key} default ${d} not among choices`);
      if (c.type === 'color') assert.match(d, /^#[0-9A-F]{6}$/);
    }
  });
  it('has the app\'s 13 styles, 7 palettes and 18 preset looks, plus our own', () => {
    assert.equal(STYLES.length, 13);
    assert.deepEqual(PIXEL_ONLY_STYLES, ['particle', 'film']);
    assert.equal(PALETTE_IDS.length, 7);
    assert.equal(APP_LOOKS.length, 18);
    assert.equal(LOOK_IDS.length, 20); // photo and ascii are ours
    assert.deepEqual(CONTROL_BY_KEY.style.choices.map((c) => c.value), STYLE_IDS);
    assert.deepEqual(CONTROL_BY_KEY.palette.choices.map((c) => c.value), PALETTE_IDS);
  });
  it('the sections are the app\'s, in order, with this CLI\'s text-rendering section before Effects', () => {
    assert.deepEqual(SECTIONS.map((s) => s.title), ['Style', 'Particles', 'Film', 'Letters', 'On image', 'Tone', 'Colour', 'Contours', 'Text rendering', 'Effects']);
  });
  it('the settings that only this CLI has are marked as such, and the app\'s engine never sees them', () => {
    assert.deepEqual(OWN_KEYS.sort(), ['glyphs', 'sharpen']);
    for (const k of OWN_KEYS) assert.ok(!(k in DEFAULTS), `${k} must not be one of the app's defaults`);
    assert.deepEqual(Object.keys(OWN_DEFAULTS).sort(), OWN_KEYS);
    assert.equal(ALL_DEFAULTS.glyphs, 'shape', 'shape matching is the default');
  });
});

describe('visibility follows the app\'s rules', () => {
  const titles = (state) => visibleLayout({ ...DEFAULTS, ...state }).map((s) => s.title);
  const keys = (state) => visibleLayout({ ...DEFAULTS, ...state }).flatMap((s) => s.controls.map((c) => c.key));

  it('particle shows the particle controls and none of the glyph ones', () => {
    const t = titles({ style: 'particle' });
    assert.ok(t.includes('Particles') && !t.includes('Film') && !t.includes('On image') && !t.includes('Contours'));
    assert.ok(keys({ style: 'particle' }).includes('pMelt'));
    assert.ok(!keys({ style: 'particle' }).includes('cols'));
  });
  it('film shows the film controls and no colour section', () => {
    const t = titles({ style: 'film' });
    assert.ok(t.includes('Film') && !t.includes('Colour') && !t.includes('Particles'));
  });
  it('tiles show tile gaps, soft edges and the letters section', () => {
    assert.ok(titles({ style: 'tiles' }).includes('Letters'));
    assert.ok(['tileGap', 'tileSoft', 'tileInk', 'tileAccent', 'tileFlip'].every((k) => keys({ style: 'tiles' }).includes(k)));
    assert.ok(!keys({ style: 'classic' }).includes('tileGap'));
  });
  it('custom shows the character box; dither shows its pattern; font only for font styles', () => {
    assert.ok(keys({ style: 'custom' }).includes('customRamp') && !keys({ style: 'classic' }).includes('customRamp'));
    assert.ok(keys({ style: 'dither' }).includes('ditherPattern') && !keys({ style: 'classic' }).includes('ditherPattern'));
    assert.ok(keys({ style: 'classic' }).includes('font') && !keys({ style: 'braille' }).includes('font'));
  });
  it('overlay controls appear only when the image is kept underneath', () => {
    assert.ok(!keys({ overlay: false }).includes('underlay'));
    assert.ok(['underlay', 'glyphOpacity', 'glyphFade', 'blend'].every((k) => keys({ overlay: true }).includes(k)));
  });
  it('colour controls follow the colour mode; edge controls follow the edge switch', () => {
    assert.ok(keys({ colorMode: 'mono' }).includes('monoColor') && !keys({ colorMode: 'source' }).includes('monoColor'));
    assert.ok(keys({ colorMode: 'palette' }).includes('palette') && !keys({ colorMode: 'mono' }).includes('palette'));
    assert.ok(keys({ colorMode: 'source' }).includes('boost') && !keys({ colorMode: 'palette' }).includes('boost'));
    assert.ok(keys({ bgMode: 'custom' }).includes('bgColor') && !keys({ bgMode: 'dark' }).includes('bgColor'));
    assert.ok(keys({ edges: true }).includes('edgeStrength') && !keys({ edges: false }).includes('edgeStrength'));
  });
});

describe('--set parsing', () => {
  it('parses every kind of control', () => {
    assert.deepEqual(parseSetting('underlay=60'), ['underlay', 60]);
    assert.deepEqual(parseSetting('gamma=1.25'), ['gamma', 1.25]);
    assert.deepEqual(parseSetting('brightness=-30'), ['brightness', -30]);
    assert.deepEqual(parseSetting('overlay=on'), ['overlay', true]);
    assert.deepEqual(parseSetting('edges=No'), ['edges', false]);
    assert.deepEqual(parseSetting('style=Braille'), ['style', 'braille']);
    assert.deepEqual(parseSetting('style=Shade blocks'), ['style', 'blocks']); // by label too
    assert.deepEqual(parseSetting('bgColor=ff8800'), ['bgColor', '#FF8800']);
    assert.deepEqual(parseSetting('customRamp= .oO@'), ['customRamp', '.oO@']);
  });
  it('rejects unknown keys, bad values and out-of-range numbers with a usage error', () => {
    for (const bad of ['nope=1', 'underlay', 'underlay=abc', 'underlay=101', 'underlay=', 'cols=19', 'cols=401', 'gamma=0.3', 'overlay=maybe', 'style=wobbly', 'bgColor=red', 'bgColor=#12345']) {
      assert.throws(() => parseSetting(bad), UsageError, bad);
    }
  });
  it('accepts the exact limits of every range', () => {
    for (const c of CONTROLS.filter((x) => x.type === 'range')) {
      assert.equal(coerce(c, String(c.min)), c.min, `${c.key} min`);
      assert.equal(coerce(c, String(c.max)), c.max, `${c.key} max`);
    }
  });
  it('limits the custom character box to 40 characters', () => {
    assert.throws(() => parseSetting(`customRamp=${'x'.repeat(41)}`), UsageError);
    assert.doesNotThrow(() => parseSetting(`customRamp=${'x'.repeat(40)}`));
  });
});

describe('stepValue', () => {
  it('steps ranges, clamps, and avoids float noise', () => {
    assert.equal(stepValue(CONTROL_BY_KEY.contrast, 0, 1), 1);
    assert.equal(stepValue(CONTROL_BY_KEY.contrast, 0, 1, true), 10);
    assert.equal(stepValue(CONTROL_BY_KEY.contrast, 100, 1), 100);
    assert.equal(stepValue(CONTROL_BY_KEY.cutoff, 0, -1), 0);
    assert.equal(stepValue(CONTROL_BY_KEY.gamma, 1.2, 1), 1.25);
    assert.equal(stepValue(CONTROL_BY_KEY.gamma, 0.9, 1), 0.95);
    assert.equal(stepValue(CONTROL_BY_KEY.spacing, 0.5, 1), 0.51);
  });
  it('flips toggles and cycles choices both ways', () => {
    assert.equal(stepValue(CONTROL_BY_KEY.edges, true, 1), false);
    assert.equal(stepValue(CONTROL_BY_KEY.font, 'geist', 1), 'system');
    assert.equal(stepValue(CONTROL_BY_KEY.font, 'geist', -1), 'system');
    assert.equal(stepValue(CONTROL_BY_KEY.style, 'custom', 1), 'classic');
    assert.equal(stepValue(CONTROL_BY_KEY.style, 'classic', -1), 'custom');
  });
});

describe('resolving settings', () => {
  it('layers the app\'s defaults, then the look, then flags, then --set', () => {
    const s = resolveSettings(info, { look: 'devault', flags: { style: 'braille', cols: undefined }, sets: [['cols', 99], ['bloom', 5]] });
    assert.equal(s.style, 'braille'); // flag beats look
    assert.equal(s.edges, true); // from the look
    assert.equal(s.cols, 99); // --set beats the look's 130
    assert.equal(s.bloom, 5);
    assert.equal(s.gamma, 1); // untouched default
  });
  it('an undefined flag does not clobber the look', () => {
    assert.equal(resolveSettings(info, { look: 'devault', flags: { style: undefined } }).style, 'classic');
  });
  it('our own looks sit on top of the app\'s reset base, exactly as its presets do', () => {
    const p = lookPatch(info, 'photo');
    assert.equal(p.overlay, true);
    assert.equal(p.style, 'detailed');
    assert.equal(p.bloom, 0);
    const own = OWN_LOOKS.find((l) => l.id === 'photo').patch;
    for (const [k, v] of Object.entries(own)) assert.equal(p[k], v);
    assert.equal(p.colorMode, 'source');
  });
  it('the pure-ASCII look shows only characters: no picture underneath, no outline glyphs lost', () => {
    const p = lookPatch(info, 'ascii');
    assert.equal(p.overlay, false, 'nothing of the picture shows through');
    assert.equal(p.colorMode, 'source');
    assert.equal(p.edges, true);
    assert.equal(p.bloom, 0);
    assert.equal(p.vignette, 0);
  });
  it('picking a style (or a ramp) yourself starts from the pure-ASCII look, not the photo look', () => {
    assert.equal(lookFor({}), 'photo');
    assert.equal(lookFor({ style: 'classic' }), 'ascii');
    assert.equal(lookFor({ ramp: ' .#' }), 'ascii');
    assert.equal(lookFor({ style: 'classic', look: 'photo' }), 'photo', 'an explicit look always wins');
    assert.equal(lookFor({ look: 'devault' }), 'devault');
  });
  it('shape matching is on unless asked otherwise, and --set can switch it off', () => {
    assert.equal(resolveSettings(info, { look: 'ascii' }).glyphs, 'shape');
    assert.equal(resolveSettings(info, { look: 'ascii', sets: [['glyphs', 'brightness']] }).glyphs, 'brightness');
    assert.equal(resolveSettings(info, { look: 'photo' }).sharpen, 80);
  });
  it('the app\'s looks come from the engine, not from this CLI', () => {
    assert.equal(lookPatch(info, 'film').animate, true);
  });
  it('an unknown look is a usage error', () => {
    assert.throws(() => lookPatch(info, 'nope'), UsageError);
  });
});

describe('--list', () => {
  it('lists looks, styles, palettes and every setting', () => {
    assert.match(listing('looks'), /photo.*Photo-real/);
    assert.match(listing('looks'), /halftone-gradient/);
    assert.match(listing('styles'), /particle.*image rendering only/);
    assert.match(listing('palettes'), /phosphor/);
    const settings = listing('settings');
    for (const c of CONTROLS) assert.ok(settings.includes(c.key), `--list settings is missing ${c.key}`);
  });
  it('rejects anything else', () => {
    assert.throws(() => listing('colours'), UsageError);
  });
});

describe('--set for this CLI\'s own text settings', () => {
  it('glyphs takes shape or brightness, sharpen a 0-100 number', () => {
    assert.deepEqual(parseSetting('glyphs=brightness'), ['glyphs', 'brightness']);
    assert.deepEqual(parseSetting('glyphs=Shape-matched'), ['glyphs', 'shape']);
    assert.deepEqual(parseSetting('sharpen=40'), ['sharpen', 40]);
    assert.throws(() => parseSetting('glyphs=foo'), UsageError);
    assert.throws(() => parseSetting('sharpen=101'), UsageError);
    assert.throws(() => parseSetting('sharpen=-5'), UsageError);
  });
  it('the sharpen slider only shows while characters are chosen by shape, and only for letter styles', () => {
    const keys = (state) => visibleLayout({ ...ALL_DEFAULTS, ...state }).flatMap((s) => s.controls.map((c) => c.key));
    assert.ok(keys({ style: 'classic' }).includes('sharpen'));
    assert.ok(!keys({ style: 'classic', glyphs: 'brightness' }).includes('sharpen'));
    assert.ok(keys({ style: 'classic', glyphs: 'brightness' }).includes('glyphs'));
    assert.ok(!keys({ style: 'particle' }).includes('glyphs'), 'pixel styles are not made of characters');
  });
  it('is listed, labelled as this CLI\'s own', () => {
    const l = listing('settings');
    assert.match(l, /glyphs.*\[shape\]/);
    assert.match(l, /sharpen.*\[80\]/);
    assert.match(l, /this CLI/);
    assert.match(listing('looks'), /ascii.*Pure ASCII/);
  });
});
