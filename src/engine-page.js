/*
 * Functions in this file run INSIDE the Devault ASCII generator page: Playwright
 * serialises them with toString(), so each one must be fully self-contained
 * (no references to module-level variables or imports).
 *
 * The app only paints its result onto a <canvas>; it has no text export. But
 * its engine module builds the real glyph grid before painting, so we import
 * that module (found through the page's own <link rel=modulepreload> tags) and
 * read the grid directly. The engine's exports are minified and hashed, so the
 * classes are identified by their shape rather than by name:
 *   - store    : has get / set / subscribe
 *   - session  : has buildCells (turns a source image into a glyph grid)
 *   - defaults : the settings object (has customRamp + cols + style)
 */

export async function initEngine(settings) {
  const hrefs = [...document.querySelectorAll('link[rel="modulepreload"]')].map((l) => l.href);
  // Try the module that looks like the engine first so that, in practice, nothing else gets imported.
  hrefs.sort((a, b) => Number(/engine/i.test(b)) - Number(/engine/i.test(a)));

  let found = null;
  for (const href of hrefs) {
    let mod;
    try {
      mod = await import(href);
    } catch {
      continue;
    }
    const vals = Object.values(mod);
    const Store = vals.find(
      (v) => typeof v === 'function' && v.prototype && ['get', 'set', 'subscribe'].every((k) => k in v.prototype),
    );
    const Session = vals.find((v) => typeof v === 'function' && v.prototype && 'buildCells' in v.prototype);
    const defaults = vals.find(
      (v) => v && typeof v === 'object' && !Array.isArray(v) && 'customRamp' in v && 'cols' in v && 'style' in v,
    );
    if (Store && Session && defaults) {
      found = { Store, Session, defaults };
      break;
    }
  }
  if (!found) throw new Error('ENGINE_NOT_FOUND');

  const store = new found.Store({ ...found.defaults, ...settings });
  const canvas = document.createElement('canvas'); // paint target the session insists on; never shown
  const stage = document.createElement('div');
  let session;
  try {
    // (store, canvas, stage, subscribe=false, pad=0, cover=false, keepPixels=false)
    session = new found.Session(store, canvas, stage, false, 0, false, false);
  } catch (err) {
    throw new Error(`ENGINE_INIT_FAILED: ${err && err.message ? err.message : err}`);
  }
  window.__insta_ascii = { store, session, canvas: document.createElement('canvas') };
  return true;
}

export function configureEngine(partial) {
  window.__insta_ascii.store.set(partial);
  return true;
}

/**
 * Convert one source frame into a character grid.
 * frame: { kind: 'rgba', w, h, data: base64 RGBA } | { kind: 'image', mime, data: base64 }
 * Returns { cols, lines: string[], rgb: base64 | null } or null when there is nothing to draw.
 * `rgb` holds 3 bytes (r, g, b) for every character of every returned line.
 */
export async function renderFrame({ frame, cols, withColor }) {
  const ia = window.__insta_ascii;
  const b64ToBytes = (s) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  let el;
  if (frame.kind === 'rgba') {
    const px = new Uint8ClampedArray(b64ToBytes(frame.data).buffer);
    const c = ia.canvas;
    if (c.width !== frame.w || c.height !== frame.h) {
      c.width = frame.w;
      c.height = frame.h;
    }
    c.getContext('2d').putImageData(new ImageData(px, frame.w, frame.h), 0, 0);
    el = c;
  } else {
    el = await createImageBitmap(new Blob([b64ToBytes(frame.data)], { type: frame.mime }));
  }

  try {
    ia.store.set({ cols });
    ia.session.source.loadCanvas(el, 'frame');
    const cells = await ia.session.buildCells(0, 'await');
    if (!cells) return null;

    const { cols: C, rows: R, count, buf, glyphs, style } = cells;
    const kind = style.kind;

    // Per-cell colour. Cell records are 12 bytes: u16 col, u16 row, u16 glyph, u16 pad, then r, g, b, a.
    let colors = null;
    if (withColor) {
      colors = new Uint8Array(C * R * 3);
      const u16 = new Uint16Array(buf, 0, count * 6);
      const u8 = new Uint8Array(buf, 0, count * 12);
      for (let i = 0; i < count; i++) {
        const n = u16[i * 6 + 1] * C + u16[i * 6];
        colors[n * 3] = u8[i * 12 + 8];
        colors[n * 3 + 1] = u8[i * 12 + 9];
        colors[n * 3 + 2] = u8[i * 12 + 10];
      }
    }

    // Same glyph-index -> character mapping the app uses for its own text output.
    const EDGE = ['-', '/', '|', '\\'];
    const EMPTY = 65535;
    const charFor = (g) => {
      if (g === EMPTY) return ' ';
      if (kind === 'braille') return String.fromCharCode(0x2800 + g);
      if (g >= style.ramp.length) return EDGE[g - style.ramp.length] ?? ' ';
      return style.ramp[g];
    };
    // Square-cell styles are generated at twice the vertical resolution; a terminal cell is 1:2, so keep every other row.
    const step = kind === 'blocks' ? 2 : 1;

    const lines = [];
    const rgbRows = [];
    for (let r = 0; r < R; r += step) {
      let s = '';
      for (let c = 0; c < C; c++) s += charFor(glyphs[r * C + c]);
      lines.push(s);
      if (colors) rgbRows.push(colors.subarray(r * C * 3, (r + 1) * C * 3));
    }

    let rgb = null;
    if (colors) {
      const flat = new Uint8Array(rgbRows.length * C * 3);
      rgbRows.forEach((row, i) => flat.set(row, i * C * 3));
      let bin = '';
      for (let i = 0; i < flat.length; i += 0x8000) bin += String.fromCharCode.apply(null, flat.subarray(i, i + 0x8000));
      rgb = btoa(bin);
    }
    return { cols: C, lines, rgb };
  } finally {
    if (typeof ImageBitmap !== 'undefined' && el instanceof ImageBitmap) el.close();
  }
}
