// Integration tests for the bridge to the hosted Devault ASCII generator. They need network access to
// the app; if it cannot be loaded the tests are skipped (not failed).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AsciiBridge, engineSettings } from '../src/ascii.js';
import { launchSession } from '../src/browser.js';
import { discFrame, tmpDir } from './helpers.js';

const BASE = { style: 'classic', color: 'source', palette: 'devault', edges: false, invert: false };
const FRAME = discFrame({ w: 120, h: 213 });

describe('AsciiBridge (live Devault app)', () => {
  let session;
  let bridge;
  let skipReason = null;

  before(async () => {
    session = await launchSession({ profileDir: tmpDir() });
    try {
      bridge = await AsciiBridge.open(session.context, { settings: engineSettings(BASE) });
    } catch (err) {
      skipReason = `Devault ASCII app unavailable: ${err.message}`;
    }
  });
  after(async () => {
    await bridge?.close();
    await session?.close();
  });

  const render = (opts = {}) => bridge.render(FRAME, { cols: 40, color: true, ...opts });

  it('turns a frame into a grid with the right shape', (t) => {
    if (skipReason) return t.skip(skipReason);
    return render().then((grid) => {
      assert.equal(grid.cols, 40);
      assert.equal(grid.lines.length, Math.round((213 / 120) * 40 * 0.5)); // 36 rows
      assert.ok(grid.lines.every((l) => l.length === 40));
      assert.equal(grid.rgb.length, grid.lines.length * 40 * 3);
    });
  });

  it('draws the bright disc densely in the middle and leaves the dark background blank', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { lines } = await render();
    const mid = Math.floor(lines.length / 2);
    assert.equal(lines[mid][20], '@'); // densest glyph of the classic ramp
    for (const [r, c] of [[0, 0], [0, 39], [lines.length - 1, 0], [lines.length - 1, 39]]) {
      assert.equal(lines[r][c], ' ', `corner ${r},${c}`);
    }
  });

  it('reports the real colour of each cell (source colour mode)', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const red = await bridge.render(discFrame({ w: 120, h: 213, disc: [255, 0, 0] }), { cols: 40, color: true });
    const mid = Math.floor(red.lines.length / 2);
    const o = (mid * 40 + 20) * 3;
    assert.ok(red.rgb[o] >= 200, `red channel ${red.rgb[o]}`);
    assert.ok(red.rgb[o + 1] <= 40 && red.rgb[o + 2] <= 40, `g/b ${red.rgb[o + 1]}/${red.rgb[o + 2]}`);
  });

  it('skips colour data when it is not wanted', async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await render({ color: false })).rgb, null);
  });

  it('accepts an encoded image as well as raw pixels', async (t) => {
    if (skipReason) return t.skip(skipReason);
    // 1x1 white PNG, stretched by the engine: every cell should be lit
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const grid = await bridge.render({ kind: 'image', mime: 'image/png', data: png, w: 1, h: 1 }, { cols: 10, color: false });
    assert.ok(grid.lines.length >= 1);
  });

  it('switches style live: braille uses braille characters only', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await bridge.configure({ style: 'braille' });
    const { lines } = await render();
    assert.ok(lines.join('').split('').every((ch) => ch === ' ' || (ch >= '⠀' && ch <= '⣿')));
    assert.ok(lines.join('').includes('⣿'), 'the solid disc should produce full braille cells');
  });

  it('switches style live: blocks halves the row count and uses shade blocks', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await bridge.configure({ style: 'blocks' });
    const { lines } = await render();
    assert.equal(lines.length, Math.ceil(Math.round((213 / 120) * 40) / 2));
    assert.ok(lines.join('').split('').every((ch) => '█▓▒░ '.includes(ch)));
  });

  it('supports a custom ramp, densest glyph for the brightest cell', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await bridge.configure({ style: 'custom', customRamp: ' .oO@' }); // light -> dense, as the app defines it
    const { lines } = await render();
    assert.ok(lines.join('').split('').every((ch) => ' .oO@'.includes(ch)));
    assert.equal(lines[Math.floor(lines.length / 2)][20], '@');
  });

  it('outline glyphs appear only when edges are on', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await bridge.configure({ style: 'classic', edges: false });
    assert.ok(!/[\\/|]/.test((await render()).lines.join('')), 'no outline glyphs with edges off');
    await bridge.configure({ edges: true });
    assert.ok(/[\\/|]/.test((await render()).lines.join('')), 'outline glyphs with edges on');
  });

  it('is locked down: even the hosts the app\'s own CSP allows (stats, auth) are unreachable', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await bridge.configure({ edges: true }); // exercises the edge worker too
    await render();
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
