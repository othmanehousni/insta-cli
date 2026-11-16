import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseKeys } from '../src/keys.js';
import { TEXT_TUNING, Screen, backdrop, cellAspect, composeLines, detectDepth, fitBox, fitCols, halfBlockLines, rgbTo256 } from '../src/terminal.js';
import { rowsFor } from '../src/shapes.js';

describe('fitCols', () => {
  it('is limited by terminal height for a portrait reel', () => {
    // 9:16 source, 40 usable rows -> 40 * 2 * 9/16 = 45 columns
    assert.equal(fitCols({ termCols: 200, termRows: 41, srcW: 9, srcH: 16 }), 45);
  });
  it('is limited by terminal width when that is smaller', () => {
    assert.equal(fitCols({ termCols: 30, termRows: 60, srcW: 9, srcH: 16 }), 30);
  });
  it('honours maxCols and never goes below 8', () => {
    assert.equal(fitCols({ termCols: 200, termRows: 100, srcW: 9, srcH: 16, maxCols: 50 }), 50);
    assert.equal(fitCols({ termCols: 200, termRows: 2, srcW: 9, srcH: 16 }), 8);
  });
  it('the resulting height really fits: rows <= available', () => {
    for (const [srcW, srcH] of [[9, 16], [1, 1], [16, 9], [3, 4]]) {
      const cols = fitCols({ termCols: 300, termRows: 31, srcW, srcH });
      const rows = Math.max(1, Math.round((srcH / srcW) * cols * 0.5));
      assert.ok(rows <= 30, `${srcW}x${srcH}: ${rows} rows from ${cols} cols`);
    }
  });
  it('wider cells (a terminal whose cells are not 1:2) mean fewer columns for the same height, and it still fits', () => {
    const narrow = fitCols({ termCols: 300, termRows: 41, srcW: 9, srcH: 16 });
    const wide = fitCols({ termCols: 300, termRows: 41, srcW: 9, srcH: 16, aspect: 0.6 });
    assert.equal(narrow, 45);
    assert.equal(wide, 37); // 40 rows * 9/16 / 0.6
    for (const aspect of [0.4, 0.5, 0.56, 0.6, 0.75]) {
      const cols = fitCols({ termCols: 300, termRows: 41, srcW: 9, srcH: 16, aspect });
      assert.ok(rowsFor(9, 16, cols, aspect) <= 40, `aspect ${aspect}: ${cols} cols`);
    }
  });
});

describe('cellAspect', () => {
  it('is the cell\'s width over its height', () => {
    assert.equal(cellAspect({ w: 9, h: 18 }), 0.5);
    assert.ok(Math.abs(cellAspect({ w: 10, h: 21 }) - 10 / 21) < 1e-9);
  });
  it('assumes the usual 1:2 when the terminal did not say, or said something unusable', () => {
    for (const bad of [null, undefined, {}, { w: 0, h: 18 }, { w: 9, h: 0 }, { w: NaN, h: 18 }, { w: -4, h: 8 }]) assert.equal(cellAspect(bad), 0.5, JSON.stringify(bad));
  });
  it('clamps absurd answers so one bad reply cannot wreck the picture', () => {
    assert.equal(cellAspect({ w: 1, h: 100 }), 0.35);
    assert.equal(cellAspect({ w: 100, h: 1 }), 0.8);
  });
});

describe('fitBox', () => {
  it('fits a portrait picture into a wide area by height, keeping its aspect ratio', () => {
    const b = fitBox({ availCols: 110, availRows: 45, srcW: 600, srcH: 1068, cellW: 10, cellH: 20 });
    assert.equal(b.rows, 45);
    assert.equal(b.pxH, 900);
    assert.ok(Math.abs(b.pxW / b.pxH - 600 / 1068) < 0.002);
    assert.equal(b.cols, Math.round(b.pxW / 10));
  });
  it('fits a landscape picture by width', () => {
    const b = fitBox({ availCols: 80, availRows: 60, srcW: 1600, srcH: 900, cellW: 10, cellH: 20 });
    assert.equal(b.cols, 80);
    assert.equal(b.pxW, 800);
    assert.ok(b.rows <= 60);
  });
  it('never returns more cells than are available', () => {
    for (const [c, r, w, h] of [[10, 10, 5000, 100], [3, 40, 100, 5000], [200, 3, 100, 100]]) {
      const b = fitBox({ availCols: c, availRows: r, srcW: w, srcH: h });
      assert.ok(b.cols >= 1 && b.cols <= c && b.rows >= 1 && b.rows <= r, JSON.stringify(b));
    }
  });
});

describe('detectDepth', () => {
  it('respects explicit choices', () => {
    assert.equal(detectDepth('truecolor', {}, false), 'truecolor');
    assert.equal(detectDepth('256', {}, false), '256');
    assert.equal(detectDepth('none', { COLORTERM: 'truecolor' }, true), 'none');
  });
  it('auto: NO_COLOR and pipes disable colour; COLORTERM selects truecolor', () => {
    assert.equal(detectDepth('auto', { NO_COLOR: '1', COLORTERM: 'truecolor' }, true), 'none');
    assert.equal(detectDepth('auto', {}, false), 'none');
    assert.equal(detectDepth('auto', { COLORTERM: '24bit' }, true), 'truecolor');
    assert.equal(detectDepth('auto', { TERM: 'xterm-256color' }, true), '256');
  });
});

describe('rgbTo256', () => {
  it('maps primaries and greys into the right parts of the palette', () => {
    assert.equal(rgbTo256(255, 0, 0), 196);
    assert.equal(rgbTo256(0, 0, 255), 21);
    assert.equal(rgbTo256(0, 0, 0), 16);
    assert.equal(rgbTo256(255, 255, 255), 231);
    const grey = rgbTo256(128, 128, 128);
    assert.ok(grey >= 232 && grey <= 255);
  });
});

describe('backdrop', () => {
  it('follows the app\'s background modes', () => {
    assert.deepEqual(backdrop({ bgMode: 'dark' }), [13, 13, 18]);
    assert.deepEqual(backdrop({ bgMode: 'black' }), [0, 0, 0]);
    assert.deepEqual(backdrop({ bgMode: 'paper' }), [242, 239, 232]);
    assert.deepEqual(backdrop({ bgMode: 'custom', bgColor: '#FF8800' }), [255, 136, 0]);
    assert.equal(backdrop({ bgMode: 'transparent' }), null);
  });
});

describe('composeLines', () => {
  // 2 columns x 1 row. Cell 0: glyph 'a' (red-ish); cell 1: blank.
  const grid = (extra = {}) => ({
    cols: 2,
    rows: 1,
    kind: 'ramp',
    lines: ['a '],
    fg: Buffer.from([200, 10, 20, 0, 0, 0]),
    alpha: Buffer.from([255, 255]),
    bg: null,
    tint: Buffer.from([100, 100, 100, 50, 60, 70]),
    ...extra,
  });
  const base = { bgMode: 'black', overlay: false, underlay: 100, glyphOpacity: 100, brightness: 0, contrast: 0, gamma: 1, vignette: 0, scanlines: 0, grain: 0, flicker: 0, animate: false, colorMode: 'source' };

  it('plain mode trims trailing blanks and has no escapes', () => {
    assert.deepEqual(composeLines(grid(), base, { depth: 'none' }), ['a']);
  });

  it('without the image underneath: glyph colour on the app\'s backdrop, blanks carry the backdrop too', () => {
    const [line] = composeLines(grid(), base, { depth: 'truecolor' });
    // 'a': bg black + fg (200,10,20); the blank reuses the same bg (no new escape), then reset
    assert.equal(line, '\x1b[48;2;0;0;0;38;2;200;10;20ma \x1b[0m');
  });

  it('a transparent backdrop leaves the terminal background alone', () => {
    const [line] = composeLines(grid(), { ...base, bgMode: 'transparent' }, { depth: 'truecolor' });
    assert.equal(line, '\x1b[38;2;200;10;20ma \x1b[0m');
    assert.ok(!line.includes('48;'));
  });

  it('keeping the image underneath tints every cell with the picture\'s own colour', () => {
    const [line] = composeLines(grid(), { ...base, overlay: true, underlay: 100, glyphOpacity: 0 }, { depth: 'truecolor' });
    // underlay 100 -> background is the picture colour; glyph opacity 0 -> glyph takes the background colour
    assert.match(line, /48;2;100;100;100/);
    assert.match(line, /48;2;50;60;70/);
    assert.match(line, /38;2;100;100;100ma/);
  });

  it('underlay 0 shows only the backdrop even with the overlay on', () => {
    const out = composeLines(grid(), { ...base, overlay: true, underlay: 0 }, { depth: 'truecolor' })[0];
    assert.ok(!/48;2;(100;100;100|50;60;70)/.test(out));
  });

  it('letter tiles draw their own colour behind the letter', () => {
    const tiles = grid({ kind: 'tiles', bg: Buffer.from([10, 200, 30, 255, 0, 0, 0, 0]) });
    const [line] = composeLines(tiles, base, { depth: 'truecolor' });
    assert.match(line, /48;2;10;200;30;38;2;200;10;20ma/);
  });

  // Background red channel of every visible cell, tracking escapes the way a terminal would.
  const cellBgs = (line) => {
    const out = [];
    let cur = null;
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (m) {
        const bg = /(?:^|;)48;2;(\d+);/.exec(m[1]);
        if (bg) cur = Number(bg[1]);
      } else out.push(...Array.from(part, () => cur));
    }
    return out;
  };

  it('vignette darkens the corners and leaves the centre alone', () => {
    const w = 9;
    const g = { cols: w, rows: 9, kind: 'ramp', lines: Array(9).fill(' '.repeat(w)), fg: Buffer.alloc(w * 9 * 3), alpha: Buffer.alloc(w * 9, 255), bg: null, tint: Buffer.alloc(w * 9 * 3, 200) };
    const out = composeLines(g, { ...base, overlay: true, underlay: 100, vignette: 100 }, { depth: 'truecolor' });
    const corner = cellBgs(out[0])[0];
    const centre = cellBgs(out[4])[4];
    assert.equal(centre, 200, 'centre is untouched');
    assert.ok(corner < centre * 0.6, `corner ${corner} should be much darker than centre ${centre}`);
    assert.deepEqual(cellBgs(composeLines(g, { ...base, overlay: true, underlay: 100, vignette: 0 }, { depth: 'truecolor' })[0]), Array(w).fill(200), 'off means off');
  });

  it('scanlines dim every other row', () => {
    const g = { cols: 1, rows: 2, kind: 'ramp', lines: [' ', ' '], fg: Buffer.alloc(6), alpha: Buffer.alloc(2, 255), bg: null, tint: Buffer.from([200, 200, 200, 200, 200, 200]) };
    const [a, b] = composeLines(g, { ...base, overlay: true, underlay: 100, scanlines: 100 }, { depth: 'truecolor' });
    const v = (l) => Number(l.match(/48;2;(\d+);/)[1]);
    assert.ok(v(b) < v(a));
  });

  it('grain is deterministic for a given frame and moves when animated', () => {
    const g = { cols: 4, rows: 1, kind: 'ramp', lines: ['    '], fg: Buffer.alloc(12), alpha: Buffer.alloc(4, 255), bg: null, tint: Buffer.alloc(12, 150) };
    const s = { ...base, overlay: true, underlay: 100, grain: 80 };
    assert.deepEqual(composeLines(g, s, { depth: 'truecolor', time: 0 }), composeLines(g, s, { depth: 'truecolor', time: 0 }));
    assert.deepEqual(composeLines(g, s, { depth: 'truecolor', time: 0 }), composeLines(g, s, { depth: 'truecolor', time: 5 }), 'still when not animated');
    const a = { ...s, animate: true };
    assert.notDeepEqual(composeLines(g, a, { depth: 'truecolor', time: 0 }), composeLines(g, a, { depth: 'truecolor', time: 5 }));
  });

  it('keeps hue but takes glyph brightness from the picture (so letters do not wash it out)', () => {
    const g = grid({ tint: Buffer.from([40, 40, 40, 0, 0, 0]), fg: Buffer.from([255, 255, 255, 0, 0, 0]) });
    const [line] = composeLines(g, { ...base, overlay: true, underlay: 100, glyphOpacity: 100 }, { depth: 'truecolor' });
    const fg = line.match(/38;2;(\d+);(\d+);(\d+)m/).slice(1).map(Number);
    // dark picture -> dim letter, far below the engine's always-bright 255
    assert.ok(fg[0] < 120, `letter is ${fg}`);
    assert.ok(TEXT_TUNING.gain > 1 && TEXT_TUNING.strength < 1);
  });

  it('fromCol leaves the columns to its left for the caller (Compare draws the original there)', () => {
    const g = { cols: 4, rows: 1, kind: 'ramp', lines: ['abcd'], fg: Buffer.alloc(12, 100), alpha: Buffer.alloc(4, 255), bg: null, tint: null };
    const [all] = composeLines(g, base, { depth: 'truecolor' });
    const [right] = composeLines(g, base, { depth: 'truecolor', fromCol: 2 });
    assert.equal(all.replace(/\x1b\[[0-9;]*m/g, ''), 'abcd');
    assert.equal(right.replace(/\x1b\[[0-9;]*m/g, ''), 'cd');
  });

  it('256 mode emits 38;5;n / 48;5;n codes', () => {
    const [line] = composeLines(grid(), base, { depth: '256' });
    assert.match(line, /48;5;\d+;38;5;\d+ma/);
  });

  it('does not repeat an escape while neighbouring cells share their colours', () => {
    const g = { cols: 3, rows: 1, kind: 'ramp', lines: ['abc'], fg: Buffer.from([5, 5, 5, 5, 5, 5, 5, 5, 5]), alpha: Buffer.alloc(3, 255), bg: null, tint: null };
    const [line] = composeLines(g, base, { depth: 'truecolor' });
    assert.equal(line.match(/\x1b\[/g).length, 2); // one colour change + the final reset
  });
});

describe('halfBlockLines', () => {
  const px = (rgbs) => Buffer.from(rgbs.flatMap(([r, g, b]) => [r, g, b, 255]));
  it('shows two pixels per cell: top as the glyph colour, bottom as the background', () => {
    const lines = halfBlockLines(px([[1, 2, 3], [4, 5, 6]]), 1, 2, 'truecolor');
    assert.deepEqual(lines, ['\x1b[38;2;1;2;3;48;2;4;5;6m▀\x1b[0m']);
  });
  it('halves the height', () => {
    assert.equal(halfBlockLines(Buffer.alloc(4 * 3 * 6), 3, 6, 'truecolor').length, 3);
  });
  it('plain mode falls back to a brightness ramp', () => {
    const [dark] = halfBlockLines(px([[0, 0, 0], [0, 0, 0]]), 1, 2, 'none');
    const [light] = halfBlockLines(px([[255, 255, 255], [255, 255, 255]]), 1, 2, 'none');
    assert.equal(dark, ' ');
    assert.equal(light, '@');
  });
});

describe('Screen', () => {
  const fake = (columns, rows) => {
    const writes = [];
    return { columns, rows, write: (s) => writes.push(s), writes };
  };

  it('enters and leaves the alternate screen and restores the cursor', () => {
    const s = fake(80, 24);
    const screen = new Screen(s);
    screen.enter();
    screen.leave();
    screen.leave(); // idempotent
    assert.ok(s.writes[0].includes('\x1b[?1049h') && s.writes[0].includes('\x1b[?25l'));
    assert.equal(s.writes.length, 2);
    assert.ok(s.writes[1].includes('\x1b[?25h') && s.writes[1].includes('\x1b[?1049l'));
  });

  it('positions text, batches a frame into one write, and skips rows that did not change', () => {
    const s = fake(40, 10);
    const screen = new Screen(s);
    screen.put(2, 5, 'hello');
    screen.put(3, 5, 'world');
    screen.flush();
    assert.equal(s.writes.length, 1);
    assert.ok(s.writes[0].includes('\x1b[3;6Hhello') || s.writes[0].includes('\x1b[3;6H\x1b[0mhello'));
    assert.ok(s.writes[0].startsWith('\x1b[?2026h') && s.writes[0].endsWith('\x1b[?2026l'));

    screen.put(2, 5, 'hello'); // unchanged
    screen.put(3, 5, 'WORLD'); // changed
    screen.flush();
    assert.ok(!s.writes[1].includes('hello'));
    assert.ok(s.writes[1].includes('WORLD'));

    screen.put(2, 5, 'hello');
    screen.put(3, 5, 'WORLD');
    screen.flush(); // nothing changed: nothing written
    assert.equal(s.writes.length, 2);
  });

  it('invalidate clears the screen and forces everything to be redrawn', () => {
    const s = fake(40, 10);
    const screen = new Screen(s);
    screen.put(0, 0, 'x');
    screen.flush();
    screen.invalidate();
    screen.put(0, 0, 'x');
    screen.flush();
    assert.ok(s.writes[1].includes('\x1b[2J'));
    assert.ok(s.writes[1].includes('x'));
  });

  it('deletes Kitty images when it clears or leaves after drawing one', () => {
    const s = fake(40, 10);
    const screen = new Screen(s);
    screen.enter();
    screen.putRaw(0, 0, 'IMG', { image: true });
    screen.flush();
    screen.invalidate();
    screen.flush();
    assert.ok(s.writes.at(-1).includes('\x1b_Ga=d,d=A'));
    screen.putRaw(0, 0, 'IMG', { image: true });
    screen.flush();
    screen.leave();
    assert.ok(s.writes.at(-1).includes('\x1b_Ga=d,d=A') && s.writes.at(-1).includes('\x1b[?1049l'));
  });
});

describe('parseKeys', () => {
  it('parses arrows, shifted arrows, letters (case kept), space, enter, tab, quit', () => {
    assert.deepEqual(parseKeys('\x1b[A'), ['up']);
    assert.deepEqual(parseKeys('\x1b[B'), ['down']);
    assert.deepEqual(parseKeys('\x1b[1;2C'), ['S-right']);
    assert.deepEqual(parseKeys('\x1b[1;5D'), ['C-left']);
    assert.deepEqual(parseKeys('\x1bOB'), ['down']);
    assert.deepEqual(parseKeys('jJ L'), ['j', 'J', 'space', 'L']);
    assert.deepEqual(parseKeys('\t\r\x7f'), ['tab', 'enter', 'backspace']);
    assert.deepEqual(parseKeys('\x1b[Z'), ['S-tab']);
    assert.deepEqual(parseKeys('\x1b[3~\x1b[5~'), ['delete', 'pageup']);
    assert.deepEqual(parseKeys('\x03'), ['quit']);
  });
  it('handles several keys in one chunk, a lone escape, and drops unknown sequences', () => {
    assert.deepEqual(parseKeys('jj\x1b[Bk'), ['j', 'j', 'down', 'k']);
    assert.deepEqual(parseKeys('\x1b'), ['escape']);
    assert.deepEqual(parseKeys('\x1b[99;99x'), []);
  });
  it('passes pasted text through, including non-ASCII', () => {
    assert.deepEqual(parseKeys('#f8é'), ['#', 'f', '8', 'é']);
  });
});

