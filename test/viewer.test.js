// The interactive viewer in a REAL pseudo-terminal (util-linux `script`), driven with real key presses.
// Needs the live Devault app and `script`; skipped when either is missing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { canPty, runInPty, runCli, startFixtureServer, tmpDir } from './helpers.js';

const usable = canPty();
const ESC = '\x1b';

describe('interactive viewer (real pty)', { skip: usable ? false : 'needs util-linux `script`' }, () => {
  let server;
  let home;
  let skipReason = null;
  const url = () => `${server.url}/mock-reels.html`;
  // --no-audio: this suite is about the picture; with sound the panel gains rows (Sound, Volume, Sound delay) and its key positions shift
  const run = (extra = [], opts = {}) => runInPty(['--url', url(), '--fps', '8', '--no-audio', ...extra], { env: { INSTA_ASCII_HOME: home }, ...opts });

  before(async () => {
    server = await startFixtureServer();
    home = tmpDir();
    const probe = await runCli(['--url', url(), '--once', '--color', 'none', '--cols', '20'], { env: { INSTA_ASCII_HOME: home } });
    if (probe.code !== 0 && /Could not load the ASCII generator/.test(probe.stderr)) skipReason = probe.stderr.trim();
  });
  after(() => server?.close());

  it('draws the reel, opens the settings panel, changes look / reel / render mode, saves a still, and quits cleanly', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const term = run();
    try {
      let at = await term.waitFor(/reel 1/);
      assert.ok(term.output().includes(`${ESC}[?1049h`), 'enters the alternate screen');
      assert.ok(term.output().includes(`${ESC}[?25l`), 'hides the cursor');
      assert.match(term.output(), /photo · text/, 'defaults to the photo look in text rendering');
      assert.match(term.output(), /\x1b\[48;2;\d+;\d+;\d+;38;2;/, 'cells carry a background and a glyph colour');

      // settings panel: the app's controls
      term.send('\t');
      at = await term.waitFor('── Style', { from: at });
      for (const section of ['View', 'Tone', 'Colour', 'Effects']) assert.ok(term.output().slice(at - 4000).includes(section), section);
      assert.match(term.output(), /Photo-real/);
      // change a slider with the arrows: go down to a control and step it
      term.send(`${ESC}[B`);
      term.send(`${ESC}[B`);
      term.send(`${ESC}[C`); // Style -> next style
      await term.waitFor(/photo\* · text/, { from: at }); // the look is marked as edited
      term.send('\t');
      at = await term.waitFor(/waiting|reel 1/, { from: at });

      // next look: the pure-ASCII one is ours and sits right after photo, then the app's own presets
      at = term.output().length;
      term.send('l');
      at = await term.waitFor(/ascii · text/, { from: at });
      term.send('l');
      await term.waitFor(/devault · text/, { from: at });

      // next reel
      at = term.output().length;
      term.send('j');
      await term.waitFor(/reel 2/, { from: at, timeout: 30_000 });

      // compare: the original (half-block pixels) beside the letters, divider moves with [ and ]
      at = term.output().length;
      term.send('o');
      await term.waitFor(/compare 50%/, { from: at });
      assert.ok(term.output().slice(at).includes('▀'), 'the original is drawn as half-block pixels');
      assert.ok(term.output().slice(at).includes('│'), 'with a divider');
      at = term.output().length;
      term.send(']');
      await term.waitFor(/compare 60%/, { from: at });
      term.send('o');
      at = await term.waitFor(/compare off/, { from: at });

      // render mode: text -> blocks
      at = term.output().length;
      term.send('v');
      await term.waitFor(/devault\*? · blocks/, { from: at });
      assert.ok(term.output().slice(at).includes('▀'), 'half-block pixels are drawn');

      // save a still: PNG of the app's canvas
      at = term.output().length;
      term.send('x');
      await term.waitFor(/saved .*\.png/, { from: at, timeout: 60_000 });
      const shots = fs.readdirSync(path.join(home, 'shots'));
      assert.ok(shots.some((f) => f.endsWith('.png')), shots.join());

      const code = await term.finish();
      assert.equal(code, 0);
      assert.ok(term.output().includes(`${ESC}[?1049l`), 'leaves the alternate screen');
      assert.ok(term.output().includes(`${ESC}[?25h`), 'shows the cursor again');
    } finally {
      term.kill();
    }
  });

  it('--style on its own gives the pure-ASCII look (letters on one plain backdrop), and g switches how letters are chosen', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const term = run(['--style', 'classic', '--render', 'text']);
    try {
      let at = await term.waitFor(/ascii · text/, { timeout: 150_000 });
      await term.waitFor(/38;2;\d+;\d+;\d+m/, { from: at });
      const backgrounds = (from) => new Set([...term.output().slice(from).matchAll(/48;2;(\d+;\d+;\d+)/g)].map((m) => m[1]));
      assert.equal(backgrounds(0).size, 1, 'nothing of the picture is painted behind the letters');

      at = term.output().length;
      term.send('g');
      at = await term.waitFor(/characters chosen by brightness/, { from: at });
      term.send('g');
      await term.waitFor(/characters chosen by shape/, { from: at });
      assert.equal(backgrounds(0).size, 1, 'still plain after switching');

      assert.equal(await term.finish(), 0);
    } finally {
      term.kill();
    }
  });

  it('image rendering speaks the Kitty protocol when asked', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const term = run(['--render', 'image', '--graphics', 'kitty']);
    try {
      await term.waitFor(/\x1b_Ga=T,f=100,t=d,q=2,i=1,c=\d+,r=\d+,C=1,m=[01];/, { timeout: 150_000 });
      assert.match(term.output(), /image\(kitty\)/);
      assert.equal(await term.finish(), 0);
      assert.ok(term.output().includes(`${ESC}_Ga=d,d=A`), 'removes its images on exit');
    } finally {
      term.kill();
    }
  });

  it('image rendering speaks the iTerm2 protocol when asked', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const term = run(['--render', 'image', '--graphics', 'iterm2']);
    try {
      await term.waitFor(/\x1b\]1337;File=inline=1;size=\d+;width=\d+;height=\d+;preserveAspectRatio=0:/, { timeout: 150_000 });
      assert.match(term.output(), /image\(iterm2\)/);
      assert.equal(await term.finish(), 0);
    } finally {
      term.kill();
    }
  });

  it('pixel-only styles fall back to half-block pixels in text rendering instead of showing nothing', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const term = run(['--look', 'film']);
    try {
      await term.waitFor('▀', { timeout: 90_000 });
      assert.match(term.output(), /film · text→blocks/);
      assert.equal(await term.finish(), 0);
    } finally {
      term.kill();
    }
  });

  it('asking for image rendering in a terminal without graphics fails with a way out, before touching the screen', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const term = run(['--render', 'image'], { env: { INSTA_ASCII_HOME: home, KITTY_WINDOW_ID: '', TERM_PROGRAM: 'Apple_Terminal' } });
    try {
      await term.waitFor(/needs a terminal that shows images/, { timeout: 90_000 });
      assert.match(term.output(), /--graphics kitty/);
      assert.ok(!term.output().includes(`${ESC}[?1049h`), 'never entered the alternate screen');
      assert.equal(await term.finish({ quitKey: '' }), 1);
    } finally {
      term.kill();
    }
  });
});
