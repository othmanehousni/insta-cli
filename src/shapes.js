/*
 * Shape-aware glyph choice: the way to get more detail out of a fixed number of character cells.
 *
 * The usual way to turn a picture into characters (and the app's own) averages each cell to one brightness and
 * looks it up in a ramp, which treats a character as if it were a pixel of a certain grey. A character is a
 * shape. Here every cell is sampled on a small grid (3 x 6 by default) and the character whose *shape* best
 * matches that pattern is picked: `/` for a diagonal edge, `-` for a horizontal one, `.` for a speck at the
 * bottom of the cell, `'` at the top. Detail inside a cell survives instead of being averaged away.
 *
 * Tone (levels, contrast, brightness, gamma, invert, hide-shadows) and colour use the app's own formulas and
 * settings, so a look keeps looking like itself.
 */

/*
 * Tuned by measurement, not by eye. Candidates were rendered to a picture and scored against the source frame on two
 * public-domain photographs (scikit-image's astronaut and coffee), at 1/4 and 1/2 of viewing size:
 *   SSIM         structure, as a person sees it from a little way back
 *   rank corr.   does a cell's character get denser as the picture gets brighter there?
 *   edge corr.   do the edges of the picture land on the same cells?
 *   entropy      how much of the character ramp is used (a measure of tonal variety)
 * Tone is weighted 4:1 over shape. A lower ratio (2:1) scored a little higher on SSIM at 1/2 size but used much less
 * of the ramp (2.25 bits against 2.55) and read as flat; a higher one (8:1) loses more of the shape benefit. A 3 x 6
 * sample grid beat a finer 4 x 8 one, and exaggerating contrast inside the cell did not help.
 */
const TONE_WEIGHT = 6;
const SHAPE_WEIGHT = 1.5;

/*
 * The brightness the characters are matched to is lifted (ink wanted = brightness ^ 0.85). Matched 1:1, dark and
 * mid-tone cells fall back to a blank or a lone dot: shadows lose their texture and the picture reads darker than
 * the app's own mapping. Swept (SSIM at 1/4 | 1/2 size, tone weight 4:1): exponent 1.0 -> 0.251 | 0.199,
 * 0.85 -> 0.261 | 0.202, lower still gains a little at 1/4 and loses at 1/2. 0.85 keeps the average ink within
 * ~12 % of the app's own mapping (1.0 was 5-7 % below it).
 */
export const INK_GAMMA = 0.85;

/** How many character rows a picture of this shape needs at `cols` columns, given a cell's width / height. */
export const rowsFor = (srcW, srcH, cols, aspect = 0.5) => Math.max(1, Math.round((srcH / srcW) * cols * aspect));

/** Samples per cell: a cell is about twice as tall as wide, so 3 x 6 gives square samples. */
export function sampleGrid(aspect = 0.5) {
  const sh = 6;
  return { sw: Math.min(4, Math.max(2, Math.round(sh * aspect))), sh };
}

const EDGE_GLYPHS = ['-', '/', '|', '\\'];
const CLASSIC = Array.from('@%#*+=-:. ');

/**
 * The characters a style may use, densest first, and whether the app would add its outline glyphs.
 * @param style  { kind, ramp: [chars], edgeGlyphs } from the engine
 */
export function candidateChars(style, settings) {
  let ramp = style.ramp;
  let edges = style.edgeGlyphs;
  if (settings.style === 'custom') {
    ramp = Array.from(settings.customRamp ?? '').reverse(); // the app lists custom ramps sparse -> dense
    if (ramp.length < 2) ramp = CLASSIC;
    edges = true;
  }
  const chars = [...ramp];
  if (edges && settings.edges) for (const g of EDGE_GLYPHS) if (!chars.includes(g)) chars.push(g);
  if (!chars.includes(' ')) chars.push(' ');
  return chars;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Whether the app draws dark glyphs on a light page for these settings. */
export function isLightBg(settings) {
  if (settings.bgMode === 'paper') return true;
  if (settings.bgMode !== 'custom') return false;
  const m = /^#?([0-9a-f]{6})$/i.exec(settings.bgColor ?? '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.55;
}

/**
 * Luminance samples (0..255) -> ink density (0..1) with the app's tone controls: auto levels, contrast,
 * brightness, gamma, and invert (which light backgrounds imply).
 */
export function toneMap(luma, settings) {
  const n = luma.length;
  let lo = 0;
  let hi = 1;
  if (settings.autoLevels) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[luma[i]]++;
    const pct = (p) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= p * n) return v / 255;
      }
      return 1;
    };
    lo = pct(0.01);
    hi = pct(0.99);
    if (hi - lo < 0.08) {
      const mid = (hi + lo) / 2;
      lo = Math.max(0, mid - 0.04);
      hi = Math.min(1, mid + 0.04);
    }
  }
  const scale = 1 / Math.max(1e-4, hi - lo);
  const F = 2 ** (settings.contrast / 50);
  const I = settings.brightness / 200;
  const L = 1 / Math.max(0.05, settings.gamma);
  const invert = !!settings.invert !== isLightBg(settings);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let t = clamp01((luma[i] / 255 - lo) * scale);
    t = clamp01((t - 0.5) * F + 0.5 + I);
    if (L !== 1) t **= L;
    out[i] = invert ? 1 - t : t;
  }
  return out;
}

/** Unsharp mask: push each sample away from the average of its neighbours, so edges inside a cell stay crisp. */
export function sharpen(t, W, H, amount) {
  if (!(amount > 0)) return t;
  const out = new Float32Array(t.length);
  for (let y = 0; y < H; y++) {
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < H - 1 ? y + 1 : y;
    for (let x = 0; x < W; x++) {
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < W - 1 ? x + 1 : x;
      const blur =
        (t[y0 * W + x0] + t[y0 * W + x] + t[y0 * W + x1] + t[y * W + x0] + t[y * W + x] + t[y * W + x1] + t[y1 * W + x0] + t[y1 * W + x] + t[y1 * W + x1]) / 9;
      out[y * W + x] = clamp01(t[y * W + x] + amount * (t[y * W + x] - blur));
    }
  }
  return out;
}

/**
 * Raw ink coverage (0..255 per sample) -> comparable shapes. Scaled so the densest glyph's AVERAGE ink is 1: a
 * fully bright cell then maps to it, a half-bright one to something half as dense, and the whole tone range is
 * usable. (Clamping individual samples to 1 would lower that average and make everything above it saturate.)
 */
export function normalizeMasks(raw) {
  const masks = raw.map((m) => Float32Array.from(m, (v) => v / 255));
  const means = masks.map((m) => m.reduce((a, b) => a + b, 0) / m.length);
  const k = 1 / Math.max(1e-3, Math.max(...means));
  return masks.map((m) => m.map((v) => v * k));
}

/**
 * For every cell, the index of the glyph that fits it best. The fit has two parts, kept apart on purpose:
 *   tone   how far the glyph's average ink is from the cell's average brightness
 *   shape  how well the pattern of ink inside the glyph follows the pattern of light inside the cell
 * A plain least-squares fit blends them and goes wrong: a mid-density glyph such as `+` has a lot of internal
 * structure, so against a flat cell it always loses to a nearly solid glyph, and the picture saturates. Tone
 * is weighted heavily so the density is right first; shape then decides between glyphs of about that density.
 * Cells darker than `cutoff` (0..1) get `blank` (the space), like the app's "Hide shadows".
 * @returns {Int32Array} cols * rows glyph indices
 */
export function chooseGlyphs({ t, cols, rows, sw, sh, masks, blank, cutoff = 0, toneWeight = TONE_WEIGHT, shapeWeight = SHAPE_WEIGHT }) {
  const W = cols * sw;
  const n = sw * sh;
  // each glyph as (mean ink, zero-mean pattern, pattern energy)
  const glyphs = masks.map((m) => {
    const mean = m.reduce((a, b) => a + b, 0) / n;
    const d = m.map((v) => v - mean);
    return { mean, d, energy: d.reduce((a, b) => a + b * b, 0) };
  });
  const choice = new Int32Array(cols * rows);
  const d = new Float32Array(n);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let mean = 0;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const v = t[(cy * sh + y) * W + cx * sw + x];
          d[y * sw + x] = v;
          mean += v;
        }
      }
      mean /= n;
      if (mean < cutoff) {
        choice[cy * cols + cx] = blank;
        continue;
      }
      for (let i = 0; i < n; i++) d[i] -= mean;
      let best = blank;
      let bestErr = Infinity;
      for (let g = 0; g < glyphs.length; g++) {
        const gl = glyphs[g];
        let corr = 0;
        for (let i = 0; i < n; i++) corr += d[i] * gl.d[i];
        const dm = mean - gl.mean;
        // tone error + shape error: |d_cell - d_glyph|^2 expands to cell energy (constant) - 2 corr + glyph energy
        const err = toneWeight * n * dm * dm + shapeWeight * (gl.energy - 2 * corr);
        if (err < bestErr) {
          bestErr = err;
          best = g;
        }
      }
      choice[cy * cols + cx] = best;
    }
  }
  return choice;
}

const hexRgb = (hex) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [255, 255, 255];
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** A palette's 4 colour stops -> 256 colours, as the app does. */
export function paletteLut(stops) {
  const rgb = stops.map(hexRgb);
  const lut = new Uint8Array(768);
  for (let e = 0; e < 256; e++) {
    const x = (e / 255) * (rgb.length - 1);
    const i = Math.min(rgb.length - 2, Math.floor(x));
    const f = x - i;
    for (let c = 0; c < 3; c++) lut[e * 3 + c] = Math.round(rgb[i][c] + (rgb[i + 1][c] - rgb[i][c]) * f);
  }
  return lut;
}

/** The colour of one glyph, by the app's rules for source / palette / mono colour. */
export function glyphColor(settings, { r, g, b }, a, lut, lightBg) {
  if (settings.colorMode === 'mono') return hexRgb(settings.monoColor);
  if (settings.colorMode === 'palette') {
    const e = Math.min(255, Math.round((lightBg ? 0.05 + 0.35 * a : a) * 255)) * 3;
    return [lut[e], lut[e + 1], lut[e + 2]];
  }
  const F = 2 ** (settings.contrast / 50);
  const I = settings.brightness / 200;
  const G = 1 + settings.boost / 100;
  let e = (r / 255 - 0.5) * F + 0.5 + I;
  let t = (g / 255 - 0.5) * F + 0.5 + I;
  let n = (b / 255 - 0.5) * F + 0.5 + I;
  const luma = 0.299 * e + 0.587 * t + 0.114 * n;
  e = Math.max(0, luma + (e - luma) * G);
  t = Math.max(0, luma + (t - luma) * G);
  n = Math.max(0, luma + (n - luma) * G);
  const c = Math.max(e, t, n);
  const l = lightBg ? 0.72 : 0.72 + 0.28 * a;
  if (c <= 0.02) return [l * 255, l * 255, l * 255];
  const u = l / c;
  return [Math.min(255, e * u * 255), Math.min(255, t * u * 255), Math.min(255, n * u * 255)];
}

/**
 * Turn sampled cells into a glyph grid in the same shape AsciiBridge.render() returns, so it draws exactly
 * like the app's own output (colour, tint, overlay, effects).
 * @param samples { luma: Uint8Array (cols*sw x rows*sh), rgb: Uint8Array (cols x rows x 3) }
 * @param masks   normalizeMasks() output, one per entry of `chars`
 */
export function shapeGrid({ samples, cols, rows, sw, sh, chars, masks, settings, palettes = [] }) {
  const W = cols * sw;
  const H = rows * sh;
  const lightBg = isLightBg(settings);
  const tone = toneMap(samples.luma, settings);
  const t = sharpen(tone, W, H, (settings.sharpen / 100) * 1.5).map((v) => v ** INK_GAMMA);
  const blank = chars.indexOf(' ');
  const choice = chooseGlyphs({ t, cols, rows, sw, sh, masks, blank, cutoff: settings.cutoff / 100 });

  const stops = palettes.find((p) => p.id === settings.palette)?.stops ?? palettes[0]?.stops ?? ['#4A40AD', '#8A81F2', '#D0BCF7', '#F4F1FD'];
  const lut = paletteLut(stops);
  const fade = settings.overlay ? settings.glyphFade / 100 : 0;
  const lines = [];
  const fg = Buffer.alloc(cols * rows * 3);
  const alpha = Buffer.alloc(cols * rows, 255);
  const n = sw * sh;
  for (let cy = 0; cy < rows; cy++) {
    let line = '';
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx;
      line += chars[choice[idx]];
      let a = 0;
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) a += tone[(cy * sh + y) * W + cx * sw + x];
      a /= n;
      const o = idx * 3;
      const [r, g, b] = glyphColor(settings, { r: samples.rgb[o], g: samples.rgb[o + 1], b: samples.rgb[o + 2] }, a, lut, lightBg);
      fg[o] = r;
      fg[o + 1] = g;
      fg[o + 2] = b;
      if (fade > 0) alpha[idx] = Math.round(255 * (1 - fade + fade * Math.min(1, a * 1.1)));
    }
    lines.push(line);
  }
  return { cols, rows, kind: 'ramp', lines, fg, alpha, bg: null, tint: Buffer.from(samples.rgb) };
}

/** Caches glyph shapes (they only depend on the character set and the sample grid) and renders frames. */
export class ShapeRenderer {
  constructor(bridge) {
    this.bridge = bridge;
    this.cache = new Map();
  }

  /** Can this style be drawn by shape? (Only the ramp styles: the others are not made of ordinary letters.) */
  static supports(bridge, style) {
    return bridge.info.styles.find((s) => s.id === style)?.kind === 'ramp';
  }

  async #masks(chars, sw, sh) {
    const key = `${chars.join('')}|${sw}x${sh}`;
    if (!this.cache.has(key)) {
      if (this.cache.size > 12) this.cache.clear();
      this.cache.set(key, normalizeMasks(await this.bridge.glyphMasks(chars, { sw, sh })));
    }
    return this.cache.get(key);
  }

  /**
   * @param frame the captured frame
   * @param opts  { cols, rows, aspect } cell grid; aspect = cell width / cell height
   * @returns the grid, or null if there is nothing to draw
   */
  async render(frame, settings, { cols, rows, aspect = 0.5 }) {
    const style = this.bridge.info.styles.find((s) => s.id === settings.style);
    if (!style || style.kind !== 'ramp') return null;
    const { sw, sh } = sampleGrid(aspect);
    const chars = candidateChars(style, settings);
    const [masks, samples] = await Promise.all([this.#masks(chars, sw, sh), this.bridge.sampleCells(frame, { cols, rows, sw, sh })]);
    return shapeGrid({ samples, cols, rows, sw, sh, chars, masks, settings, palettes: this.bridge.info.palettes });
  }
}
