import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Panel } from '../src/panel.js';
import { DEFAULTS } from '../src/settings.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const ctx = { look: 'photo', mode: 'text' };
const make = () => new Panel({ defaults: DEFAULTS, lookLabel: (id) => (id === 'photo' ? 'Photo-real' : id) });
const state = (extra = {}) => ({ ...DEFAULTS, ...extra });

/** Move the selection to the control with this key. */
function select(panel, settings, key) {
  const rows = panel.rows(settings, ctx);
  const sel = panel.selectable(rows);
  panel.index = sel.findIndex((i) => rows[i].id === key);
  assert.ok(panel.index >= 0, `${key} is not shown`);
}

describe('Panel rows', () => {
  it('starts with the CLI\'s own View section, then the app\'s sections for this style', () => {
    const rows = make().rows(state(), ctx);
    const headers = rows.filter((r) => r.header).map((r) => r.header);
    assert.deepEqual(headers.slice(0, 2), ['View', 'Style']);
    assert.ok(headers.includes('Tone') && headers.includes('Effects'));
    assert.equal(rows[1].value, 'Photo-real');
    assert.equal(rows[2].value, 'text');
  });
  it('shows different sections for different styles', () => {
    const headers = (s) => make().rows(state({ style: s }), ctx).filter((r) => r.header).map((r) => r.header);
    assert.ok(headers('film').includes('Film') && !headers('film').includes('Colour'));
    assert.ok(headers('particle').includes('Particles'));
    assert.ok(headers('tiles').includes('Letters'));
  });
});

describe('Panel keys', () => {
  it('moves the selection with the arrows and wraps around', () => {
    const p = make();
    const n = p.selectable(p.rows(state(), ctx)).length;
    p.handleKey('up', state(), ctx);
    assert.equal(p.index, n - 1);
    p.handleKey('down', state(), ctx);
    assert.equal(p.index, 0);
    p.handleKey('end', state(), ctx);
    assert.equal(p.index, n - 1);
    p.handleKey('home', state(), ctx);
    assert.equal(p.index, 0);
  });

  it('left/right change a slider by its step, shift by ten steps', () => {
    const p = make();
    const s = state();
    select(p, s, 'contrast');
    assert.deepEqual(p.handleKey('right', s, ctx), { type: 'set', key: 'contrast', value: 1 });
    assert.deepEqual(p.handleKey('S-right', s, ctx), { type: 'set', key: 'contrast', value: 10 });
    assert.deepEqual(p.handleKey('left', s, ctx), { type: 'set', key: 'contrast', value: -1 });
  });
  it('does nothing at the end of a range', () => {
    const p = make();
    const s = state({ contrast: 100 });
    select(p, s, 'contrast');
    assert.equal(p.handleKey('right', s, ctx), null);
  });
  it('toggles flip and choices cycle', () => {
    const p = make();
    const s = state();
    select(p, s, 'invert');
    assert.deepEqual(p.handleKey('enter', s, ctx), { type: 'set', key: 'invert', value: true });
    select(p, s, 'bgMode');
    assert.deepEqual(p.handleKey('right', s, ctx), { type: 'set', key: 'bgMode', value: 'black' });
    assert.deepEqual(p.handleKey('left', s, ctx), { type: 'set', key: 'bgMode', value: 'transparent' });
  });
  it('d puts a changed control back to the app\'s default and ignores an unchanged one', () => {
    const p = make();
    const s = state({ gamma: 1.6 });
    select(p, s, 'gamma');
    assert.deepEqual(p.handleKey('d', s, ctx), { type: 'set', key: 'gamma', value: 1 });
    assert.equal(p.handleKey('d', state(), ctx), null);
  });
  it('the View rows ask the viewer to change look and render mode', () => {
    const p = make();
    p.index = 0; // Look
    assert.deepEqual(p.handleKey('right', state(), ctx), { type: 'look', dir: 1 });
    assert.deepEqual(p.handleKey('left', state(), ctx), { type: 'look', dir: -1 });
    p.index = 1; // Render
    assert.deepEqual(p.handleKey('right', state(), ctx), { type: 'mode', dir: 1 });
  });
  it('Tab, Escape and m close the panel', () => {
    for (const k of ['tab', 'escape', 'm']) assert.deepEqual(make().handleKey(k, state(), ctx), { type: 'close' });
  });

  it('text and colour controls are edited in place: Enter starts, type, Enter applies', () => {
    const p = make();
    const s = state({ colorMode: 'mono', monoColor: '#F4F4F7' });
    select(p, s, 'monoColor');
    assert.equal(p.handleKey('enter', s, ctx), null);
    assert.ok(p.typing);
    for (let i = 0; i < 7; i++) p.handleKey('backspace', s, ctx);
    for (const ch of '#00ff88') p.handleKey(ch, s, ctx);
    assert.deepEqual(p.handleKey('enter', s, ctx), { type: 'set', key: 'monoColor', value: '#00FF88' });
    assert.ok(!p.typing);
  });
  it('an invalid colour keeps editing and says why; Escape cancels', () => {
    const p = make();
    const s = state({ colorMode: 'mono' });
    select(p, s, 'monoColor');
    p.handleKey('enter', s, ctx);
    p.handleKey('backspace', s, ctx);
    assert.equal(p.handleKey('enter', s, ctx), null);
    assert.ok(p.typing);
    assert.match(p.notice, /colour like #FF8800/);
    p.handleKey('escape', s, ctx);
    assert.ok(!p.typing);
  });
  it('the custom character box takes spaces and any characters', () => {
    const p = make();
    const s = state({ style: 'custom', customRamp: ' .' });
    select(p, s, 'customRamp');
    p.handleKey('enter', s, ctx);
    p.handleKey('space', s, ctx);
    for (const ch of '#@') p.handleKey(ch, s, ctx);
    assert.deepEqual(p.handleKey('enter', s, ctx), { type: 'set', key: 'customRamp', value: ' . #@' });
  });
  it('shortcuts typed while editing are text, not commands', () => {
    const p = make();
    const s = state({ style: 'custom', customRamp: '' });
    select(p, s, 'customRamp');
    p.handleKey('enter', s, ctx);
    assert.equal(p.handleKey('d', s, ctx), null);
    assert.equal(p.handleKey('m', s, ctx), null); // would close the panel if it were a command
    assert.ok(p.typing);
    assert.equal(p.editing.buffer, 'dm');
  });
});

describe('Panel rendering', () => {
  it('returns exactly height lines of exactly width visible columns', () => {
    const p = make();
    for (const [w, h] of [[40, 30], [30, 12], [60, 80]]) {
      const lines = p.render(w, h, state(), ctx);
      assert.equal(lines.length, h);
      for (const l of lines) assert.equal(Array.from(strip(l)).length, w, JSON.stringify(strip(l)));
    }
  });
  it('highlights the selected row and shows a value bar for sliders', () => {
    const p = make();
    const s = state();
    select(p, s, 'gamma');
    const lines = p.render(40, 60, s, ctx);
    const row = lines.find((l) => strip(l).includes('Gamma'));
    assert.ok(row.includes('\x1b[7m'), 'selected row is reverse video');
    assert.match(strip(row), /▸ Gamma\s+[█░]{8} 1\.00/);
  });
  it('scrolls to keep the selected row visible in a short panel', () => {
    const p = make();
    const s = state();
    select(p, s, 'twinkle' in s ? 'twinkle' : 'shimmer');
    const lines = p.render(40, 10, s, ctx).map(strip);
    assert.ok(lines.some((l) => l.includes('Twinkle')), lines.join('\n'));
  });
  it('marks image-only settings as not applying in text mode, and says how to get them', () => {
    const p = make();
    const s = state();
    select(p, s, 'bloom');
    const text = p.render(40, 60, s, { ...ctx, mode: 'text' });
    const row = text.find((l) => strip(l).includes('Bloom'));
    assert.ok(row.includes('\x1b[7m')); // selected, and it is still the selected highlight
    assert.ok(text.map(strip).some((l) => l.includes('needs image rendering')));
    const image = p.render(40, 60, s, { ...ctx, mode: 'image' }).map(strip);
    assert.ok(!image.some((l) => l.includes('needs image rendering')));
  });
  it('shows the edit buffer with a cursor while typing', () => {
    const p = make();
    const s = state({ colorMode: 'mono' });
    select(p, s, 'monoColor');
    p.handleKey('enter', s, ctx);
    assert.ok(p.render(40, 60, s, ctx).map(strip).some((l) => l.includes('#F4F4F7▏')));
  });
});
