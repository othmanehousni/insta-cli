// End-to-end: the real CLI, a real browser, a local stand-in for the reels feed, and the live Devault app.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { launchSession } from '../src/browser.js';
import { FrameSource } from '../src/capture.js';
import { Reels, openFeed } from '../src/instagram.js';
import { runCli, startFixtureServer, tmpDir } from './helpers.js';

const meanColour = (frame) => {
  const px = Buffer.from(frame.data, 'base64');
  const sum = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += px[i + c];
  return sum.map((s) => s / (px.length / 4));
};
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('CLI --once against a mock reels feed', () => {
  let server;
  let home;
  let skipReason = null;

  const run = (args) => runCli(['--url', `${server.url}/mock-reels.html`, '--once', ...args], { env: { INSTA_ASCII_HOME: home } });

  before(async () => {
    server = await startFixtureServer();
    home = tmpDir();
    const probe = await run(['--color', 'none', '--cols', '20']);
    if (probe.code !== 0 && /Could not load the ASCII generator/.test(probe.stderr)) skipReason = probe.stderr.trim();
  });
  after(() => server?.close());

  it('prints the playing reel as plain ASCII', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { code, stdout, stderr } = await run(['--color', 'none', '--cols', '50']);
    assert.equal(code, 0, stderr);
    const lines = stdout.trimEnd().split('\n');
    // 360x640 reel grabbed at 240x427: round(427/240 * 50 * 0.5) = 44 rows
    assert.ok(Math.abs(lines.length - 44) <= 1, `${lines.length} rows`);
    assert.ok(lines.every((l) => l.length <= 50));
    assert.ok(!stdout.includes('\x1b'), 'plain output has no escape codes');
    assert.ok(stdout.includes('@'), 'the white disc should be rendered with the densest glyph');
  });

  it('colours the output with truecolor escapes when asked', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { code, stdout, stderr } = await run(['--depth', 'truecolor', '--cols', '40']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /\x1b\[38;2;\d+;\d+;\d+m/);
    assert.ok(stdout.split('\n').filter((l) => l.includes('\x1b[38')).every((l) => l.endsWith('\x1b[0m')));
  });

  it('can render the whole page (screenshot capture) instead of just the video', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { code, stdout, stderr } = await run(['--capture', 'page', '--color', 'none', '--cols', '60']);
    assert.equal(code, 0, stderr);
    const lines = stdout.trimEnd().split('\n');
    assert.ok(lines.length >= 15, `${lines.length} rows`);
    assert.ok(/\S/.test(stdout));
  });

  it('honours --style braille', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { code, stdout, stderr } = await run(['--style', 'braille', '--color', 'none', '--cols', '30']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /[⠀-⣿]/);
  });

  it('honours --ramp', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { code, stdout, stderr } = await run(['--ramp', ' .#', '--no-edges', '--color', 'none', '--cols', '30']);
    assert.equal(code, 0, stderr);
    assert.ok(stdout.replace(/\n/g, '').split('').every((ch) => ' .#'.includes(ch)));
  });
});

describe('CLI argument handling (no browser needed)', () => {
  const env = { INSTA_ASCII_HOME: tmpDir() };

  it('--help and --version succeed', async () => {
    const help = await runCli(['--help'], { env });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage/);
    const v = await runCli(['--version'], { env });
    assert.equal(v.code, 0);
    assert.match(v.stdout, /^\d+\.\d+\.\d+/);
  });

  for (const [name, args, pattern] of [
    ['an unknown style', ['--style', 'nope'], /--style must be one of/],
    ['a non-numeric --cols', ['--cols', 'abc'], /--cols must be a positive whole number/],
    ['zero fps', ['--fps', '0'], /--fps must be a positive whole number/],
    ['an unknown flag', ['--bogus'], /bogus/i],
    ['an unknown command', ['frobnicate'], /Unknown command/],
    ['a bad --url', ['--url', 'not a url'], /full URLs/],
    ['a too-short --ramp', ['--ramp', 'x'], /at least two/],
  ]) {
    it(`rejects ${name} with exit code 2`, async () => {
      const { code, stderr } = await runCli(args, { env });
      assert.equal(code, 2, stderr);
      assert.match(stderr, pattern);
    });
  }

  it('refuses to watch without a terminal, and says how to get a single frame', async () => {
    const { code, stderr } = await runCli([], { env });
    assert.equal(code, 2);
    assert.match(stderr, /--once/);
  });

  it('login without credentials or a terminal fails fast, without starting a browser', async () => {
    const started = Date.now();
    const { code, stderr } = await runCli(['login'], { env: { ...env, INSTAGRAM_USERNAME: '', INSTAGRAM_PASSWORD: '' } });
    assert.equal(code, 1);
    assert.match(stderr, /INSTAGRAM_USERNAME/);
    assert.ok(Date.now() - started < 5000, 'should not have launched a browser');
  });

  it('logout with nothing saved is a no-op', async () => {
    const { code, stdout } = await runCli(['logout'], { env });
    assert.equal(code, 0);
    assert.match(stdout, /Nothing to do/);
  });
});

describe('moving through the feed', () => {
  let server;
  let session;
  let page;

  before(async () => {
    server = await startFixtureServer();
    session = await launchSession({ profileDir: tmpDir() });
    page = session.context.pages()[0] ?? (await session.context.newPage());
    await openFeed(page, `${server.url}/mock-reels.html`, { onInstagram: false });
  });
  after(async () => {
    await session?.close();
    await server?.close();
  });

  it('next/prev change the reel, the frames change with it, and pause works', async () => {
    const frames = new FrameSource(page, { mode: 'video', width: 120 });
    const reels = new Reels(page);

    const first = await frames.frame();
    assert.equal(first.kind, 'rgba'); // raw pixels straight from the <video>
    const id1 = (await frames.current()).id;

    assert.equal(await reels.next(), true);
    const id2 = (await frames.current()).id;
    assert.notEqual(id2, id1);
    const second = await frames.frame();
    assert.ok(distance(meanColour(first), meanColour(second)) > 30, 'reel 2 looks different from reel 1');

    assert.equal(await reels.togglePause(), true);
    assert.equal((await frames.current()).paused, true);
    assert.equal(await reels.togglePause(), false);
    assert.equal((await frames.current()).paused, false);

    assert.equal(await reels.prev(), true);
    assert.equal((await frames.current()).id, id1);
  });

  it('reports false at the end of the feed instead of pretending to move', async () => {
    const reels = new Reels(page);
    assert.equal(await reels.next(), true);
    assert.equal(await reels.next(), true); // now on reel 3 (the last)
    assert.equal(await reels.next(), false);
    await reels.prev();
    await reels.prev();
  });
});

describe('cross-origin video (canvas read-back is blocked)', () => {
  let ffmpegOk = false;
  let media;
  let site;
  let session;

  before(async () => {
    const dir = tmpDir();
    try {
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=15:duration=4', '-c:v', 'libvpx', '-b:v', '300k', path.join(dir, 'clip.webm')]);
      ffmpegOk = fs.existsSync(path.join(dir, 'clip.webm'));
    } catch {
      ffmpegOk = false;
    }
    if (!ffmpegOk) return;
    // The clip lives on a different origin and is served without CORS headers, like a CDN video.
    media = await startFixtureServer({
      '/clip.webm': (req, res) => {
        res.writeHead(200, { 'content-type': 'video/webm' });
        fs.createReadStream(path.join(dir, 'clip.webm')).pipe(res);
      },
    });
    site = await startFixtureServer({
      '/page.html': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<body style="margin:0"><video src="${media.url}/clip.webm" muted loop autoplay playsinline style="width:360px;height:640px"></video>`);
      },
    });
    session = await launchSession({ profileDir: tmpDir() });
  });
  after(async () => {
    await session?.close();
    await site?.close();
    await media?.close();
  });

  it('falls back to screenshots of the video area', async (t) => {
    if (!ffmpegOk) return t.skip('ffmpeg is not available to build a test clip');
    const page = session.context.pages()[0] ?? (await session.context.newPage());
    await openFeed(page, `${site.url}/page.html`, { onInstagram: false });
    const frames = new FrameSource(page, { mode: 'video', width: 120 });
    const frame = await frames.frame();
    assert.equal(frame.kind, 'image');
    assert.equal(frames.useScreenshots, true);
    assert.ok(Math.abs(frame.w - 360) <= 1 && Math.abs(frame.h - 640) <= 1, `${frame.w}x${frame.h}`);
    assert.ok(frame.data.length > 1000);
  });
});
