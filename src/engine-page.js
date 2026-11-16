/*
 * Functions in this file run INSIDE the Devault ASCII generator page: Playwright serialises them with
 * toString(), so each one must be fully self-contained (no references to module-level variables).
 *
 * The app paints its result onto a WebGL <canvas>. Its engine module also builds the real glyph grid
 * before painting. We import that module (found through the page's own <link rel=modulepreload> tags)
 * and use it two ways:
 *   renderFrame  -> the glyph grid (characters + colours), for drawing real text in the terminal
 *   renderImage  -> the app's own canvas, with every style and effect, for terminal graphics
 *
 * The engine's exports are minified and hashed, so its parts are identified by shape, not by name:
 *   store    : class with get / set / subscribe
 *   session  : class with buildCells / drawFrame
 *   defaults : settings object (customRamp + cols + style)
 *   base     : the "reset" settings every look starts from (style + overlay, no cols)
 *   looks    : array of { id, label, patch }
 *   palettes : array of { id, label, stops }
 *   styles   : array of { id, kind, ramp }
 */

export async function initEngine(settings) {
  const hrefs = [...document.querySelectorAll('link[rel="modulepreload"]')].map((l) => l.href);
  // The module that looks like the engine first, so in practice nothing else gets imported.
  hrefs.sort((a, b) => Number(/engine/i.test(b)) - Number(/engine/i.test(a)));

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isArrOf = (v, keys) => Array.isArray(v) && v.length && isObj(v[0]) && keys.every((k) => k in v[0]);

  let found = null;
  for (const href of hrefs) {
    let mod;
    try {
      mod = await import(href);
    } catch {
      continue;
    }
    const vals = Object.values(mod);
    const Store = vals.find((v) => typeof v === 'function' && v.prototype && ['get', 'set', 'subscribe'].every((k) => k in v.prototype));
    const Session = vals.find((v) => typeof v === 'function' && v.prototype && 'buildCells' in v.prototype);
    const defaults = vals.find((v) => isObj(v) && 'customRamp' in v && 'cols' in v && 'style' in v);
    if (Store && Session && defaults) {
      found = {
        Store,
        Session,
        defaults,
        base: vals.find((v) => isObj(v) && 'style' in v && 'overlay' in v && !('cols' in v)) || {},
        looks: vals.find((v) => isArrOf(v, ['id', 'patch'])) || [],
        palettes: vals.find((v) => isArrOf(v, ['id', 'stops'])) || [],
        styles: vals.find((v) => isArrOf(v, ['id', 'kind', 'ramp'])) || [],
      };
      break;
    }
  }
  if (!found) throw new Error('ENGINE_NOT_FOUND');

  const store = new found.Store({ ...found.defaults, ...settings });
  const paint = document.createElement('canvas'); // the app's own output canvas; never shown
  let session;
  try {
    // (store, canvas, stage, subscribe=false, pad=0, cover=false, keepPixels=true so the canvas can be read back)
    session = new found.Session(store, paint, document.createElement('div'), false, 0, false, true);
  } catch (err) {
    throw new Error(`ENGINE_INIT_FAILED: ${err && err.message ? err.message : err}`);
  }

  const srcCanvas = document.createElement('canvas');
  const b64ToBytes = (s) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const bytesToB64 = (u8) => {
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  /** Hand a frame to the engine as its source image. Returns an element to release afterwards. */
  const load = async (frame) => {
    let el;
    if (frame.kind === 'rgba') {
      const px = new Uint8ClampedArray(b64ToBytes(frame.data).buffer);
      if (srcCanvas.width !== frame.w || srcCanvas.height !== frame.h) {
        srcCanvas.width = frame.w;
        srcCanvas.height = frame.h;
      }
      srcCanvas.getContext('2d').putImageData(new ImageData(px, frame.w, frame.h), 0, 0);
      el = srcCanvas;
    } else {
      el = await createImageBitmap(new Blob([b64ToBytes(frame.data)], { type: frame.mime }));
    }
    session.source.loadCanvas(el, 'frame');
    return el;
  };
  const release = (el) => {
    if (typeof ImageBitmap !== 'undefined' && el instanceof ImageBitmap) el.close();
  };

  window.__insta_ascii = { store, session, paint, srcCanvas, load, release, bytesToB64, t0: performance.now() };

  const plain = (o) => JSON.parse(JSON.stringify(o));
  return {
    defaults: plain(found.defaults),
    base: plain(found.base),
    looks: found.looks.map((l) => ({ id: l.id, label: l.label, patch: plain(l.patch) })),
    palettes: found.palettes.map((p) => ({ id: p.id, label: p.label, stops: [...p.stops] })),
    styles: found.styles.map((s) => ({ id: s.id, kind: s.kind, ramp: Array.from(s.ramp), edgeGlyphs: !!s.edgeGlyphs })),
  };
}

export function configureEngine(partial) {
  window.__insta_ascii.store.set(partial);
  return true;
}

/**
 * Convert one source frame into a character grid.
 * frame: { kind: 'rgba', w, h, data: base64 RGBA } | { kind: 'image', mime, data: base64 }
 *
 * Returns null when there is nothing to draw, else
 *   { cols, kind, lines: string[], fg, alpha, bg, tint }
 * where (all base64, one entry per character of every line):
 *   fg    3 bytes r,g,b of the glyph                      (null when withColor is false)
 *   alpha 1 byte, glyph opacity from "fade in shadows"
 *   bg    4 bytes r,g,b,present: a tile's own colour       (letter tiles only)
 *   tint  3 bytes r,g,b: the source picture's colour under that cell (for "keep the image underneath")
 */
export async function renderFrame({ frame, cols, time, withColor }) {
  const ia = window.__insta_ascii;
  const el = await ia.load(frame);
  try {
    ia.store.set({ cols });
    const cells = await ia.session.buildCells(time || 0, 'await');
    if (!cells) return null;

    const { cols: C, rows: R, count, buf, glyphs, style } = cells;
    const kind = style.kind;
    // Square-cell styles are generated at twice the vertical resolution; a terminal cell is 1:2, so keep every other row.
    const step = ['blocks', 'dots', 'dither', 'lego'].includes(kind) ? 2 : 1;
    const outRows = Math.ceil(R / step);

    // Cell records are 12 bytes: u16 col, u16 row, u16 glyph, u16 pad, then r, g, b, a.
    const u16 = new Uint16Array(buf, 0, count * 6);
    const u8 = new Uint8Array(buf, 0, count * 12);
    const fg = withColor ? new Uint8Array(outRows * C * 3) : null;
    const alpha = withColor ? new Uint8Array(outRows * C).fill(255) : null;
    const bg = withColor && kind === 'tiles' ? new Uint8Array(outRows * C * 4) : null;
    if (withColor) {
      for (let i = 0; i < count; i++) {
        const x = u16[i * 6];
        const y = u16[i * 6 + 1];
        if (y % step) continue;
        const g = u16[i * 6 + 2];
        const n = (y / step) * C + x;
        const r = u8[i * 12 + 8];
        const gg = u8[i * 12 + 9];
        const b = u8[i * 12 + 10];
        const a = u8[i * 12 + 11];
        if (kind === 'tiles' && g === 0) {
          bg.set([r, gg, b, 255], n * 4); // the tile itself
        } else if (kind === 'lego' && g !== 0) {
          // shadow / stud highlight layers: not representable in text
        } else {
          fg.set([r, gg, b], n * 3);
          alpha[n] = a;
        }
      }
    }

    // Same glyph-index -> character mapping the app uses for its own text output.
    const EDGE = ['-', '/', '|', '\\'];
    const DOTS = ['●', '•', '∙', '·', ' '];
    const TILE_MARKS = ['.', "'", ',', '`'];
    const EMPTY = 65535;
    const charFor = (g) => {
      if (g === EMPTY) return ' ';
      if (kind === 'braille') return String.fromCharCode(0x2800 + g);
      if (kind === 'lego') return '▣';
      if (kind === 'dither') return '█';
      if (kind === 'dots') return DOTS[Math.min(DOTS.length - 1, Math.floor((g / 16) * DOTS.length))];
      if (kind === 'tiles') return g >= 2 ? ([...style.ramp, ...TILE_MARKS][g - 2] ?? ' ') : ' ';
      if (g >= style.ramp.length) return EDGE[g - style.ramp.length] ?? ' ';
      return style.ramp[g];
    };
    const lines = [];
    for (let r = 0; r < R; r += step) {
      let s = '';
      for (let c = 0; c < C; c++) s += charFor(glyphs[r * C + c]);
      lines.push(s);
    }

    // The picture's own colour under every printed cell.
    let tint = null;
    if (withColor) {
      const t = document.createElement('canvas');
      t.width = C;
      t.height = outRows;
      const g = t.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(el, 0, 0, C, outRows);
      const px = g.getImageData(0, 0, C, outRows).data;
      const rgb = new Uint8Array(C * outRows * 3);
      for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
        rgb[j] = px[i];
        rgb[j + 1] = px[i + 1];
        rgb[j + 2] = px[i + 2];
      }
      tint = ia.bytesToB64(rgb);
    }
    return {
      cols: C,
      kind,
      lines,
      fg: fg && ia.bytesToB64(fg),
      alpha: alpha && ia.bytesToB64(alpha),
      bg: bg && ia.bytesToB64(bg),
      tint,
    };
  } finally {
    ia.release(el);
  }
}

/**
 * Draw the frame with the app's own WebGL renderer (every style and effect) and return the pixels.
 *   encode 'png' | 'jpeg'              -> { mime, data: base64 }
 *   encode 'raw' (rawW x rawH, RGBA)   -> { mime: 'raw', data: base64 }  (for half-block drawing)
 * The result is exactly w x h (rawW x rawH for raw): see the note on resampling below.
 */
export async function renderImage({ frame, cols, w, h, time, encode, quality, rawW, rawH, compare }) {
  const ia = window.__insta_ascii;
  const el = await ia.load(frame);
  try {
    ia.store.set({ cols });
    const m = await ia.session.drawFrame(ia.session.renderer, { w, h }, time || 0, 'await');
    if (!m) return null;
    // The engine sizes its canvas in whole glyph cells, so it only comes out close to the requested size
    // (about 10% off in aspect is normal). The app hides that by scaling the canvas with CSS; we do the
    // same by resampling to exactly the requested, aspect-correct size before encoding.
    const target = encode === 'raw' ? { w: rawW, h: rawH } : { w, h };
    const t = document.createElement('canvas');
    t.width = target.w;
    t.height = target.h;
    const g = t.getContext('2d', { willReadFrequently: encode === 'raw' });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(ia.paint, 0, 0, ia.paint.width, ia.paint.height, 0, 0, target.w, target.h);
    if (compare > 0) {
      // The app's "Compare": the original picture to the left of a divider, the output to the right.
      const x = Math.round(target.w * Math.min(1, compare));
      g.save();
      g.beginPath();
      g.rect(0, 0, x, target.h);
      g.clip();
      g.drawImage(el, 0, 0, el.width, el.height, 0, 0, target.w, target.h);
      g.restore();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fillRect(Math.max(0, x - 1), 0, 2, target.h);
    }
    const out = { w: target.w, h: target.h, cols: m.cols, rows: m.rows };
    if (encode === 'raw') {
      return { ...out, mime: 'raw', data: ia.bytesToB64(new Uint8Array(g.getImageData(0, 0, target.w, target.h).data.buffer)) };
    }
    const mime = encode === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((resolve) => t.toBlob(resolve, mime, quality));
    return { ...out, mime, data: ia.bytesToB64(new Uint8Array(await blob.arrayBuffer())) };
  } finally {
    ia.release(el);
  }
}

/**
 * The source picture itself as raw RGBA (w x h), for the left side of Compare in text rendering.
 * `crop` (0..1) takes only that left fraction of the picture's width.
 */
export async function scaleFrame({ frame, w, h, crop }) {
  const ia = window.__insta_ascii;
  const el = await ia.load(frame);
  try {
    const t = document.createElement('canvas');
    t.width = w;
    t.height = h;
    const g = t.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(el, 0, 0, Math.max(1, Math.round(el.width * (crop ?? 1))), el.height, 0, 0, w, h);
    return ia.bytesToB64(new Uint8Array(g.getImageData(0, 0, w, h).data.buffer));
  } finally {
    ia.release(el);
  }
}

/**
 * Sample a frame on a fine grid for shape-aware glyph choice: every character cell gets sw x sh luminance samples
 * (not one average), plus its average colour.
 * Returns { luma: base64 Uint8 (cols*sw x rows*sh, row-major), rgb: base64 Uint8 (cols x rows x 3) }.
 */
export async function sampleCells({ frame, cols, rows, sw, sh }) {
  const ia = window.__insta_ascii;
  const el = await ia.load(frame);
  try {
    const W = cols * sw;
    const H = rows * sh;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(el, 0, 0, el.width, el.height, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    const luma = new Uint8Array(W * H);
    const sum = new Uint32Array(cols * rows * 3);
    for (let y = 0; y < H; y++) {
      const cy = Math.floor(y / sh);
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = px[i];
        const gg = px[i + 1];
        const b = px[i + 2];
        luma[y * W + x] = (0.299 * r + 0.587 * gg + 0.114 * b) | 0;
        const o = (cy * cols + Math.floor(x / sw)) * 3;
        sum[o] += r;
        sum[o + 1] += gg;
        sum[o + 2] += b;
      }
    }
    const n = sw * sh;
    const rgb = new Uint8Array(cols * rows * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = Math.round(sum[i] / n);
    return { luma: ia.bytesToB64(luma), rgb: ia.bytesToB64(rgb) };
  } finally {
    ia.release(el);
  }
}

/**
 * What each character looks like: its ink coverage (0..255) on an sw x sh grid, drawn in a monospace font the way
 * a terminal would. Returns one base64 Uint8Array of sw*sh values per character, in the order given.
 */
export function glyphMasks({ chars, sw, sh }) {
  const K = 8; // rasterise at 8x and average down, so thin strokes keep their weight
  const W = sw * K;
  const H = sh * K;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  const family = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
  g.font = `${Math.round(H * 0.74)}px ${family}`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const out = [];
  for (const ch of chars) {
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    g.fillText(ch, W / 2, H * 0.76);
    const px = g.getImageData(0, 0, W, H).data;
    const m = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let acc = 0;
        for (let yy = 0; yy < K; yy++) for (let xx = 0; xx < K; xx++) acc += px[(((y * K + yy) * W) + x * K + xx) * 4];
        m[y * sw + x] = Math.round(acc / (K * K));
      }
    }
    out.push(window.__insta_ascii.bytesToB64(m));
  }
  return out;
}
