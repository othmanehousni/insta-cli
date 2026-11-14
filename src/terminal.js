const ESC = '\x1b[';

/**
 * Largest column count whose rendered height still fits the terminal.
 * A terminal cell is about twice as tall as it is wide, so a source of srcW x srcH needs
 * round(srcH / srcW * cols / 2) rows.
 */
export function fitCols({ termCols, termRows, srcW, srcH, maxCols, reserveRows = 1 }) {
  const availRows = Math.max(1, termRows - reserveRows);
  const byHeight = Math.floor((availRows * 2 * srcW) / srcH);
  const limit = Math.min(termCols, byHeight, maxCols ?? Infinity);
  return Math.max(8, limit);
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

const sgr = (r, g, b, depth) =>
  depth === 'truecolor' ? `${ESC}38;2;${r};${g};${b}m` : `${ESC}38;5;${rgbTo256(r, g, b)}m`;

/**
 * Turn a grid from AsciiBridge.render() into printable lines.
 * depth 'none' (or no colour data) gives plain text with trailing blanks trimmed.
 */
export function renderLines({ lines, rgb, cols }, depth) {
  if (depth === 'none' || !rgb) return lines.map((l) => l.replace(/\s+$/, ''));
  return lines.map((line, row) => {
    let out = '';
    let prev = '';
    const chars = Array.from(line);
    for (let c = 0; c < cols; c++) {
      const ch = chars[c] ?? ' ';
      if (ch === ' ') {
        out += ' '; // blanks carry no foreground colour
        continue;
      }
      const o = (row * cols + c) * 3;
      const code = sgr(rgb[o], rgb[o + 1], rgb[o + 2], depth);
      if (code !== prev) {
        out += code;
        prev = code;
      }
      out += ch;
    }
    return prev ? `${out}${ESC}0m` : out;
  });
}

/** Full-screen output: alternate screen, hidden cursor, one atomic write per frame. */
export class Screen {
  constructor(stream = process.stdout) {
    this.out = stream;
    this.geometry = '';
    this.active = false;
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
    this.out.write(`${ESC}0m${ESC}?25h${ESC}?1049l`);
  }

  /** Force a full clear on the next draw (after a resize or a geometry change). */
  invalidate() {
    this.geometry = '';
  }

  /**
   * @param lines  output of renderLines()
   * @param cols   visible width of each line
   * @param hud    one status line shown on the bottom row
   */
  draw(lines, cols, hud) {
    const { cols: tc, rows: tr } = this.size();
    const avail = Math.max(1, tr - 1);
    const shown = lines.slice(0, avail);
    const left = Math.max(0, Math.floor((tc - cols) / 2));
    const top = Math.max(0, Math.floor((avail - shown.length) / 2));

    const geometry = `${tc}x${tr}|${left}|${top}|${shown.length}`;
    let buf = `${ESC}?2026h`; // synchronized output (ignored where unsupported)
    if (geometry !== this.geometry) {
      buf += `${ESC}0m${ESC}2J`;
      this.geometry = geometry;
    }
    const pad = ' '.repeat(left);
    shown.forEach((line, i) => {
      buf += `${ESC}${top + i + 1};1H${ESC}0m${pad}${line}${ESC}0m${ESC}K`;
    });
    const text = hud.length > tc ? hud.slice(0, tc) : hud.padEnd(tc);
    buf += `${ESC}${tr};1H${ESC}0m${ESC}7m${text}${ESC}0m${ESC}?2026l`;
    this.out.write(buf);
  }
}
