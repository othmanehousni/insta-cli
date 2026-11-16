const ESC = '\x1b[';

/**
 * Largest column count whose rendered height still fits the area.
 * A cell is `aspect` as wide as it is tall (about 0.5 in most terminals), so a source of srcW x srcH needs
 * round(srcH / srcW * cols * aspect) rows.
 */
export function fitCols({ termCols, termRows, srcW, srcH, maxCols, reserveRows = 1, aspect = 0.5 }) {
  const availRows = Math.max(1, termRows - reserveRows);
  const byHeight = Math.floor((availRows * srcW) / (srcH * aspect));
  const limit = Math.min(termCols, byHeight, maxCols ?? Infinity);
  return Math.max(8, limit);
}

/** Cell width / height from the terminal's reported cell size in pixels; null/garbage gives the usual 0.5. */
export function cellAspect(cell) {
  if (!cell || !(cell.w > 0) || !(cell.h > 0)) return 0.5;
  return Math.min(0.8, Math.max(0.35, cell.w / cell.h));
}

/**
 * Cells a picture of srcW x srcH occupies when it must fit an area of availCols x availRows cells,
 * given the pixel size of one cell (cellW x cellH). Keeps the picture's aspect ratio.
 */
export function fitBox({ availCols, availRows, srcW, srcH, cellW = 9, cellH = 18 }) {
  const scale = Math.min((availCols * cellW) / srcW, (availRows * cellH) / srcH);
  const cols = Math.max(1, Math.min(availCols, Math.round((srcW * scale) / cellW)));
  const rows = Math.max(1, Math.min(availRows, Math.round((srcH * scale) / cellH)));
  return { cols, rows, pxW: Math.round(srcW * scale), pxH: Math.round(srcH * scale) };
}

/** 'truecolor' | '256' | 'none', from flags + environment. */
export function detectDepth(requested = 'auto', env = process.env, isTTY = process.stdout.isTTY) {
  if (requested === 'truecolor' || requested === '256') return requested;
  if (requested === 'none') return 'none';
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return 'none';
  if (!isTTY) return 'none';
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return 'truecolor';
  return '256';
}

export function rgbTo256(r, g, b) {
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    const gray = Math.round((r + g + b) / 3);
    if (gray < 8) return 16;
    if (gray > 248) return 231;
    return 232 + Math.round(((gray - 8) / 247) * 23);
  }
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/**
 * How strongly letters stand out when the picture is kept underneath. The app draws thin glyphs a few
 * pixels wide; a terminal letter covers far more of its cell, so its contrast has to be calibrated down
 * for the picture to stay readable. gain/lift set the letter's brightness relative to the picture under
 * it; strength scales the whole glyph blend (on top of the app's own Glyph opacity); underlayCurve
 * lifts the app's Image visibility (0 and 100 stay put, 45 becomes ~85) because big letters hide more
 * of the picture than thin strokes. Found by comparing renders of a real photo at 1:1.
 */
export const TEXT_TUNING = { gain: 1.12, lift: 6, strength: 0.7, underlayCurve: 0.2 };

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : [13, 13, 18];
};

/** The app's backdrop colour for this state, or null for "Clear" (leave the terminal's own background). */
export function backdrop(settings) {
  switch (settings.bgMode) {
    case 'transparent':
      return null;
    case 'black':
      return [0, 0, 0];
    case 'paper':
      return [242, 239, 232];
    case 'custom':
      return hexToRgb(settings.bgColor);
    default:
      return [13, 13, 18];
  }
}

const sgrColor = (kind, rgb, depth) =>
  depth === 'truecolor' ? `${kind === 'fg' ? 38 : 48};2;${rgb[0]};${rgb[1]};${rgb[2]}` : `${kind === 'fg' ? 38 : 48};5;${rgbTo256(rgb[0], rgb[1], rgb[2])}`;

// Cheap deterministic noise in [0, 1) for grain and flicker.
const hash = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Turn a grid from AsciiBridge.render() into printable lines, using the app's own settings.
 *
 * - "Keep the image underneath" (overlay): every cell's background is the picture's colour scaled by
 *   `underlay`, and the glyph is blended over it by `glyphOpacity` and the shadow fade.
 * - Otherwise the picture sits on the app's backdrop (bgMode) like it does on the site.
 * - Letter tiles draw their own tile colour behind the letter.
 * - Vignette, scanlines, grain and flicker are emulated per cell. Bloom, curvature and chromatic
 *   aberration are pixel effects and only exist in image rendering.
 *
 * depth 'none' (or no colour data) gives plain text with trailing blanks trimmed.
 * fromCol skips the columns to the left of it (Compare draws the original there instead).
 */
export function composeLines(grid, settings, { depth = 'truecolor', time = 0, frameNo = 0, fromCol = 0 } = {}) {
  const { lines, cols, rows } = grid;
  if (depth === 'none' || !grid.fg) return lines.map((l) => l.replace(/\s+$/, ''));

  const S = settings;
  const back = backdrop(S);
  const overlay = !!S.overlay && !!grid.tint;
  const under = Math.min(1, Math.max(0, S.underlay / 100)) ** TEXT_TUNING.underlayCurve;
  const glyphOpacity = overlay ? Math.min(1, Math.max(0, S.glyphOpacity / 100)) : 1;
  const F = 2 ** (S.contrast / 50);
  const I = S.brightness / 200;
  const L = 1 / Math.max(0.05, S.gamma);
  const vignette = S.vignette / 100;
  const scan = S.scanlines / 100;
  const grain = S.grain / 100;
  const flicker = S.flicker / 100;
  const animated = !!S.animate;
  const frameGain = flicker > 0 && animated ? 1 - flicker * 0.14 * hash(frameNo * 3.7) : 1;
  const noiseSeed = animated ? Math.floor(time * 12) : 0;

  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  return lines.map((line, r) => {
    const chars = Array.from(line);
    let out = '';
    let curFg = '';
    let curBg = '';
    for (let c = fromCol; c < cols; c++) {
      const n = r * cols + c;
      const ch = chars[c] ?? ' ';
      const glyph = ch !== ' ';

      // ---- the picture's own colour under this cell, with the app's tone controls applied
      let tone = null;
      if (overlay) {
        tone = [grid.tint[n * 3], grid.tint[n * 3 + 1], grid.tint[n * 3 + 2]].map((v) => {
          const x = (v / 255 - 0.5) * F + 0.5 + I;
          return 255 * Math.max(0, Math.min(1, x)) ** L;
        });
      }

      // ---- background of this cell
      let bg = back;
      if (grid.bg && grid.bg[n * 4 + 3]) {
        bg = [grid.bg[n * 4], grid.bg[n * 4 + 1], grid.bg[n * 4 + 2]];
      } else if (tone) {
        bg = mix(back ?? [0, 0, 0], tone, under);
      }

      // ---- glyph colour, blended over the background when the image is kept underneath
      let fg = null;
      if (glyph) {
        fg = [grid.fg[n * 3], grid.fg[n * 3 + 1], grid.fg[n * 3 + 2]];
        if (tone && S.colorMode === 'source') {
          // The engine's glyph colour is always bright (its density carries the tone). Over a picture that
          // would wash it out, and a terminal letter covers far more of its cell than the app's thin
          // strokes do, so keep the engine's hue and boost but take the brightness from the picture.
          const eMax = Math.max(fg[0], fg[1], fg[2]) || 1;
          const target = Math.min(255, Math.max(tone[0], tone[1], tone[2]) * TEXT_TUNING.gain + TEXT_TUNING.lift);
          fg = fg.map((v) => (v * target) / eMax);
        }
        const a = (grid.alpha[n] / 255) * glyphOpacity * (overlay ? TEXT_TUNING.strength : 1);
        if (a < 1) fg = mix(bg ?? [0, 0, 0], fg, a);
      }

      // ---- per-cell effects
      let gain = frameGain;
      if (vignette > 0) {
        const dx = (c + 0.5) / cols - 0.5;
        const dy = (r + 0.5) / rows - 0.5;
        const d = Math.min(1, Math.hypot(dx, dy) / 0.7071);
        gain *= 1 - vignette * 0.85 * Math.max(0, (d - 0.35) / 0.65) ** 2;
      }
      if (scan > 0 && r % 2 === 1) gain *= 1 - scan * 0.45;
      if (grain > 0) gain *= 1 + (hash(n * 1.37 + noiseSeed * 17.3) - 0.5) * grain * 0.5;
      if (gain !== 1) {
        if (bg) bg = bg.map((v) => v * gain);
        if (fg) fg = fg.map((v) => v * gain);
      }

      // ---- emit
      const bgCode = bg ? sgrColor('bg', bg.map(clamp255), depth) : '';
      const fgCode = fg ? sgrColor('fg', fg.map(clamp255), depth) : '';
      const codes = [];
      if (bgCode !== curBg) {
        codes.push(bgCode || '49');
        curBg = bgCode;
      }
      if (glyph && fgCode !== curFg) {
        codes.push(fgCode);
        curFg = fgCode;
      }
      if (codes.length) out += `${ESC}${codes.join(';')}m`;
      out += ch;
    }
    return curFg || curBg ? `${out}${ESC}0m` : out;
  });
}

/**
 * Pixels -> half-block cells: each cell shows two vertical pixels (top as the glyph colour of "▀",
 * bottom as its background). Used for the pixel-only styles in terminals without a graphics protocol.
 * rgba holds w x h pixels (h even); the result has h / 2 lines.
 */
export function halfBlockLines(rgba, w, h, depth = 'truecolor') {
  const lines = [];
  for (let y = 0; y + 1 < h; y += 2) {
    let out = '';
    let cur = '';
    for (let x = 0; x < w; x++) {
      const t = (y * w + x) * 4;
      const b = ((y + 1) * w + x) * 4;
      if (depth === 'none') {
        const luma = (0.299 * rgba[t] + 0.587 * rgba[t + 1] + 0.114 * rgba[t + 2] + 0.299 * rgba[b] + 0.587 * rgba[b + 1] + 0.114 * rgba[b + 2]) / 2;
        out += ' .:-=+*#%@'[Math.min(9, Math.floor((luma / 256) * 10))];
        continue;
      }
      const code = `${sgrColor('fg', [rgba[t], rgba[t + 1], rgba[t + 2]], depth)};${sgrColor('bg', [rgba[b], rgba[b + 1], rgba[b + 2]], depth)}`;
      if (code !== cur) {
        out += `${ESC}${code}m`;
        cur = code;
      }
      out += '▀';
    }
    lines.push(depth === 'none' ? out : `${out}${ESC}0m`);
  }
  return lines;
}

/** Full-screen output: alternate screen, hidden cursor, one atomic write per frame, only changed rows redrawn. */
export class Screen {
  constructor(stream = process.stdout) {
    this.out = stream;
    this.active = false;
    this.cache = new Map();
    this.pending = [];
    this.hasImage = false;
  }

  size() {
    return { cols: this.out.columns || 80, rows: this.out.rows || 24 };
  }

  enter() {
    this.active = true;
    this.out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.out.write(`${this.hasImage ? '\x1b_Ga=d,d=A,q=2\x1b\\' : ''}${ESC}0m${ESC}?25h${ESC}?1049l`);
  }

  /** Forget what is on screen and clear it (after a resize, or a change of layout or mode). */
  invalidate() {
    this.cache.clear();
    this.pending.push(`${this.hasImage ? '\x1b_Ga=d,d=A,q=2\x1b\\' : ''}${ESC}0m${ESC}2J`);
    this.hasImage = false;
  }

  /** Start composing a frame. Everything put() until flush() goes out in one write. */
  begin() {
    // pending already holds anything queued by invalidate()
  }

  /** Put `text` at 0-based row y, column x. Skipped when that row already shows exactly this. */
  put(y, x, text, { pad = 0 } = {}) {
    const key = `${y},${x}`;
    const body = `${ESC}0m${' '.repeat(Math.max(0, pad))}${text}${ESC}0m`;
    if (this.cache.get(key) === body) return;
    this.cache.set(key, body);
    this.pending.push(`${ESC}${y + 1};${x + 1}H${body}`);
  }

  /** Erase `width` cells of row y starting at column x. */
  clearRow(y, x, width) {
    const key = `${y},${x}`;
    const body = `${ESC}0m${' '.repeat(width)}`;
    if (this.cache.get(key) === body) return;
    this.cache.set(key, body);
    this.pending.push(`${ESC}${y + 1};${x + 1}H${body}`);
  }

  /** Raw output (e.g. a graphics-protocol image placed at row y, column x). Never cached. */
  putRaw(y, x, data, { image = false } = {}) {
    if (image) this.hasImage = true;
    this.pending.push(`${ESC}${y + 1};${x + 1}H${data}`);
  }

  flush() {
    if (!this.pending.length) return;
    const data = `${ESC}?2026h${this.pending.join('')}${ESC}?2026l`; // synchronized output (ignored where unsupported)
    this.pending = [];
    this.out.write(data);
  }
}
