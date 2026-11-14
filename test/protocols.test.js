import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { detectGraphics, encodingFor, imageFor, itermImage, kittyClear, kittyImage, queryCellSize } from '../src/protocols.js';

/** Pull the Kitty APC chunks out of an output string. */
function kittyChunks(out) {
  return [...out.matchAll(/\x1b_G([^;\x1b]*);([^\x1b]*)\x1b\\/g)].map((m) => ({
    ctrl: Object.fromEntries(m[1].split(',').map((kv) => kv.split('='))),
    payload: m[2],
  }));
}

describe('detectGraphics', () => {
  it('recognises kitty-protocol terminals', () => {
    assert.equal(detectGraphics({ KITTY_WINDOW_ID: '1' }), 'kitty');
    assert.equal(detectGraphics({ TERM: 'xterm-kitty' }), 'kitty');
    assert.equal(detectGraphics({ TERM_PROGRAM: 'ghostty' }), 'kitty');
    assert.equal(detectGraphics({ GHOSTTY_RESOURCES_DIR: '/x' }), 'kitty');
  });
  it('recognises iTerm2-protocol terminals, including over ssh', () => {
    assert.equal(detectGraphics({ TERM_PROGRAM: 'iTerm.app' }), 'iterm2');
    assert.equal(detectGraphics({ LC_TERMINAL: 'iTerm2' }), 'iterm2');
    assert.equal(detectGraphics({ TERM_PROGRAM: 'WezTerm' }), 'iterm2');
    assert.equal(detectGraphics({ TERM_PROGRAM: 'mintty' }), 'iterm2');
  });
  it('says none for plain terminals, multiplexers and VS Code (which needs an opt-in setting)', () => {
    assert.equal(detectGraphics({}), null);
    assert.equal(detectGraphics({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }), null);
    assert.equal(detectGraphics({ TERM_PROGRAM: 'Apple_Terminal' }), null);
    assert.equal(detectGraphics({ TERM_PROGRAM: 'vscode' }), null);
    assert.equal(detectGraphics({ TMUX: '/tmp/tmux', KITTY_WINDOW_ID: '1' }), null);
    assert.equal(detectGraphics({ STY: '1.x', TERM_PROGRAM: 'iTerm.app' }), null);
  });
});

describe('kittyImage', () => {
  const png = Buffer.from(Array.from({ length: 9000 }, (_, i) => (i * 31) % 256));

  it('splits the image into <=4096-byte base64 chunks that reassemble to the original', () => {
    const chunks = kittyChunks(kittyImage(png, { cols: 55, rows: 49 }));
    assert.equal(chunks.length, Math.ceil(Math.ceil((9000 * 4) / 3 / 4) * 4 / 4096));
    assert.ok(chunks.every((c) => c.payload.length <= 4096));
    assert.ok(chunks.slice(0, -1).every((c) => c.payload.length === 4096));
    assert.deepEqual(Buffer.from(chunks.map((c) => c.payload).join(''), 'base64'), png);
  });
  it('puts the control keys on the first chunk only, and flags continuation with m', () => {
    const chunks = kittyChunks(kittyImage(png, { cols: 55, rows: 49, id: 7 }));
    assert.deepEqual(chunks[0].ctrl, { a: 'T', f: '100', t: 'd', q: '2', i: '7', c: '55', r: '49', C: '1', m: '1' });
    for (const c of chunks.slice(1, -1)) assert.deepEqual(c.ctrl, { m: '1' });
    assert.deepEqual(chunks.at(-1).ctrl, { m: '0' });
  });
  it('a small image is a single chunk with m=0 and no reply requested', () => {
    const [only, ...rest] = kittyChunks(kittyImage(Buffer.from('tiny'), { cols: 2, rows: 1 }));
    assert.equal(rest.length, 0);
    assert.equal(only.ctrl.m, '0');
    assert.equal(only.ctrl.q, '2'); // replies would arrive on stdin as keystrokes
    assert.equal(only.ctrl.C, '1'); // the cursor stays put
  });
  it('can clear every image it placed', () => {
    assert.equal(kittyClear(), '\x1b_Ga=d,d=A,q=2\x1b\\');
  });
});

describe('itermImage', () => {
  it('is one OSC 1337 sequence with the size in cells and the image base64 encoded', () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const out = itermImage(jpg, { cols: 61, rows: 45 });
    const m = /^\x1b\]1337;File=([^:]*):([A-Za-z0-9+/=]*)\x07$/.exec(out);
    assert.ok(m, JSON.stringify(out));
    assert.equal(m[1], `inline=1;size=${jpg.length};width=61;height=45;preserveAspectRatio=0`);
    assert.deepEqual(Buffer.from(m[2], 'base64'), jpg);
  });
});

describe('imageFor / encodingFor', () => {
  it('Kitty needs PNG; iTerm2 takes (much faster) JPEG', () => {
    assert.equal(encodingFor('kitty'), 'png');
    assert.equal(encodingFor('iterm2'), 'jpeg');
    const img = { data: Buffer.from('x') };
    assert.match(imageFor('kitty', img, { cols: 1, rows: 1 }), /^\x1b_G/);
    assert.match(imageFor('iterm2', img, { cols: 1, rows: 1 }), /^\x1b\]1337;/);
  });
});

describe('queryCellSize', () => {
  function fakeTerminal({ reply, tty = true } = {}) {
    const stdin = new EventEmitter();
    const state = { raw: false, rawCalls: [] };
    Object.assign(stdin, {
      isTTY: tty,
      isRaw: false,
      setRawMode(v) {
        state.raw = v;
        state.rawCalls.push(v);
      },
      resume() {},
      pause() {},
    });
    const stdout = {
      isTTY: tty,
      written: '',
      write(s) {
        this.written += s;
        if (s === '\x1b[16t' && reply) setImmediate(() => reply.forEach((chunk) => stdin.emit('data', Buffer.from(chunk, 'latin1'))));
      },
    };
    return { stdin, stdout, state };
  }

  it('asks with CSI 16 t and reads the cell size from the reply', async () => {
    const t = fakeTerminal({ reply: ['\x1b[6;20;10t'] });
    assert.deepEqual(await queryCellSize({ ...t, timeoutMs: 500 }), { w: 10, h: 20 });
    assert.equal(t.stdout.written, '\x1b[16t');
  });
  it('copes with a reply split across reads and with other bytes around it', async () => {
    const t = fakeTerminal({ reply: ['junk\x1b[6;3', '6;18t more'] });
    assert.deepEqual(await queryCellSize({ ...t, timeoutMs: 500 }), { w: 18, h: 36 });
  });
  it('gives up with null when the terminal does not answer, and puts the terminal back', async () => {
    const t = fakeTerminal({});
    const started = Date.now();
    assert.equal(await queryCellSize({ ...t, timeoutMs: 80 }), null);
    assert.ok(Date.now() - started < 600);
    assert.deepEqual(t.state.rawCalls, [true, false]);
    assert.equal(t.stdin.listenerCount('data'), 0, 'must stop listening');
  });
  it('does not even ask when there is no terminal', async () => {
    const t = fakeTerminal({ tty: false });
    assert.equal(await queryCellSize({ ...t }), null);
    assert.equal(t.stdout.written, '');
  });
});
