// Integration tests for the bridge to the hosted Devault ASCII generator. They need network access to
// the app; if it cannot be loaded the tests are skipped (not failed).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AsciiBridge } from '../src/ascii.js';
import { launchSession } from '../src/browser.js';
import { kittyImage } from '../src/protocols.js';
import { APP_LOOKS, DEFAULTS, LOOK_IDS, PALETTE_IDS, STYLES, STYLE_IDS, resolveSettings } from '../src/settings.js';
import { discFrame, tmpDir } from './helpers.js';

const FRAME = discFrame({ w: 120, h: 213 });

describe('AsciiBridge (live Devault app)', () => {
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

  /** Apply a look plus overrides, the way the CLI does. */
  const use = (look = 'mono', sets = {}) => bridge.configure(resolveSettings(bridge.info, { look, sets: Object.entries(sets) }));
  const render = (opts = {}) => bridge.render(FRAME, { cols: 40, color: true, ...opts });
  const chars = (grid) => new Set(grid.lines.join(''));
  const mid = (grid) => grid.lines[Math.floor(grid.lines.length / 2)];
  /** How many pixels of an RGBA buffer differ from the first pixel: 0 means a blank image. */
  const variety = (rgba) => {
    let n = 0;
    for (let i = 4; i < rgba.length; i += 4) if (Math.abs(rgba[i] - rgba[0]) + Math.abs(rgba[i + 1] - rgba[1]) + Math.abs(rgba[i + 2] - rgba[2]) > 24) n++;
    return n / (rgba.length / 4);
  };

  describe('what the live app offers matches the catalog (a failing test here means the site changed)', () => {
    it('has the same styles, in the same order', (t) => {
      if (skipReason) return t.skip(skipReason);
      assert.deepEqual(bridge.info.styles.map((s) => s.id), STYLE_IDS);
    });
    it('has the same palettes', (t) => {
      if (skipReason) return t.skip(skipReason);
      assert.deepEqual([...bridge.info.palettes.map((p) => p.id)].sort(), [...PALETTE_IDS].sort());
    });
    it('has the same preset looks, with the same names', (t) => {
      if (skipReason) return t.skip(skipReason);
      assert.deepEqual(bridge.info.looks.map((l) => [l.id, l.label]), APP_LOOKS.map((l) => [l.id, l.label]));
    });
    it('has the same default settings', (t) => {
      if (skipReason) return t.skip(skipReason);
      assert.deepEqual(bridge.info.defaults, DEFAULTS);
    });
    it('reports the reset look that every preset starts from', (t) => {
      if (skipReason) return t.skip(skipReason);
      assert.equal(bridge.info.base.style, 'classic');
      assert.equal(bridge.info.base.overlay, false);
      assert.ok(!('cols' in bridge.info.base));
    });
  });

  describe('glyph grid (text rendering)', () => {
    it('turns a frame into a grid with the right shape', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono');
      const grid = await render();
      assert.equal(grid.cols, 40);
      assert.equal(grid.lines.length, Math.round((213 / 120) * 40 * 0.5)); // 36 rows
      assert.ok(grid.lines.every((l) => l.length === 40));
      assert.equal(grid.fg.length, grid.lines.length * 40 * 3);
      assert.equal(grid.alpha.length, grid.lines.length * 40);
      assert.equal(grid.tint.length, grid.lines.length * 40 * 3);
    });

    it('draws the bright disc densely in the middle and leaves the dark background blank', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono');
      const grid = await render();
      assert.equal(mid(grid)[20], '@'); // densest glyph of the classic ramp
      for (const [r, c] of [[0, 0], [0, 39], [grid.lines.length - 1, 0], [grid.lines.length - 1, 39]]) assert.equal(grid.lines[r][c], ' ', `corner ${r},${c}`);
    });

    it('reports the glyph colour and the picture\'s colour under every cell', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { colorMode: 'source' });
      const red = await bridge.render(discFrame({ w: 120, h: 213, disc: [255, 0, 0] }), { cols: 40, color: true });
      const n = (Math.floor(red.lines.length / 2) * 40 + 20) * 3;
      assert.ok(red.fg[n] >= 200 && red.fg[n + 1] <= 40 && red.fg[n + 2] <= 40, `glyph ${[...red.fg.subarray(n, n + 3)]}`);
      assert.ok(red.tint[n] >= 240 && red.tint[n + 1] <= 15 && red.tint[n + 2] <= 15, `tint ${[...red.tint.subarray(n, n + 3)]}`);
      assert.deepEqual([...red.tint.subarray(0, 3)], [0, 0, 0], 'corner of the picture is black');
    });

    it('skips colour data when it is not wanted', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono');
      const grid = await render({ color: false });
      assert.deepEqual([grid.fg, grid.tint, grid.alpha, grid.bg], [null, null, null, null]);
    });

    it('accepts an encoded image as well as raw pixels', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono');
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const grid = await bridge.render({ kind: 'image', mime: 'image/png', data: png, w: 1, h: 1 }, { cols: 10, color: false });
      assert.ok(grid.lines.length >= 1);
    });

    it('braille uses braille characters only, with the solid disc as full cells', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { style: 'braille' });
      const set = chars(await render());
      assert.ok([...set].every((ch) => ch === ' ' || (ch >= '⠀' && ch <= '⣿')));
      assert.ok(set.has('⣿'));
    });

    it('blocks halves the row count and uses shade blocks', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { style: 'blocks' });
      const grid = await render();
      assert.equal(grid.lines.length, Math.ceil(Math.round((213 / 120) * 40) / 2));
      assert.ok([...chars(grid)].every((ch) => '█▓▒░ '.includes(ch)));
    });

    it('custom ramps put the densest glyph on the brightest cell', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { style: 'custom', customRamp: ' .oO@' });
      const grid = await render();
      assert.ok([...chars(grid)].every((ch) => ' .oO@'.includes(ch)));
      assert.equal(mid(grid)[20], '@');
    });

    it('binary, minimal and detailed use their own ramps', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { style: 'binary' });
      assert.ok([...chars(await render())].every((ch) => '10 '.includes(ch)));
      await use('mono', { style: 'minimal' });
      assert.ok([...chars(await render())].every((ch) => '#+:. '.includes(ch)));
      await use('mono', { style: 'detailed' });
      const detailed = chars(await render());
      assert.ok(detailed.size > 2 && [...detailed].every((ch) => ch >= ' ' && ch <= '~'));
    });

    it('dots, dither and bricks are written the way the app\'s own text export writes them', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { style: 'dots' });
      const dots = await render();
      assert.ok([...chars(dots)].every((ch) => '●•∙· '.includes(ch)));
      assert.equal(dots.lines.length, Math.ceil(Math.round((213 / 120) * 40) / 2), 'square-cell styles keep every other row');
      await use('mono', { style: 'dither' });
      assert.ok([...chars(await render())].every((ch) => '█ '.includes(ch)));
      await use('mono', { style: 'lego', colorMode: 'source' });
      const lego = await render();
      assert.ok([...chars(lego)].every((ch) => '▣ '.includes(ch)));
      assert.ok(chars(lego).has('▣'));
    });

    it('letter tiles: a letter on its own tile colour', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('tiles');
      const grid = await render();
      assert.equal(grid.kind, 'tiles');
      assert.ok(grid.bg, 'tiles report their own colour');
      let withTile = 0;
      for (let i = 0; i < grid.lines.length * 40; i++) if (grid.bg[i * 4 + 3]) withTile++;
      assert.ok(withTile > 20, `${withTile} cells have a tile`);
      assert.ok([...chars(grid)].every((ch) => '@#8XS%t;:.\',` '.includes(ch)), [...chars(grid)].join(''));
    });

    it('"fade in shadows" lowers the glyph opacity of dark cells when the image is kept underneath', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { overlay: true, glyphFade: 0 });
      assert.ok([...(await render()).alpha].every((a) => a === 255));
      await use('mono', { overlay: true, glyphFade: 100, cutoff: 0 });
      assert.ok([...(await render()).alpha].some((a) => a < 255));
    });

    it('outline glyphs appear only when edges are on', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { edges: false });
      assert.ok(!/[\\/|]/.test((await render()).lines.join('')));
      await use('mono', { edges: true });
      assert.ok(/[\\/|]/.test((await render()).lines.join('')));
    });

    it('"hide shadows" and invert change what is drawn', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { cutoff: 0 });
      const lit = (g) => g.lines.join('').replace(/ /g, '').length;
      const a = lit(await render());
      await use('mono', { cutoff: 60 });
      assert.ok(lit(await render()) <= a);
      await use('mono', { invert: true });
      assert.equal(mid(await render())[20], ' ', 'inverted: the bright disc is now the blank part');
    });
  });

  describe('the app\'s own canvas (image rendering)', () => {
    it('returns PNG or JPEG at exactly the requested size, whatever the glyph grid rounds to', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('photo');
      const png = await bridge.renderImage(FRAME, { cols: 200, w: 720, h: 1280, encode: 'png' });
      assert.deepEqual([png.w, png.h, png.mime], [720, 1280, 'image/png']);
      assert.equal(png.data.subarray(0, 4).toString('hex'), '89504e47');
      assert.equal(png.data.readUInt32BE(16), 720); // IHDR width
      assert.equal(png.data.readUInt32BE(20), 1280); // IHDR height
      const jpg = await bridge.renderImage(FRAME, { cols: 200, w: 540, h: 960, encode: 'jpeg', quality: 0.8 });
      assert.deepEqual([jpg.w, jpg.h, jpg.mime], [540, 960, 'image/jpeg']);
      assert.equal(jpg.data.subarray(0, 3).toString('hex'), 'ffd8ff');
    });

    it('returns raw RGBA for half-block drawing', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { colorMode: 'source' });
      const raw = await bridge.renderImage(FRAME, { cols: 60, w: 240, h: 426, encode: 'raw', rawW: 30, rawH: 54 });
      assert.deepEqual([raw.w, raw.h, raw.mime], [30, 54, 'raw']);
      assert.equal(raw.data.length, 30 * 54 * 4);
      assert.ok(variety(raw.data) > 0.05, 'the disc should be visible');
    });

    it('a real frame survives the Kitty protocol byte for byte', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('photo');
      const png = await bridge.renderImage(FRAME, { cols: 200, w: 720, h: 1280, encode: 'png' });
      const seq = kittyImage(png.data, { cols: 50, rows: 44 });
      const payload = [...seq.matchAll(/\x1b_G[^;\x1b]*;([^\x1b]*)\x1b\\/g)].map((m) => m[1]).join('');
      assert.deepEqual(Buffer.from(payload, 'base64'), png.data);
    });

    it('Compare puts the original on the left of the divider and the output on the right', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('halftone'); // white dots on black: looks nothing like a smooth disc up close
      const W = 80;
      const H = 142;
      const ask = { cols: 60, w: 320, h: 568, encode: 'raw', rawW: W, rawH: H };
      const plain = (await bridge.renderImage(FRAME, ask)).data;
      const split = (await bridge.renderImage(FRAME, { ...ask, compare: 0.5 })).data;
      const original = await bridge.scaleFrame(FRAME, { w: W, h: H });
      const px = (buf, x, y) => [...buf.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
      const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      let leftMatches = 0;
      let rightMatches = 0;
      let leftTotal = 0;
      let rightTotal = 0;
      for (let y = 0; y < H; y += 3) {
        for (let x = 0; x < W; x += 2) {
          if (x < W / 2 - 2) {
            leftTotal++;
            if (dist(px(split, x, y), px(original, x, y)) < 30) leftMatches++;
          } else if (x > W / 2 + 2) {
            rightTotal++;
            if (dist(px(split, x, y), px(plain, x, y)) < 30) rightMatches++;
          }
        }
      }
      assert.ok(leftMatches / leftTotal > 0.97, `left half is the original (${leftMatches}/${leftTotal})`);
      assert.ok(rightMatches / rightTotal > 0.97, `right half is the output (${rightMatches}/${rightTotal})`);
      assert.ok(variety(plain) > 0.05);
      assert.ok(px(split, W / 2 - 1, 70).every((v) => v > 200) || px(split, W / 2, 70).every((v) => v > 200), 'the divider is a light line');
    });

    it('scaleFrame returns the picture at the requested size, optionally only its left part', async (t) => {
      if (skipReason) return t.skip(skipReason);
      const full = await bridge.scaleFrame(FRAME, { w: 40, h: 71 });
      assert.equal(full.length, 40 * 71 * 4);
      const centre = (buf, w, h) => [...buf.subarray(((h >> 1) * w + (w >> 1)) * 4, ((h >> 1) * w + (w >> 1)) * 4 + 3)];
      assert.deepEqual(centre(full, 40, 71), [255, 255, 255], 'the disc is in the middle of the whole picture');
      const leftHalf = await bridge.scaleFrame(FRAME, { w: 20, h: 71, crop: 0.5 });
      assert.equal(leftHalf.length, 20 * 71 * 4);
      assert.deepEqual([...leftHalf.subarray(((71 >> 1) * 20 + 19) * 4, ((71 >> 1) * 20 + 19) * 4 + 3)], [255, 255, 255], 'the right edge of the left half is inside the disc');
      assert.deepEqual([...leftHalf.subarray(0, 3)], [0, 0, 0], 'its top-left corner is the black background');
    });

    it('draws something for every one of the 14 styles', async (t) => {
      if (skipReason) return t.skip(skipReason);
      for (const style of STYLES) {
        const patch = { style: style.id, colorMode: 'source', bgMode: 'black', ...(style.id === 'custom' ? { customRamp: ' .oO@' } : {}) };
        await use('mono', patch);
        const raw = await bridge.renderImage(FRAME, { cols: 60, w: 240, h: 426, encode: 'raw', rawW: 60, rawH: 106 });
        assert.ok(raw, style.id);
        assert.ok(variety(raw.data) > 0.02, `${style.id} drew a blank image (${variety(raw.data)})`);
      }
    });

    it('draws something for every look (the app\'s 19 presets and ours)', async (t) => {
      if (skipReason) return t.skip(skipReason);
      for (const id of LOOK_IDS) {
        await use(id);
        const raw = await bridge.renderImage(FRAME, { cols: 60, w: 240, h: 426, encode: 'raw', rawW: 60, rawH: 106, time: 1.5 });
        assert.ok(raw, id);
        assert.ok(variety(raw.data) > 0.02, `look ${id} drew a blank image (${variety(raw.data)})`);
      }
    });

    it('the drift controls really change the picture', async (t) => {
      if (skipReason) return t.skip(skipReason);
      const sample = async (extra) => {
        await use('drift', { animate: true, ...extra });
        return (await bridge.renderImage(FRAME, { cols: 60, w: 240, h: 426, encode: 'raw', rawW: 60, rawH: 106, time: 2.5 })).data;
      };
      const differ = (a, b) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++;
        return n / (a.length / 4);
      };
      const base = await sample({});
      assert.ok(differ(base, await sample({ dAmount: 0 })) > 0.002, 'Amount: nothing peels off at 0');
      assert.ok(differ(base, await sample({ dFill: 40 })) > 0.002, 'Pixel size');
      assert.ok(differ(await sample({ dAngle: 0 }), await sample({ dAngle: 180 })) > 0.002, 'Direction');
    });

    it('the pixel effects really change the picture', async (t) => {
      if (skipReason) return t.skip(skipReason);
      const sample = async (extra) => {
        await use('mono', { colorMode: 'source', ...extra });
        return (await bridge.renderImage(FRAME, { cols: 60, w: 240, h: 426, encode: 'raw', rawW: 60, rawH: 106 })).data;
      };
      const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
      const plain = await sample({});
      for (const fx of [{ bloom: 80 }, { scanlines: 80 }, { curvature: 80 }, { chroma: 80 }, { vignette: 90 }, { grain: 80, animate: true }]) {
        assert.ok(diff(plain, await sample(fx)) > 0.3, `${JSON.stringify(fx)} changed nothing`);
      }
    });
  });

  describe('network lockdown', () => {
    it('even the hosts the app\'s own CSP allows (stats, auth) are unreachable, yet rendering works', async (t) => {
      if (skipReason) return t.skip(skipReason);
      await use('mono', { edges: true }); // exercises the edge worker too
      await render();
      await bridge.renderImage(FRAME, { cols: 40, w: 200, h: 355, encode: 'png' });
      assert.deepEqual(bridge.blocked, [], 'normal rendering must not need any blocked request');

      // The app's Content-Security-Policy (connect-src) PERMITS these hosts, so only our own lockdown can stop them.
      const probe = await bridge.page.evaluate(async () => {
        const attempt = (url, init) => fetch(url, init).then(() => 'allowed', () => 'blocked');
        return {
          stats: await attempt('https://devault-ascii-stats.rk360ironjr.workers.dev/', { mode: 'no-cors' }),
          auth: await attempt('https://devault-ascii-auth.rk360ironjr.workers.dev/', { mode: 'no-cors' }),
          post: await attempt(`${location.origin}/ascii-generator/app/`, { method: 'POST', body: 'x' }),
          foreign: await attempt('https://example.com/', { mode: 'no-cors' }), // stopped by the app's CSP before it reaches us
          sameOriginGet: await attempt(`${location.origin}/ascii-generator/app/`),
        };
      });
      assert.deepEqual(probe, { stats: 'blocked', auth: 'blocked', post: 'blocked', foreign: 'blocked', sameOriginGet: 'allowed' });
      for (const needle of ['devault-ascii-stats', 'devault-ascii-auth']) {
        assert.ok(bridge.blocked.some((u) => u.startsWith('GET ') && u.includes(needle)), `${needle} must be refused by the lockdown itself`);
      }
      assert.ok(bridge.blocked.some((u) => u.startsWith('POST ')));
    });
  });
});
