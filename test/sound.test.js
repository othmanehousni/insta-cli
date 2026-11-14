// Sound: the page's audio -> PCM -> an audio player process. Verified without speakers by analysing the PCM
// itself (frequency and level of a known tone) and by recording what the player process receives.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { AudioOut, PLAYERS, applyGain, choosePlayer, describePlayers, findExecutable, parseCommand, startAudio } from '../src/audio.js';
import { launchSession } from '../src/browser.js';
import { FrameSource } from '../src/capture.js';
import { Reels, openFeed } from '../src/instagram.js';
import { FriendlyError } from '../src/util.js';
import { canPty, dominantFrequency, fakeSpawn, feedPage, hasFfmpeg, makeToneMedia, rmsOf, runInPty, startFixtureServer, tmpDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tone = (rate, hz, seconds, amp = 8000) => {
  const n = Math.round(rate * seconds);
  const b = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp);
    b.writeInt16LE(v, i * 4);
    b.writeInt16LE(v, i * 4 + 2);
  }
  return b;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('applyGain', () => {
  it('leaves full volume untouched (same buffer) and scales, clamps and silences otherwise', () => {
    const pcm = Buffer.alloc(8);
    [1000, -1000, 30000, -30000].forEach((v, i) => pcm.writeInt16LE(v, i * 2));
    assert.equal(applyGain(pcm, 1), pcm);
    const half = applyGain(pcm, 0.5);
    assert.deepEqual([0, 1, 2, 3].map((i) => half.readInt16LE(i * 2)), [500, -500, 15000, -15000]);
    const loud = applyGain(pcm, 2);
    assert.deepEqual([0, 1, 2, 3].map((i) => loud.readInt16LE(i * 2)), [2000, -2000, 32767, -32768]);
    assert.ok(applyGain(pcm, 0).every((b) => b === 0));
  });
  it('ignores a trailing odd byte instead of throwing', () => {
    assert.equal(applyGain(Buffer.from([1, 0, 9]), 0.5).length, 2);
  });
});

describe('choosing a player', () => {
  const only = (...names) => (name) => (names.includes(name) ? `/usr/bin/${name}` : null);

  it('auto picks the first known player that is installed, in order of preference', () => {
    assert.equal(choosePlayer('auto', only('aplay', 'mpv', 'ffplay')).name, 'ffplay');
    assert.equal(choosePlayer('auto', only('aplay', 'mpv')).name, 'mpv');
    assert.equal(choosePlayer('auto', only('aplay')).name, 'aplay');
    assert.equal(choosePlayer(undefined, only('play')).name, 'play');
  });
  it('auto says null when none is installed', () => {
    assert.equal(choosePlayer('auto', only()), null);
  });
  it('a named player must exist, with a hint if it does not', () => {
    assert.equal(choosePlayer('mpv', only('mpv', 'ffplay')).cmd, '/usr/bin/mpv');
    assert.throws(() => choosePlayer('mpv', only('ffplay')), (e) => e instanceof FriendlyError && /"mpv" was not found/.test(e.message) && /Install it/.test(e.hint));
  });
  it('a custom command gets {rate} and {channels} filled in and is not run through a shell', () => {
    const p = choosePlayer('node /opt/sink.js {rate} {channels} out.pcm', only());
    assert.equal(p.cmd, 'node');
    assert.deepEqual(p.args(48000), ['/opt/sink.js', '48000', '2', 'out.pcm']);
    assert.equal(p.name, 'node');
    assert.deepEqual(parseCommand('  a   b  '), ['a', 'b']);
    assert.throws(() => parseCommand('   '), FriendlyError);
  });
  it('every known player is told the sample rate, stereo and 16-bit samples', () => {
    for (const p of PLAYERS) {
      const args = p.args(44100).join(' ');
      assert.ok(args.includes('44100'), `${p.name} rate`);
      assert.match(args, /\b2\b|stereo/, `${p.name} channels`);
      assert.match(args, /s16|S16|16\b/, `${p.name} format`);
      assert.ok(p.args(48000).join(' ').includes('48000') && !p.args(48000).join(' ').includes('44100'), `${p.name} follows the rate`);
      assert.ok(p.args(48000).includes('-') || p.name === 'paplay', `${p.name} reads stdin`);
    }
  });
  it('finds executables on PATH and ignores files that are not executable', { skip: process.platform === 'win32' }, () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'myplayer'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'notexec'), 'x', { mode: 0o644 });
    assert.equal(findExecutable('myplayer', { PATH: `/nonexistent:${dir}` }), path.join(dir, 'myplayer'));
    assert.equal(findExecutable('notexec', { PATH: dir }), null);
    assert.equal(findExecutable('missing', { PATH: dir }), null);
    assert.equal(findExecutable('x', { PATH: '' }), null);
  });
  it('describePlayers reports every known player', () => {
    const list = describePlayers((n) => (n === 'mpv' ? '/x/mpv' : null));
    assert.deepEqual(list.map((p) => p.name), PLAYERS.map((p) => p.name));
    assert.equal(list.find((p) => p.name === 'mpv').path, '/x/mpv');
    assert.equal(list.find((p) => p.name === 'aplay').path, null);
  });
});

describe('AudioOut', () => {
  const player = { name: 'fake', cmd: 'fakeplayer', args: (r) => ['--rate', String(r)] };
  const make = (extra = {}) => {
    const fake = fakeSpawn();
    let t = 0;
    const out = new AudioOut({ player, spawnFn: fake.spawnFn, now: () => t, ...extra });
    return { out, fake, advance: (ms) => { t += ms; out.tick(); }, problems: (() => { const p = []; out.on('problem', (e) => p.push(e)); return p; })() };
  };

  it('starts the player lazily, with the rate the page reported, and passes the PCM through', () => {
    const { out, fake, advance } = make();
    advance(10);
    assert.equal(fake.calls.length, 0, 'nothing to play yet');
    const chunk = tone(44100, 440, 0.1);
    out.push(44100, chunk);
    advance(1);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].args, ['--rate', '44100']);
    assert.deepEqual(fake.pcm(), chunk);
  });

  it('holds sound back by the delay so it lines up with the picture, preserving order', () => {
    const { out, fake, advance } = make({ delayMs: 200 });
    const a = Buffer.alloc(400, 1);
    const b = Buffer.alloc(400, 2);
    out.push(48000, a);
    advance(100);
    out.push(48000, b);
    advance(50);
    assert.equal(fake.calls.length, 0, 'still waiting');
    advance(60); // t = 210: first chunk is due
    assert.deepEqual(fake.pcm(), a);
    advance(100); // t = 310: second is due
    assert.deepEqual(fake.pcm(), Buffer.concat([a, b]));
  });

  it('applies volume and mute immediately', () => {
    const { out, fake, advance } = make();
    out.setVolume(0.5);
    out.push(48000, tone(48000, 440, 0.05, 10000));
    advance(1);
    assert.ok(Math.abs(rmsOf(fake.pcm()) - (10000 / 32768) * 0.5 * Math.SQRT1_2) < 0.01);
    const before = fake.pcm().length;
    out.setMuted(true);
    out.push(48000, tone(48000, 440, 0.05));
    advance(1);
    assert.equal(fake.pcm().length, before, 'nothing while muted');
    out.setMuted(false);
    out.push(48000, tone(48000, 440, 0.05));
    advance(1);
    assert.ok(fake.pcm().length > before);
  });
  it('muting drops what was waiting to be played', () => {
    const { out, fake, advance } = make({ delayMs: 500 });
    out.push(48000, tone(48000, 440, 0.1));
    out.setMuted(true);
    out.setMuted(false);
    advance(1000);
    assert.equal(fake.calls.length, 0);
  });
  it('volume is limited to 0..1', () => {
    const { out } = make();
    out.setVolume(7);
    assert.equal(out.volume, 1);
    out.setVolume(-1);
    assert.equal(out.volume, 0);
  });

  it('drops chunks instead of lagging when the player cannot keep up', () => {
    // a player that never reads its stdin: everything written to it piles up
    const stuck = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough({ highWaterMark: 100 }); // a pipe whose reader has stopped: writes back up
      child.kill = () => {};
      return child;
    };
    let t = 0;
    const out = new AudioOut({ player, spawnFn: stuck, now: () => t });
    // rate 1000 -> the limit is 2000 bytes queued inside the player
    for (let i = 0; i < 8; i++) {
      out.push(1000, Buffer.alloc(1000, 3));
      t += 1;
      out.tick();
    }
    assert.ok(out.dropped > 0, 'some chunks were dropped');
    assert.ok(out.written < 8000, `${out.written} bytes written`);
  });

  it('says once, and then stays quiet, when the player cannot be started', () => {
    const { out, advance, problems } = make({ spawnFn: () => { throw new Error('boom'); } });
    out.push(48000, Buffer.alloc(400));
    advance(1);
    out.push(48000, Buffer.alloc(400));
    advance(1);
    assert.equal(problems.length, 1);
    assert.ok(problems[0] instanceof FriendlyError);
    assert.match(problems[0].message, /Could not start the audio player \(fake\): boom/);
  });
  it('reports a missing executable as "not found"', () => {
    const { out, fake, advance, problems } = make();
    out.push(48000, Buffer.alloc(400));
    advance(1);
    const err = Object.assign(new Error('spawn fakeplayer ENOENT'), { code: 'ENOENT' });
    fake.calls[0].child.emit('error', err);
    assert.match(problems[0].message, /not found/);
  });
  it('reports a player that exits with an error, but not one that exits cleanly or is stopped by us', () => {
    const a = make();
    a.out.push(48000, Buffer.alloc(400));
    a.advance(1);
    a.fake.calls[0].child.emit('exit', 1);
    assert.match(a.problems[0].message, /stopped with exit code 1/);
    assert.match(a.problems[0].hint, /audio output device/);

    const b = make();
    b.out.push(48000, Buffer.alloc(400));
    b.advance(1);
    b.fake.calls[0].child.emit('exit', 0);
    assert.equal(b.problems.length, 0);

    const c = make();
    c.out.push(48000, Buffer.alloc(400));
    c.advance(1);
    c.out.stop();
    assert.equal(c.problems.length, 0);
    assert.ok(c.fake.calls[0].child.killed);
  });
  it('restarts the player when the page\'s sample rate changes', () => {
    const { out, fake, advance } = make();
    out.push(44100, Buffer.alloc(400));
    advance(1);
    out.push(48000, Buffer.alloc(400));
    advance(1);
    assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls[0].child.killed);
    assert.deepEqual(fake.calls[1].args, ['--rate', '48000']);
  });
  it('accepts nothing after stop()', () => {
    const { out, fake, advance } = make();
    out.stop();
    out.push(48000, Buffer.alloc(400));
    advance(1);
    assert.equal(fake.calls.length, 0);
  });
});

describe('the real ffplay command line', { skip: !hasFfmpeg() || spawnSync('ffplay', ['-version']).error ? 'ffplay is not installed' : false }, () => {
  it('accepts our PCM: 16-bit stereo at the page\'s rate (played on SDL\'s dummy output, since CI has no sound card)', () => {
    const rate = 44100;
    const args = PLAYERS[0].args(rate).map((a, i, all) => (all[i - 1] === '-loglevel' ? 'info' : a));
    const r = spawnSync('ffplay', args, { input: tone(rate, 440, 1), env: { ...process.env, SDL_AUDIODRIVER: 'dummy' }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr?.slice(-400));
    assert.match(r.stderr, /Audio: pcm_s16le, 44100 Hz, 2 channels, s16/);
  });
});

describe('capturing the sound of the page (real browser, real tones)', () => {
  let dir;
  let server;
  let session;
  let skip = null;

  before(async () => {
    dir = tmpDir();
    if (!makeToneMedia(dir)) {
      skip = 'ffmpeg is not available to make tone videos';
      return;
    }
    const serve = (file) => (req, res) => {
      res.writeHead(200, { 'content-type': 'video/webm' });
      fs.createReadStream(path.join(dir, file)).pipe(res);
    };
    const html = (body) => (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    server = await startFixtureServer({
      '/tone440.webm': serve('tone440.webm'),
      '/tone880.webm': serve('tone880.webm'),
      '/silent.webm': serve('silent.webm'),
      '/feed.html': html(feedPage(['/tone440.webm', '/tone880.webm'])),
      '/silent.html': html(feedPage(['/silent.webm'])),
    });
    session = await launchSession({ profileDir: tmpDir() });
  });
  after(async () => {
    await session?.close();
    await server?.close();
  });

  /** A fresh page with the sound tap running into a fake player; frames are pulled like the viewer does. */
  async function open(pathname) {
    const page = await session.context.newPage();
    const fake = fakeSpawn();
    const sound = await startAudio({ page, player: choosePlayer('ffplay', () => '/usr/bin/ffplay'), spawnFn: fake.spawnFn });
    await openFeed(page, `${server.url}${pathname}`, { onInstagram: false });
    const frames = new FrameSource(page, { mode: 'video', width: 120 });
    const pump = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await frames.frame();
        await wait(100);
      }
    };
    const rate = () => Number(fake.calls[0]?.args[fake.calls[0].args.indexOf('-ar') + 1]);
    return { page, fake, sound, pump, rate, reels: new Reels(page), close: async () => (sound.stop(), page.close()) };
  }

  it('captures a MUTED video (like Instagram\'s) as the right tone at the right level', async (t) => {
    if (skip) return t.skip(skip);
    const s = await open('/feed.html');
    try {
      await s.pump(3500);
      const pcm = s.fake.pcm();
      assert.ok(pcm.length > s.rate() * 4 * 2, `${pcm.length} bytes is under two seconds of sound`);
      assert.ok([44100, 48000].includes(s.rate()), `rate ${s.rate()}`);
      assert.equal(dominantFrequency(pcm, s.rate()), 440);
      assert.ok(Math.abs(rmsOf(pcm) - 0.088) < 0.02, `level ${rmsOf(pcm)}`); // a default ffmpeg sine is 1/8 amplitude
      // stereo: both channels carry it
      const l = pcm.readInt16LE(4000 * 4);
      const r = pcm.readInt16LE(4000 * 4 + 2);
      assert.equal(l, r);
    } finally {
      await s.close();
    }
  });

  it('follows the reel that is on screen: scrolling to the next one switches to its sound', async (t) => {
    if (skip) return t.skip(skip);
    const s = await open('/feed.html');
    try {
      await s.pump(2500);
      const before = s.fake.pcm().length;
      assert.equal(await s.reels.next(), true);
      await s.pump(3500);
      const after = s.fake.pcm().subarray(before + Math.round(s.rate() * 4 * 0.8)); // skip the changeover
      assert.equal(dominantFrequency(after, s.rate()), 880);
    } finally {
      await s.close();
    }
  });

  it('a silent video sends nothing, and the viewer\'s frame loop is unaffected', async (t) => {
    if (skip) return t.skip(skip);
    const s = await open('/silent.html');
    try {
      await s.pump(2500);
      assert.equal(s.fake.calls.length, 0, 'no player is started for a video without sound');
      assert.equal(s.fake.pcm().length, 0);
    } finally {
      await s.close();
    }
  });

  it('mute stops the flow (and the page stops converting), unmute resumes it', async (t) => {
    if (skip) return t.skip(skip);
    const s = await open('/feed.html');
    try {
      await s.pump(2500);
      await s.sound.setMuted(true);
      await s.pump(500);
      const frozen = s.fake.pcm().length;
      await s.pump(2000);
      assert.equal(s.fake.pcm().length, frozen, 'nothing while muted');
      await s.sound.setMuted(false);
      await s.pump(2500);
      assert.ok(s.fake.pcm().length > frozen + s.rate() * 4 * 0.5, 'sound is back');
    } finally {
      await s.close();
    }
  });

  it('volume scales what is played', async (t) => {
    if (skip) return t.skip(skip);
    const s = await open('/feed.html');
    try {
      await s.pump(2500);
      const full = s.fake.pcm().length;
      s.sound.setVolume(0.5);
      await s.pump(3000);
      const half = s.fake.pcm().subarray(full + Math.round(s.rate() * 4 * 0.5));
      assert.ok(Math.abs(rmsOf(half) / 0.088 - 0.5) < 0.12, `level ${rmsOf(half)} should be about half of 0.088`);
    } finally {
      await s.close();
    }
  });
});

describe('the viewer with sound (real pty, recording player)', { skip: canPty() ? false : 'needs util-linux `script`' }, () => {
  let dir;
  let server;
  let skip = null;
  const sink = path.join(here, 'fixtures', 'sink.js');

  before(async () => {
    dir = tmpDir();
    if (!makeToneMedia(dir)) {
      skip = 'ffmpeg is not available to make tone videos';
      return;
    }
    const serve = (file) => (req, res) => {
      res.writeHead(200, { 'content-type': 'video/webm' });
      fs.createReadStream(path.join(dir, file)).pipe(res);
    };
    server = await startFixtureServer({
      '/tone440.webm': serve('tone440.webm'),
      '/tone880.webm': serve('tone880.webm'),
      '/feed.html': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(feedPage(['/tone440.webm', '/tone880.webm'])),
    });
    const probe = runInPty(['--url', `${server.url}/feed.html`, '--render', 'text', '--no-audio'], { env: { INSTA_ASCII_HOME: tmpDir() } });
    try {
      await probe.waitFor(/reel 1/, { timeout: 60_000 });
    } catch (err) {
      skip = `viewer could not start: ${String(err.message).slice(0, 120)}`;
    } finally {
      probe.kill();
    }
  });
  after(() => server?.close());

  const start = (extra = [], out = path.join(tmpDir(), 'out.pcm')) => {
    const term = runInPty(['--url', `${server.url}/feed.html`, '--fps', '8', '--audio-player', `${process.execPath} ${sink} {rate} ${out}`, ...extra], { env: { INSTA_ASCII_HOME: tmpDir() } });
    const size = () => (fs.existsSync(out) ? fs.statSync(out).size : 0);
    return { term, out, size };
  };

  it('plays the reel\'s sound, shows it in the HUD, and mute / volume / panel work from the keyboard', async (t) => {
    if (skip) return t.skip(skip);
    const { term, out, size } = start();
    try {
      let at = await term.waitFor(/♪ 100%/, { timeout: 60_000 });
      for (let i = 0; i < 100 && size() < 44100 * 4 * 2; i++) await wait(100);
      assert.ok(size() >= 44100 * 4 * 2, `the player received ${size()} bytes`);
      const rate = Number(fs.readFileSync(`${out}.rate`, 'utf8'));
      assert.ok([44100, 48000].includes(rate));
      assert.equal(dominantFrequency(fs.readFileSync(out), rate), 440);

      // mute
      term.send('a');
      at = await term.waitFor(/♪ muted/, { from: at });
      await wait(700);
      const frozen = size();
      await wait(1500);
      assert.equal(size(), frozen, 'no sound reaches the player while muted');
      term.send('a');
      await term.waitFor(/♪ 100%/, { from: at });
      for (let i = 0; i < 100 && size() < frozen + 44100 * 4; i++) await wait(100);
      assert.ok(size() > frozen + 44100 * 4, 'sound resumes');

      // volume: 100 -> 70
      at = term.output().length;
      for (let i = 0; i < 3; i++) term.send('9');
      await term.waitFor(/♪ 70%/, { from: at });
      const mark = size();
      for (let i = 0; i < 100 && size() < mark + 44100 * 4 * 2; i++) await wait(100);
      const quiet = fs.readFileSync(out).subarray(mark + 44100 * 4 * 0.3);
      assert.ok(Math.abs(rmsOf(quiet) / 0.088 - 0.7) < 0.12, `level ${rmsOf(quiet)} should be about 70% of 0.088`);

      // the settings panel has the sound rows
      at = term.output().length;
      term.send('\t');
      await term.waitFor('Sound delay', { from: at });
      assert.match(term.output().slice(at), /Volume[\s\S]*70%/);
      term.send('\t');

      // lip-sync control
      at = term.output().length;
      term.send('.');
      await term.waitFor(/sound delay \+50 ms/, { from: at });

      assert.equal(await term.finish(), 0);
    } finally {
      term.kill();
    }
  });

  it('--no-audio starts no player at all and shows no sound indicator', async (t) => {
    if (skip) return t.skip(skip);
    const { term, out } = start(['--no-audio']);
    try {
      const at = await term.waitFor(/reel 1/, { timeout: 60_000 });
      await wait(2500);
      // regression: with sound off the viewer once crashed ~1.5 s in (lip-sync code touching a null audio object)
      const mark = term.output().length;
      await wait(2000);
      assert.ok(term.output().length > mark + 1000, 'the viewer is still drawing frames');
      assert.ok(!fs.existsSync(out), 'the player was never started');
      assert.ok(!term.output().slice(at).includes('♪'));
      term.send('a');
      await term.waitFor(/there is no sound/, { from: at });
      assert.equal(await term.finish(), 0);
    } finally {
      term.kill();
    }
  });

  it('--volume sets the starting volume', async (t) => {
    if (skip) return t.skip(skip);
    const { term, out, size } = start(['--volume', '40']);
    try {
      await term.waitFor(/♪ 40%/, { timeout: 60_000 });
      for (let i = 0; i < 100 && size() < 44100 * 4 * 3; i++) await wait(100);
      const rate = Number(fs.readFileSync(`${out}.rate`, 'utf8'));
      const pcm = fs.readFileSync(out).subarray(rate * 4);
      assert.ok(Math.abs(rmsOf(pcm) / 0.088 - 0.4) < 0.1, `level ${rmsOf(pcm)}`);
      assert.equal(await term.finish(), 0);
    } finally {
      term.kill();
    }
  });

  it('an explicitly requested player that is missing fails with a way out', async (t) => {
    if (skip) return t.skip(skip);
    const bin = tmpDir();
    for (const exe of ['script', 'stty', 'sh', 'bash']) {
      for (const dirp of ['/usr/bin', '/bin']) {
        if (fs.existsSync(path.join(dirp, exe))) {
          fs.symlinkSync(path.join(dirp, exe), path.join(bin, exe));
          break;
        }
      }
    }
    const term = runInPty(['--url', `${server.url}/feed.html`, '--audio-player', 'mpv'], { env: { INSTA_ASCII_HOME: tmpDir(), PATH: bin } });
    try {
      await term.waitFor(/The audio player "mpv" was not found/, { timeout: 60_000 });
      assert.match(term.output(), /Install it \(mpv\.io\)/);
      assert.ok(!term.output().includes('\x1b[?1049h'), 'never entered the alternate screen');
      assert.equal(await term.finish({ quitKey: '' }), 1);
    } finally {
      term.kill();
    }
  });

  it('with no player installed it says so and carries on silently', async (t) => {
    if (skip) return t.skip(skip);
    const bin = tmpDir();
    for (const exe of ['script', 'stty', 'sh', 'bash']) {
      for (const dirp of ['/usr/bin', '/bin']) {
        if (fs.existsSync(path.join(dirp, exe))) {
          fs.symlinkSync(path.join(dirp, exe), path.join(bin, exe));
          break;
        }
      }
    }
    const term = runInPty(['--url', `${server.url}/feed.html`], { env: { INSTA_ASCII_HOME: tmpDir(), PATH: bin } });
    try {
      await term.waitFor(/no audio player found/, { timeout: 60_000 });
      const at = await term.waitFor(/reel 1/, { timeout: 60_000 });
      assert.ok(!term.output().slice(at).includes('♪'));
      assert.equal(await term.finish(), 0);
    } finally {
      term.kill();
    }
  });
});

describe('lip-sync', { skip: canPty() ? false : 'needs util-linux `script`' }, () => {
  it('holds the sound back by the picture\'s lag minus the tap\'s own batching delay', async (t) => {
    const dir = tmpDir();
    if (!makeToneMedia(dir)) return t.skip('ffmpeg is not available to make tone videos');
    const serve = (file) => (req, res) => {
      res.writeHead(200, { 'content-type': 'video/webm' });
      fs.createReadStream(path.join(dir, file)).pipe(res);
    };
    const server = await startFixtureServer({
      '/tone440.webm': serve('tone440.webm'),
      '/feed.html': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(feedPage(['/tone440.webm'])),
    });
    const out = path.join(tmpDir(), 'out.pcm');
    const term = runInPty(['--url', `${server.url}/feed.html`, '--fps', '6', '--debug', '--audio-player', `${process.execPath} ${path.join(here, 'fixtures', 'sink.js')} {rate} ${out}`], { env: { INSTA_ASCII_HOME: tmpDir() } });
    try {
      await term.waitFor(/lip-sync: the picture is drawn \d+ ms after capture; sound delayed \d+ ms/, { timeout: 90_000 });
      const m = /lip-sync: the picture is drawn (\d+) ms after capture; sound delayed (\d+) ms/.exec(term.output());
      const lag = Number(m[1]);
      const delay = Number(m[2]);
      const tap = (8192 / 44100) * 1000; // 186 ms at 44.1 kHz; a little less at 48 kHz
      assert.ok(lag > 0 && lag < 1500, `lag ${lag}`);
      assert.ok(Math.abs(delay - Math.max(0, lag - tap)) < 25 || Math.abs(delay - Math.max(0, lag - (8192 / 48000) * 1000)) < 25, `delay ${delay} for lag ${lag}`);
      assert.equal(await term.finish(), 0);
    } finally {
      term.kill();
      await server.close();
    }
  });
});
