// Shape-aware glyph choice (src/shapes.js): the pure functions on hand-made data, then the whole path against the
// live Devault engine (skipped, not failed, when the app cannot be loaded).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AsciiBridge } from '../src/ascii.js';
import { launchSession } from '../src/browser.js';
import { ALL_DEFAULTS, resolveSettings } from '../src/settings.js';
import {
  INK_GAMMA,
  ShapeRenderer,
  candidateChars,
  chooseGlyphs,
  glyphColor,
  isLightBg,
  normalizeMasks,
  paletteLut,
  rowsFor,
  sampleGrid,
  shapeGrid,
  sharpen,
  toneMap,
} from '../src/shapes.js';
import { composeLines } from '../src/terminal.js';
import { discFrame, tmpDir } from './helpers.js';

/** Tone settings that change nothing: ink density = brightness. */
const NEUTRAL = {
  ...ALL_DEFAULTS,
  autoLevels: false,
  contrast: 0,
  brightness: 0,
  gamma: 1,
  invert: false,
  bgMode: 'dark',
  sharpen: 0,
  cutoff: 0,
  boost: 0,
  overlay: false,
  glyphFade: 0,
};
const bytes = (...v) => Uint8Array.from(v);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

describe('geometry helpers', () => {
  it('a cell sampled about as finely sideways as it is tall gets square samples', () => {
    assert.deepEqual(sampleGrid(0.5), { sw: 3, sh: 6 });
    assert.deepEqual(sampleGrid(0.56), { sw: 3, sh: 6 });
    assert.deepEqual(sampleGrid(0.7), { sw: 4, sh: 6 });
    assert.deepEqual(sampleGrid(0.3), { sw: 2, sh: 6 });
    assert.deepEqual(sampleGrid(), { sw: 3, sh: 6 });
  });
  it('rows follow from columns, the picture and the cell shape', () => {
    assert.equal(rowsFor(100, 200, 40), 40); // tall picture, cells twice as tall as wide
    assert.equal(rowsFor(100, 200, 40, 0.6), 48); // wider cells need more rows to cover the same picture height
    assert.equal(rowsFor(1000, 1, 10), 1, 'never zero');
  });
});

describe('candidateChars', () => {
  const classic = { ramp: Array.from('@%#*+=-:. '), edgeGlyphs: true };
  it('is the style\'s ramp, densest first, plus the outline glyphs when the style has them', () => {
    const c = candidateChars(classic, { style: 'classic', edges: true });
    assert.deepEqual(c.slice(0, 10), Array.from('@%#*+=-:. '));
    for (const g of ['/', '|', '\\']) assert.ok(c.includes(g), g);
    assert.equal(new Set(c).size, c.length, 'no duplicates');
  });
  it('leaves the outline glyphs out when edges are off or the style does not use them', () => {
    assert.deepEqual(candidateChars(classic, { style: 'classic', edges: false }), Array.from('@%#*+=-:. '));
    assert.ok(!candidateChars({ ramp: ['#', '.'], edgeGlyphs: false }, { style: 'binary', edges: true }).includes('/'));
  });
  it('always includes a blank, the glyph for "nothing here"', () => {
    assert.ok(candidateChars({ ramp: ['#', '.'], edgeGlyphs: false }, { style: 'binary', edges: false }).includes(' '));
  });
  it('a custom ramp is listed sparse -> dense by the app, and reversed here', () => {
    const c = candidateChars({ ramp: ['x'], edgeGlyphs: false }, { style: 'custom', customRamp: ' .:#@', edges: false });
    assert.deepEqual(c, ['@', '#', ':', '.', ' ']);
  });
  it('a custom ramp that is too short falls back to a sensible one instead of breaking', () => {
    const c = candidateChars({ ramp: [], edgeGlyphs: false }, { style: 'custom', customRamp: '#', edges: false });
    assert.ok(c.length >= 5 && c.includes('@'));
  });
});

describe('tone', () => {
  const luma = Uint8Array.from([0, 64, 128, 192, 255]);
  it('with neutral settings, ink density is brightness', () => {
    const t = toneMap(luma, NEUTRAL);
    luma.forEach((v, i) => close(t[i], v / 255, 1e-6));
  });
  it('invert flips it', () => {
    const t = toneMap(luma, { ...NEUTRAL, invert: true });
    luma.forEach((v, i) => close(t[i], 1 - v / 255, 1e-6));
  });
  it('a light background means dark ink, so it inverts too (and invert undoes that)', () => {
    close(toneMap(luma, { ...NEUTRAL, bgMode: 'paper' })[4], 0);
    close(toneMap(luma, { ...NEUTRAL, bgMode: 'paper', invert: true })[4], 1);
  });
  it('brightness lifts, contrast spreads, gamma bends', () => {
    const base = toneMap(Uint8Array.of(128), NEUTRAL)[0];
    assert.ok(toneMap(Uint8Array.of(128), { ...NEUTRAL, brightness: 40 })[0] > base);
    assert.ok(toneMap(Uint8Array.of(200), { ...NEUTRAL, contrast: 50 })[0] > toneMap(Uint8Array.of(200), NEUTRAL)[0]);
    assert.ok(toneMap(Uint8Array.of(60), { ...NEUTRAL, contrast: 50 })[0] < toneMap(Uint8Array.of(60), NEUTRAL)[0]);
    assert.ok(toneMap(Uint8Array.of(128), { ...NEUTRAL, gamma: 2 })[0] > base, 'gamma above 1 brightens the mid-tones');
  });
  it('auto levels stretch a flat, dim picture over the whole range', () => {
    const dim = Uint8Array.from({ length: 200 }, (_, i) => 60 + (i % 40)); // 60..99 only
    const t = toneMap(dim, { ...NEUTRAL, autoLevels: true });
    assert.ok(Math.max(...t) > 0.95 && Math.min(...t) < 0.05, `${Math.min(...t)}..${Math.max(...t)}`);
  });
  it('auto levels leave a perfectly flat picture alone instead of dividing by nothing', () => {
    const t = toneMap(new Uint8Array(50).fill(100), { ...NEUTRAL, autoLevels: true });
    assert.ok([...t].every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  });
  it('knows which backgrounds are light', () => {
    assert.equal(isLightBg({ bgMode: 'paper' }), true);
    assert.equal(isLightBg({ bgMode: 'dark' }), false);
    assert.equal(isLightBg({ bgMode: 'custom', bgColor: '#FFFFFF' }), true);
    assert.equal(isLightBg({ bgMode: 'custom', bgColor: '#101018' }), false);
    assert.equal(isLightBg({ bgMode: 'custom', bgColor: 'not a colour' }), false);
  });
});

describe('sharpen', () => {
  // a vertical step edge, 6 wide x 2 tall
  const step = Float32Array.from([0.2, 0.2, 0.2, 0.8, 0.8, 0.8, 0.2, 0.2, 0.2, 0.8, 0.8, 0.8]);
  it('does nothing at zero', () => assert.equal(sharpen(step, 6, 2, 0), step));
  it('makes an edge steeper: the dark side darker, the bright side brighter', () => {
    const s = sharpen(step, 6, 2, 1);
    assert.ok(s[2] < step[2] && s[3] > step[3]);
  });
  it('leaves flat areas as they were', () => {
    const flat = new Float32Array(12).fill(0.5);
    sharpen(flat, 6, 2, 1.5).forEach((v) => close(v, 0.5));
  });
  it('never leaves 0..1', () => {
    const s = sharpen(step, 6, 2, 50);
    assert.ok([...s].every((v) => v >= 0 && v <= 1));
  });
});

describe('normalizeMasks', () => {
  it('scales so the densest glyph\'s average ink is exactly 1, and keeps the ratios between glyphs', () => {
    const [a, b] = normalizeMasks([bytes(255, 255, 255, 0), bytes(255, 0, 0, 0)]); // means 0.75 and 0.25
    const mean = (m) => m.reduce((x, y) => x + y, 0) / m.length;
    close(mean(a), 1);
    close(mean(b), 1 / 3);
  });
  it('does not clamp single samples: that would lower the densest glyph\'s mean and saturate the picture to it', () => {
    // Regression. Clamping after scaling gave the densest glyph an effective mean of ~0.66, so bright cells
    // all matched it ("@@@@") and the tone range above it was lost.
    const [a] = normalizeMasks([bytes(255, 255, 255, 0)]);
    assert.ok(Math.max(...a) > 1, `max sample ${Math.max(...a)}`);
  });
  it('copes with a character set that is all blank', () => {
    const [m] = normalizeMasks([bytes(0, 0, 0, 0)]);
    assert.ok([...m].every((v) => Number.isFinite(v) && v === 0));
  });
});

describe('chooseGlyphs', () => {
  // 2 x 2 samples per cell. Glyphs: blank, solid, and four half-filled ones that differ only in shape.
  const sw = 2;
  const sh = 2;
  const chars = [' ', '#', '_', "'", '|'];
  const masks = [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 1, 1], [1, 1, 0, 0], [1, 0, 1, 0]].map((m) => Float32Array.from(m));
  const pick = (cell, extra = {}) => chars[chooseGlyphs({ t: Float32Array.from(cell), cols: 1, rows: 1, sw, sh, masks, blank: 0, ...extra })[0]];

  it('white is the solid glyph, black is blank', () => {
    assert.equal(pick([1, 1, 1, 1]), '#');
    assert.equal(pick([0, 0, 0, 0]), ' ');
  });
  it('picks the glyph whose shape matches where the light is', () => {
    assert.equal(pick([0, 0, 1, 1]), '_', 'light at the bottom');
    assert.equal(pick([1, 1, 0, 0]), "'", 'light at the top');
    assert.equal(pick([1, 0, 1, 0]), '|', 'light on the left');
  });
  it('a flat mid-grey cell takes a half-ink glyph, not the solid or the blank one', () => {
    const g = pick([0.5, 0.5, 0.5, 0.5]);
    assert.ok(['_', "'", '|'].includes(g), g);
  });
  it('tone comes before shape: a bright cell with a little texture stays near-solid', () => {
    assert.equal(pick([1, 1, 0.9, 1]), '#');
  });
  it('cells darker than the cut-off are left blank (the app\'s "Hide shadows")', () => {
    assert.equal(pick([0.08, 0.1, 0.1, 0.12], { cutoff: 0.2 }), ' ');
    assert.notEqual(pick([0.4, 0.4, 0.5, 0.5], { cutoff: 0.2 }), ' ');
  });
  it('handles several cells, each on its own', () => {
    // two cells side by side: white | black   (row-major samples: the picture is 4 wide x 2 tall)
    const t = Float32Array.from([1, 1, 0, 0, 1, 1, 0, 0]);
    const out = chooseGlyphs({ t, cols: 2, rows: 1, sw, sh, masks, blank: 0 });
    assert.deepEqual([...out].map((i) => chars[i]), ['#', ' ']);
  });
});

describe('colour', () => {
  const settings = { ...NEUTRAL, colorMode: 'source', boost: 0 };
  it('mono is the chosen colour, whatever the picture is', () => {
    assert.deepEqual(glyphColor({ ...settings, colorMode: 'mono', monoColor: '#FF8800' }, { r: 1, g: 2, b: 3 }, 0.5, null, false), [255, 136, 0]);
  });
  it('palette walks the palette by ink density', () => {
    const lut = paletteLut(['#000000', '#FF0000', '#00FF00', '#0000FF']);
    assert.equal(lut.length, 768);
    assert.deepEqual([...lut.slice(0, 3)], [0, 0, 0]);
    assert.deepEqual([...lut.slice(765)], [0, 0, 255]);
    const at = (a) => glyphColor({ ...settings, colorMode: 'palette' }, { r: 0, g: 0, b: 0 }, a, lut, false);
    assert.deepEqual(at(0), [0, 0, 0]);
    assert.deepEqual(at(1), [0, 0, 255]);
    assert.ok(at(1 / 3)[0] > 240, 'a third of the way is the second stop');
  });
  it('source keeps the picture\'s hue', () => {
    const [r, g, b] = glyphColor(settings, { r: 250, g: 20, b: 20 }, 1, null, false);
    assert.ok(r > g * 3 && r > b * 3, `${r},${g},${b}`);
    assert.equal(Math.round(r), 255, 'the strongest channel is lifted to full brightness');
  });
  it('source: a bright cell gets a bright letter, a dim one a dimmer letter, and nothing is ever black on black', () => {
    const bright = glyphColor(settings, { r: 200, g: 200, b: 200 }, 1, null, false);
    const dim = glyphColor(settings, { r: 200, g: 200, b: 200 }, 0, null, false);
    assert.ok(bright[0] > dim[0]);
    assert.ok(dim[0] > 120, 'a dim letter is still readable');
  });
  it('on a light background the letters are darker', () => {
    const dark = glyphColor(settings, { r: 200, g: 100, b: 50 }, 1, null, true);
    const light = glyphColor(settings, { r: 200, g: 100, b: 50 }, 1, null, false);
    assert.ok(Math.max(...dark) < Math.max(...light));
  });
});

describe('shapeGrid', () => {
  const chars = [' ', '#'];
  const masks = [Float32Array.of(0, 0, 0, 0), Float32Array.of(1, 1, 1, 1)];
  // two cells (2 x 2 samples each): the left one white, the right one black
  const luma = Uint8Array.from([255, 255, 0, 0, 255, 255, 0, 0]);
  const rgb = Uint8Array.from([255, 255, 255, 0, 0, 0]);
  const grid = (settings) => shapeGrid({ samples: { luma, rgb }, cols: 2, rows: 1, sw: 2, sh: 2, chars, masks, settings, palettes: [] });

  it('has the same shape as the engine\'s grid, so it draws the same way', () => {
    const g = grid({ ...NEUTRAL, colorMode: 'mono', monoColor: '#FF0000' });
    assert.deepEqual([g.cols, g.rows, g.kind], [2, 1, 'ramp']);
    assert.deepEqual(g.lines, ['# ']);
    assert.equal(g.fg.length, 6);
    assert.deepEqual([...g.fg.slice(0, 3)], [255, 0, 0]);
    assert.equal(g.alpha.length, 2);
    assert.equal(g.bg, null);
    assert.deepEqual([...g.tint], [...rgb], 'the picture\'s own cell colours ride along for the overlay');
  });
  it('invert swaps ink and paper', () => {
    assert.deepEqual(grid({ ...NEUTRAL, invert: true, colorMode: 'mono', monoColor: '#FFFFFF' }).lines, [' #']);
  });
  it('with the picture overlaid, dim letters fade (glyph fade) and bright ones do not', () => {
    const g = grid({ ...NEUTRAL, overlay: true, glyphFade: 100, colorMode: 'mono', monoColor: '#FFFFFF' });
    assert.equal(g.alpha[0], 255);
    assert.equal(g.alpha[1], 0);
    assert.ok(grid({ ...NEUTRAL, overlay: false, glyphFade: 100, colorMode: 'mono', monoColor: '#FFFFFF' }).alpha.every((a) => a === 255), 'no fade without the overlay');
  });
  it('colours each letter from the picture in source mode', () => {
    const g = shapeGrid({
      samples: { luma, rgb: Uint8Array.from([255, 30, 30, 0, 0, 0]) },
      cols: 2, rows: 1, sw: 2, sh: 2, chars, masks, settings: { ...NEUTRAL, colorMode: 'source' }, palettes: [],
    });
    assert.ok(g.fg[0] > g.fg[1] * 3, 'the first letter is red');
  });
  it('dark cells keep a faint character instead of going blank, so shadows keep their texture', () => {
    // A cell at 12 % brightness. Matched exactly it is closer to blank (0) than to the faint glyph (0.3); lifted by
    // INK_GAMMA it wants about 0.17, which the faint glyph fits better. Without the lift, shadows drop out.
    assert.ok(INK_GAMMA < 1 && INK_GAMMA > 0.5, `${INK_GAMMA}`);
    const faint = [Float32Array.of(0, 0, 0, 0), Float32Array.of(0.3, 0.3, 0.3, 0.3), Float32Array.of(1, 1, 1, 1)];
    const g = shapeGrid({
      samples: { luma: new Uint8Array(4).fill(31), rgb: Uint8Array.of(31, 31, 31) },
      cols: 1, rows: 1, sw: 2, sh: 2, chars: [' ', ':', '#'], masks: faint, settings: { ...NEUTRAL, colorMode: 'mono', monoColor: '#FFFFFF' }, palettes: [],
    });
    assert.deepEqual(g.lines, [':']);
  });
  it('is accepted by the terminal renderer, plain and in colour', () => {
    const g = grid({ ...NEUTRAL, colorMode: 'source' });
    assert.deepEqual(composeLines(g, NEUTRAL, { depth: 'none' }), ['#']);
    const [line] = composeLines(g, NEUTRAL, { depth: 'truecolor' });
    assert.match(line, /\x1b\[[\d;]*38;2;/);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** A horizontal brightness ramp, dark on the left to white on the right. */
function gradientFrame(w = 120, h = 90) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([0, 0, 0, 255], (y * w + x) * 4), px.fill(Math.round((x / (w - 1)) * 255), (y * w + x) * 4, (y * w + x) * 4 + 3);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return { kind: 'rgba', w, h, data: px.toString('base64') };
}

/** Diagonal bars: detail finer than one character cell, with a direction. */
function stripesFrame(w = 120, h = 90) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (x + y) % 12 < 4 ? 255 : 20;
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return { kind: 'rgba', w, h, data: px.toString('base64') };
}

describe('shape matching against the live Devault engine', () => {
  let session;
  let bridge;
  let skipReason = null;

  before(async () => {
    session = await launchSession({ profileDir: tmpDir() });
    try {
      bridge = await AsciiBridge.open(session.context, {});
    } catch (err) {
      skipReason = `Devault ASCII app unavailable: ${err.message}`;
    }
  });
  after(async () => {
    await bridge?.close();
    await session?.close();
  });

  const settingsFor = (look = 'ascii', sets = {}) => resolveSettings(bridge.info, { look, sets: Object.entries(sets) });
  const lines = (grid) => grid.lines.join('');

  describe('what the engine tells us', () => {
    it('reports every style\'s ramp and whether it draws outline glyphs, and every palette\'s colours', (t) => {
      if (skipReason) return t.skip(skipReason);
      const classic = bridge.info.styles.find((s) => s.id === 'classic');
      assert.equal(classic.kind, 'ramp');
      assert.ok(Array.isArray(classic.ramp) && classic.ramp.length >= 5, 'a ramp of characters');
      assert.equal(typeof classic.edgeGlyphs, 'boolean');
      assert.ok(bridge.info.palettes.every((p) => p.stops.length === 4 && p.stops.every((c) => /^#[0-9a-f]{6}$/i.test(c))));
    });
    it('only the ramp styles are drawn by shape', (t) => {
      if (skipReason) return t.skip(skipReason);
      for (const s of bridge.info.styles) assert.equal(ShapeRenderer.supports(bridge, s.id), s.kind === 'ramp', s.id);
      for (const id of ['classic', 'detailed', 'minimal', 'binary']) assert.equal(ShapeRenderer.supports(bridge, id), true, id);
      for (const id of ['particle', 'film']) assert.equal(ShapeRenderer.supports(bridge, id), false, id);
      assert.equal(ShapeRenderer.supports(bridge, 'no-such-style'), false);
    });
  });

  describe('sampling and glyph shapes', () => {
    it('samples every cell on a grid and gives each cell\'s average colour', async (t) => {
      if (skipReason) return t.skip(skipReason);
      const disc = discFrame({ w: 120, h: 120 });
      const s = await bridge.sampleCells(disc, { cols: 10, rows: 10, sw: 3, sh: 6 });
      assert.equal(s.luma.length, 10 * 3 * 10 * 6);
      assert.equal(s.rgb.length, 10 * 10 * 3);
      assert.equal(s.luma[0], 0, 'the corner is background');
      assert.ok(s.luma[(5 * 6 + 3) * 30 + 5 * 3 + 1] > 240, 'the middle is the white disc');
      assert.deepEqual([...s.rgb.slice(0, 3)], [0, 0, 0]);
      const mid = (5 * 10 + 5) * 3;
      assert.ok(s.rgb[mid] > 240 && s.rgb[mid + 1] > 240 && s.rgb[mid + 2] > 240);
    });
    it('rasterises characters as ink coverage: blank is empty, @ is denser than a dot, a dash sits in the middle, a bar stands up', async (t) => {
      if (skipReason) return t.skip(skipReason);
      const sw = 3;
      const sh = 6;
      const [blank, at, dot, dash, bar] = await bridge.glyphMasks([' ', '@', '.', '-', '|'], { sw, sh });
      for (const m of [blank, at, dot, dash, bar]) assert.equal(m.length, sw * sh);
      const sum = (m) => m.reduce((a, b) => a + b, 0);
      assert.equal(sum(blank), 0);
      assert.ok(sum(at) > sum(dot) * 2, `@ ${sum(at)} vs . ${sum(dot)}`);
      const row = (m, y) => m.slice(y * sw, y * sw + sw).reduce((a, b) => a + b, 0);
      const col = (m, x) => Array.from({ length: sh }, (_, y) => m[y * sw + x]).reduce((a, b) => a + b, 0);
      const middleRows = row(dash, 2) + row(dash, 3);
      assert.ok(middleRows > (row(dash, 0) + row(dash, 5)) * 3, 'a dash is a horizontal mark at mid-height');
      assert.ok(col(bar, 1) > col(bar, 0) && col(bar, 1) > col(bar, 2), 'a bar is a vertical mark through the middle');
      assert.ok(row(dot, 4) + row(dot, 5) > row(dot, 0) + row(dot, 1), 'a dot sits low in the cell');
    });
  });

  describe('rendering', () => {
    it('gives a grid of the size asked for, made only of the style\'s own characters', async (t) => {
      if (skipReason) return t.skip(skipReason);
      const settings = settingsFor('ascii', { style: 'classic' });
      await bridge.configure(settings);
      const grid = await new ShapeRenderer(bridge).render(gradientFrame(), settings, { cols: 60, rows: 22, aspect: 0.5 });
      assert.equal(grid.cols, 60);
      assert.equal(grid.rows, 22);
      assert.equal(grid.lines.length, 22);
      assert.ok(grid.lines.every((l) => Array.from(l).length === 60));
      const style = bridge.info.styles.find((s) => s.id === 'classic');
      const allowed = new Set(candidateChars(style, settings));
      for (const ch of lines(grid)) assert.ok(allowed.has(ch), `unexpected character ${JSON.stringify(ch)}`);
      assert.equal(grid.fg.length, 60 * 22 * 3);
    });

    it('every ramp style stays within its own characters', async (t) => {
      if (skipReason) return t.skip(skipReason);
      for (const style of bridge.info.styles.filter((s) => s.kind === 'ramp')) {
        const settings = settingsFor('ascii', { style: style.id });
        const grid = await new ShapeRenderer(bridge).render(discFrame({ w: 120, h: 90 }), settings, { cols: 40, rows: 15, aspect: 0.5 });
        const allowed = new Set(candidateChars(style, settings));
        for (const ch of lines(grid)) assert.ok(allowed.has(ch), `${style.id}: unexpected ${JSON.stringify(ch)}`);
        assert.ok(new Set(lines(grid)).size >= 2, `${style.id} drew something`);
      }
    });

    it('does not saturate: a smooth ramp from black to white uses the whole range of the ramp, in order', async (t) => {
      if (skipReason) return t.skip(skipReason);
      // Regression for the first version, which turned every bright cell into the densest character.
      const settings = settingsFor('ascii', { style: 'classic', contrast: 0, cutoff: 0, edges: false, sharpen: 0 });
      await bridge.configure(settings);
      const grid = await new ShapeRenderer(bridge).render(gradientFrame(160, 90), settings, { cols: 80, rows: 30, aspect: 0.5 });
      const classic = Array.from('@%#*+=-:. ');
      const rank = (ch) => classic.indexOf(ch); // 0 = densest
      const band = (from, to) => {
        let sum = 0;
        let n = 0;
        for (const l of grid.lines) for (const ch of Array.from(l).slice(from, to)) (sum += rank(ch)), n++;
        return sum / n;
      };
      const [q1, q2, q3, q4] = [band(0, 20), band(20, 40), band(40, 60), band(60, 80)];
      assert.ok(q1 > q2 && q2 > q3 && q3 > q4, `average rank by quarter, dark to bright: ${[q1, q2, q3, q4].map((v) => v.toFixed(1)).join(' > ')}`);
      const atShare = [...lines(grid)].filter((c) => c === '@').length / lines(grid).length;
      assert.ok(atShare < 0.3, `${(atShare * 100).toFixed(0)}% of the picture is "@"`);
      // Not all ten: characters with a lot of internal structure (+ - : #) lose to plainer ones in a perfectly smooth
      // area, where there is no pattern for them to follow. That costs some tonal steps in smooth areas (the SSIM
      // measurements in the README show it is a good trade overall), but it must never collapse to a handful.
      assert.ok(new Set(lines(grid)).size >= 5, `only ${[...new Set(lines(grid))].join('')} used`);
    });

    it('tells apart pictures of the same brightness but different structure: horizontal bars and vertical bars get different characters', async (t) => {
      if (skipReason) return t.skip(skipReason);
      // 120 x 90 px in 40 x 15 cells = 3 x 6 px per cell, so the bars sit in the middle of every cell. Same average
      // brightness either way: a mapping from brightness alone would draw the two identically.
      const bars = (inBar) => {
        const w = 120;
        const h = 90;
        const px = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(inBar(x, y) ? [255, 255, 255, 255] : [10, 10, 10, 255], (y * w + x) * 4);
        return { kind: 'rgba', w, h, data: px.toString('base64') };
      };
      const settings = settingsFor('ascii', { style: 'classic', edges: false, contrast: 0, cutoff: 0 });
      await bridge.configure(settings);
      const r = new ShapeRenderer(bridge);
      const dominant = (grid) => {
        const n = new Map();
        for (const ch of lines(grid)) n.set(ch, (n.get(ch) ?? 0) + 1);
        const [ch, count] = [...n].sort((a, b) => b[1] - a[1])[0];
        return { ch, share: count / lines(grid).length };
      };
      const horizontal = dominant(await r.render(bars((x, y) => y % 6 === 2 || y % 6 === 3), settings, { cols: 40, rows: 15, aspect: 0.5 }));
      const vertical = dominant(await r.render(bars((x) => x % 3 === 1), settings, { cols: 40, rows: 15, aspect: 0.5 }));
      assert.notEqual(horizontal.ch, vertical.ch, `both came out as ${JSON.stringify(horizontal.ch)}`);
      assert.ok(horizontal.share > 0.7 && vertical.share > 0.7, `${JSON.stringify(horizontal)} ${JSON.stringify(vertical)}`);
    });

    it('rebuilds a picture more faithfully than the brightness-only mapping (fewer errors inside each cell)', async (t) => {
      if (skipReason) return t.skip(skipReason);
      // Rebuild each result from the characters' own shapes and compare with the picture at 3 x 6 samples per cell,
      // the resolution the matcher works at. The comparison is of the PATTERN: each rebuild is first fitted to the
      // picture by the best brightness scale and offset, so overall exposure does not count (the two mappings do not
      // aim at quite the same exposure). Shape matching optimises this directly, so it must win; if it does not, the
      // matcher is broken. How the result LOOKS is judged separately, with SSIM: see the README.
      const frame = stripesFrame(120, 90);
      const settings = settingsFor('ascii', { style: 'classic', edges: false, sharpen: 0, contrast: 0, cutoff: 0, autoLevels: false });
      await bridge.configure(settings);
      const cols = 40;
      const rows = 15;
      const sw = 3;
      const sh = 6;
      const samples = await bridge.sampleCells(frame, { cols, rows, sw, sh });
      const target = toneMap(samples.luma, settings);
      const shaped = await new ShapeRenderer(bridge).render(frame, settings, { cols, rows, aspect: 0.5 });
      const engine = await bridge.render(frame, { cols, time: 0, color: false });

      const set = [...new Set([...lines(shaped), ...lines(engine)])];
      const norm = normalizeMasks(await bridge.glyphMasks(set, { sw, sh }));
      const masks = new Map(set.map((ch, i) => [ch, norm[i]]));
      const rebuild = (grid) => {
        const img = new Float32Array(cols * sw * rows * sh);
        for (let cy = 0; cy < rows; cy++) {
          const row = Array.from(grid.lines[cy]);
          for (let cx = 0; cx < cols; cx++) {
            const m = masks.get(row[cx] ?? ' ');
            for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) img[(cy * sh + y) * cols * sw + cx * sw + x] = Math.min(1, m[y * sw + x]);
          }
        }
        return img;
      };
      const residual = (img) => {
        const n = img.length;
        const mx = img.reduce((a, b) => a + b, 0) / n;
        const my = target.reduce((a, b) => a + b, 0) / n;
        let sxy = 0;
        let sxx = 0;
        let syy = 0;
        for (let i = 0; i < n; i++) (sxy += (img[i] - mx) * (target[i] - my)), (sxx += (img[i] - mx) ** 2), (syy += (target[i] - my) ** 2);
        return (syy - (sxy * sxy) / Math.max(sxx, 1e-9)) / n; // what is left after the best linear fit
      };
      const [eShape, eEngine] = [residual(rebuild(shaped)), residual(rebuild(engine))];
      assert.ok(eShape < eEngine * 0.9, `shape-matched error ${eShape.toFixed(4)} vs brightness-only ${eEngine.toFixed(4)}`);
    });

    it('draws through the terminal renderer: pure ASCII has no tinted cell backgrounds, the photo look does', async (t) => {
      if (skipReason) return t.skip(skipReason);
      const frame = gradientFrame(120, 90);
      const draw = async (look) => {
        const settings = settingsFor(look, { style: 'classic' });
        await bridge.configure(settings);
        const grid = await new ShapeRenderer(bridge).render(frame, settings, { cols: 40, rows: 15, aspect: 0.5 });
        return composeLines(grid, settings, { depth: 'truecolor' }).join('\n');
      };
      const backgrounds = (s) => new Set([...s.matchAll(/\x1b\[(?:[\d;]*;)?48;2;(\d+;\d+;\d+)/g)].map((m) => m[1]));
      assert.equal(backgrounds(await draw('ascii')).size, 1, 'one plain backdrop colour, nothing of the picture behind the letters');
      assert.ok(backgrounds(await draw('photo')).size > 5, 'the photo look tints each cell with the picture');
    });

    it('works out each character\'s shape once per character set and cell grid, not once per frame', async (t) => {
      if (skipReason) return t.skip(skipReason);
      let calls = 0;
      const spy = {
        info: bridge.info,
        sampleCells: (...a) => bridge.sampleCells(...a),
        glyphMasks: (...a) => (calls++, bridge.glyphMasks(...a)),
      };
      const settings = settingsFor('ascii', { style: 'classic' });
      const r = new ShapeRenderer(spy);
      for (let i = 0; i < 3; i++) await r.render(discFrame({ w: 60, h: 60 }), settings, { cols: 20, rows: 10, aspect: 0.5 });
      assert.equal(calls, 1);
      await r.render(discFrame({ w: 60, h: 60 }), { ...settings, style: 'binary' }, { cols: 20, rows: 10, aspect: 0.5 });
      assert.equal(calls, 2, 'a different character set needs its own shapes');
      await r.render(discFrame({ w: 60, h: 60 }), settings, { cols: 20, rows: 10, aspect: 0.6 });
      assert.equal(calls, 3, 'and so does a different cell shape');
    });

    it('declines styles that are not made of characters', async (t) => {
      if (skipReason) return t.skip(skipReason);
      const settings = settingsFor('ascii', { style: 'particle' });
      assert.equal(await new ShapeRenderer(bridge).render(discFrame({ w: 60, h: 60 }), settings, { cols: 20, rows: 10 }), null);
    });
  });
});
