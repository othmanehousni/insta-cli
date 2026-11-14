import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseKeys } from '../src/keys.js';
import { Screen, detectDepth, fitCols, renderLines, rgbTo256 } from '../src/terminal.js';

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
  it('fits landscape sources by width', () => {
    assert.equal(fitCols({ termCols: 100, termRows: 50, srcW: 16, srcH: 9 }), 100);
  });
  it('the resulting height really fits: rows <= available', () => {
    for (const [srcW, srcH] of [[9, 16], [1, 1], [16, 9], [3, 4]]) {
      const cols = fitCols({ termCols: 300, termRows: 31, srcW, srcH });
      const rows = Math.max(1, Math.round((srcH / srcW) * cols * 0.5));
      assert.ok(rows <= 30, `${srcW}x${srcH}: ${rows} rows from ${cols} cols`);
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

describe('renderLines', () => {
  const grid = { cols: 3, lines: ['a b', ' c '], rgb: Buffer.from([10, 20, 30, 0, 0, 0, 40, 50, 60, 0, 0, 0, 70, 80, 90, 0, 0, 0]) };

  it('plain mode trims trailing blanks and has no escapes', () => {
    const out = renderLines({ ...grid, lines: ['a  ', ' c '] }, 'none');
    assert.deepEqual(out, ['a', ' c']);
    assert.ok(!out.join('').includes('\x1b'));
  });
  it('truecolor mode colours glyphs, not blanks, and resets at the end of a line', () => {
    const [first, second] = renderLines(grid, 'truecolor');
    // row 0: 'a' (10,20,30), a blank (no escape), 'b' (40,50,60)
    assert.equal(first, '\x1b[38;2;10;20;30ma \x1b[38;2;40;50;60mb\x1b[0m');
    // row 1: a leading blank, 'c' (70,80,90), a trailing blank
    assert.equal(second, ' \x1b[38;2;70;80;90mc \x1b[0m');
  });
  it('does not repeat an escape for identical neighbouring colours', () => {
    const same = { cols: 3, lines: ['abc'], rgb: Buffer.from([5, 5, 5, 5, 5, 5, 5, 5, 5]) };
    const [line] = renderLines(same, 'truecolor');
    assert.equal(line.match(/\x1b\[38;2;/g).length, 1);
  });
  it('256 mode emits 38;5;n codes', () => {
    const [line] = renderLines({ cols: 1, lines: ['x'], rgb: Buffer.from([255, 0, 0]) }, '256');
    assert.ok(line.includes('\x1b[38;5;196mx'));
  });
  it('falls back to plain text when there is no colour data', () => {
    assert.deepEqual(renderLines({ cols: 2, lines: ['ab'], rgb: null }, 'truecolor'), ['ab']);
  });
});

describe('Screen', () => {
  const fakeStream = (columns, rows) => {
    const writes = [];
    return { columns, rows, write: (s) => writes.push(s), writes };
  };

  it('enters and leaves the alternate screen and restores the cursor', () => {
    const s = fakeStream(80, 24);
    const screen = new Screen(s);
    screen.enter();
    screen.leave();
    screen.leave(); // idempotent
    assert.ok(s.writes[0].includes('\x1b[?1049h') && s.writes[0].includes('\x1b[?25l'));
    assert.equal(s.writes.length, 2);
    assert.ok(s.writes[1].includes('\x1b[?25h') && s.writes[1].includes('\x1b[?1049l'));
  });
  it('centres the frame, puts the HUD on the last row, and clears only when geometry changes', () => {
    const s = fakeStream(20, 10);
    const screen = new Screen(s);
    screen.draw(['xxxx', 'yyyy'], 4, 'hud');
    const first = s.writes[0];
    // left pad (20-4)/2 = 8, top pad (9-2)/2 = 3 -> first row is screen row 4
    assert.ok(first.includes('\x1b[4;1H') && first.includes(`${' '.repeat(8)}xxxx`));
    assert.ok(first.includes('\x1b[10;1H')); // HUD row
    assert.ok(first.includes('\x1b[2J'));
    screen.draw(['xxxx', 'yyyy'], 4, 'hud');
    assert.ok(!s.writes[1].includes('\x1b[2J'));
    screen.draw(['xxxx'], 4, 'hud'); // height changed
    assert.ok(s.writes[2].includes('\x1b[2J'));
  });
  it('never draws more rows than fit above the HUD', () => {
    const s = fakeStream(10, 4);
    new Screen(s).draw(['1', '2', '3', '4', '5'], 1, 'h');
    const rowsDrawn = (s.writes[0].match(/\x1b\[\d+;1H/g) || []).length;
    assert.equal(rowsDrawn, 3 + 1); // 3 picture rows + HUD
  });
});

describe('parseKeys', () => {
  it('parses arrows, letters, space, quit', () => {
    assert.deepEqual(parseKeys('\x1b[A'), ['up']);
    assert.deepEqual(parseKeys('\x1b[B'), ['down']);
    assert.deepEqual(parseKeys('j'), ['j']);
    assert.deepEqual(parseKeys('J'), ['j']);
    assert.deepEqual(parseKeys(' '), ['space']);
    assert.deepEqual(parseKeys('\x03'), ['quit']);
    assert.deepEqual(parseKeys('q'), ['q']);
  });
  it('handles several keys in one chunk and a lone escape', () => {
    assert.deepEqual(parseKeys('jj\x1b[Bk'), ['j', 'j', 'down', 'k']);
    assert.deepEqual(parseKeys('\x1b'), ['escape']);
  });
});
