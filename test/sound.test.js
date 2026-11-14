// Sound: the page's audio -> PCM -> an audio player process. Verified without speakers by analysing the PCM
// itself (frequency and level of a known tone) and by recording what the player process receives.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { AudioOut, PLAYERS, applyGain, beep, choosePlayer, describePlayers, findExecutable, parseCommand, reasonFrom, startAudio, testPlayer, wavHeader } from '../src/audio.js';
import { launchSession } from '../src/browser.js';
import { FrameSource } from '../src/capture.js';
import { Reels, openFeed } from '../src/instagram.js';
import { FriendlyError } from '../src/util.js';
import { canPty, dominantFrequency, fakeSpawn, feedPage, makeToneMedia, rmsOf, runInPty, startFixtureServer, tmpDir } from './helpers.js';

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
    assert.equal(p.variants.length, 1);
    assert.deepEqual(p.variants[0].args(48000), ['/opt/sink.js', '48000', '2', 'out.pcm']);
    assert.equal(p.variants[0].realtime, false, 'a custom command may legitimately finish instantly (a recorder)');
    assert.equal(p.name, 'node');
    assert.deepEqual(parseCommand('  a   b  '), ['a', 'b']);
    assert.throws(() => parseCommand('   '), FriendlyError);
  });
  it('every known player variant describes the audio: a WAV header, or the rate, stereo and 16-bit samples', () => {
    for (const p of PLAYERS) {
      assert.ok(p.variants.length >= 1);
      for (const v of p.variants) {
        const at44 = v.args(44100).join(' ');
        const at48 = v.args(48000).join(' ');
        if (v.wav) {
          assert.ok(!/s16|-ar\b|-ac\b/.test(at44), `${p.name}/${v.id} should not depend on raw-format options`);
        } else {
          assert.ok(at44.includes('44100') && at48.includes('48000') && !at48.includes('44100'), `${p.name}/${v.id} follows the rate`);
          assert.match(at44, /\b2\b|stereo/, `${p.name}/${v.id} channels`);
          assert.match(at44, /s16|S16|16\b/, `${p.name}/${v.id} format`);
        }
        assert.ok(v.args(48000).includes('-') || p.name === 'paplay', `${p.name}/${v.id} reads stdin`);
        assert.equal(v.realtime, true, `${p.name}/${v.id} plays in real time`);
      }
    }
  });
  it('ffplay starts with the self-describing WAV stream and keeps both raw spellings as fallbacks', () => {
    assert.deepEqual(PLAYERS[0].variants.map((v) => v.id), ['wav', 'raw-ac', 'raw-layout']);
    assert.ok(PLAYERS[0].variants[0].wav);
    assert.ok(PLAYERS[0].variants[1].args(48000).includes('-ac'));
    assert.ok(PLAYERS[0].variants[2].args(48000).includes('-ch_layout'));
    // it must log warnings, or the reason for a failure (cannot open the audio device) is never captured
    assert.ok(PLAYERS[0].variants.every((v) => v.args(48000).join(' ').includes('-loglevel warning')));
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
  const player = { name: 'fake', cmd: 'fakeplayer', variants: [{ id: 'raw', label: 'raw', args: (r) => ['--rate', String(r)] }] };
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
  it('a player that exits is a problem whatever its exit code (we never close its input), unless we stopped it', () => {
    const bad = make();
    bad.out.push(48000, Buffer.alloc(400));
    bad.advance(1);
    bad.fake.calls[0].child.stderr.write("SDL_OpenAudio (2 channels, 44100 Hz): ALSA: Couldn't open audio device: No such file or directory\n");
    bad.fake.calls[0].child.emit('exit', 1, null);
    assert.match(bad.problems[0].message, /stopped with exit code 1: SDL_OpenAudio .*Couldn't open audio device/);
    assert.match(bad.problems[0].hint, /insta-ascii audio-test/);

    const quiet = make(); // some players give up with exit code 0
    quiet.out.push(48000, Buffer.alloc(400));
    quiet.advance(1);
    quiet.fake.calls[0].child.emit('exit', 0, null);
    assert.match(quiet.problems[0].message, /quit by itself without playing anything/);

    const killed = make();
    killed.out.push(48000, Buffer.alloc(400));
    killed.advance(1);
    killed.fake.calls[0].child.emit('exit', null, 'SIGKILL');
    assert.match(killed.problems[0].message, /was killed \(SIGKILL\)/);

    const ours = make();
    ours.out.push(48000, Buffer.alloc(400));
    ours.advance(1);
    ours.out.stop();
    assert.equal(ours.problems.length, 0);
    assert.ok(ours.fake.calls[0].child.killed);
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

const hasFfplay = !spawnSync('ffplay', ['-version']).error;

describe('the real ffplay command lines', { skip: hasFfplay ? false : 'ffplay is not installed' }, () => {
  const rate = 44100;
  const run = (variant, extraEnv = {}) => {
    const args = variant.args(rate).map((a, i, all) => (all[i - 1] === '-loglevel' ? 'info' : a));
    const input = variant.wav ? Buffer.concat([wavHeader(rate), tone(rate, 440, 1)]) : tone(rate, 440, 1);
    const t0 = Date.now();
    const r = spawnSync('ffplay', args, { input, env: { ...process.env, SDL_AUDIODRIVER: 'dummy', ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
    return { ...r, ms: Date.now() - t0 };
  };

  for (const variant of PLAYERS[0].variants) {
    it(`"${variant.label}" is accepted and played in real time as 16-bit stereo (on SDL's dummy output, since CI has no sound card)`, () => {
      const r = run(variant);
      assert.equal(r.status, 0, r.stderr?.slice(-400));
      assert.match(r.stderr, new RegExp(`Audio: pcm_s16le.*${rate} Hz, (2 channels|stereo), s16`));
      assert.ok(r.ms > 800, `it took ${r.ms} ms to play one second: it must really have played`);
    });
  }

  it('with an audio driver that is not there, ffplay says so and exits with an error (the failure this code explains)', () => {
    const r = run(PLAYERS[0].variants[0], { SDL_AUDIODRIVER: 'definitely-not-a-driver' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Could not initialize SDL|not available/);
  });
});

describe('wavHeader', () => {
  it('describes 16-bit stereo PCM of unknown length', () => {
    const h = wavHeader(48000);
    assert.equal(h.length, 44);
    assert.equal(h.toString('latin1', 0, 4), 'RIFF');
    assert.equal(h.toString('latin1', 8, 16), 'WAVEfmt ');
    assert.equal(h.readUInt32LE(4), 0xffffffff, 'unknown total size');
    assert.equal(h.readUInt16LE(20), 1, 'PCM');
    assert.equal(h.readUInt16LE(22), 2, 'stereo');
    assert.equal(h.readUInt32LE(24), 48000);
    assert.equal(h.readUInt32LE(28), 48000 * 4, 'bytes per second');
    assert.equal(h.readUInt16LE(32), 4, 'block align');
    assert.equal(h.readUInt16LE(34), 16);
    assert.equal(h.toString('latin1', 36, 40), 'data');
    assert.equal(h.readUInt32LE(40), 0xffffffff, 'unknown data size');
  });
  it('follows the sample rate', () => {
    assert.equal(wavHeader(44100).readUInt32LE(24), 44100);
    assert.equal(wavHeader(44100).readUInt32LE(28), 44100 * 4);
  });
});

describe('reasonFrom: what the player said, minus the noise', () => {
  it('picks the line that names the problem out of ALSA\'s screenful', () => {
    const alsa = [
      "ALSA lib confmisc.c:855:(parse_card) cannot find card '0'",
      'ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_card_inum returned error: No such file or directory',
      "SDL_OpenAudio (2 channels, 44100 Hz): ALSA: Couldn't open audio device: No such file or directory",
      'ALSA lib pcm.c:2721:(snd_pcm_open_noupdate) Unknown PCM default',
      "SDL_OpenAudio (2 channels, 44100 Hz): ALSA: Couldn't open audio device: No such file or directory",
      'No more combinations to try, audio open failed',
      "Failed to open file 'fd:' or configure filtergraph",
    ].join('\n');
    assert.equal(reasonFrom(alsa), "SDL_OpenAudio (2 channels, 44100 Hz): ALSA: Couldn't open audio device: No such file or directory | No more combinations to try, audio open failed");
  });
  it('names an unrecognised option', () => {
    assert.match(reasonFrom("Unrecognized option 'ch_layout'.\nError splitting the argument list: Option not found"), /Unrecognized option 'ch_layout'/);
  });
  it('says what SDL could not set up', () => {
    assert.match(reasonFrom("Could not initialize SDL - Audio target 'x' not available"), /Could not initialize SDL/);
  });
  it('falls back to generic errors, then to whatever was said last, and copes with nothing', () => {
    assert.equal(reasonFrom('starting\nsomething failed badly\nbye'), 'something failed badly');
    assert.equal(reasonFrom('one\ntwo\nthree'), 'two | three');
    assert.equal(reasonFrom(''), '');
    assert.equal(reasonFrom(undefined), '');
  });
  it('stays short', () => {
    assert.ok(reasonFrom(`SDL_OpenAudio ${'x'.repeat(1000)}`).length <= 320);
  });
});

describe('player variants: a spelling one version rejects does not mean no sound', () => {
  const player = {
    name: 'fakeplay',
    cmd: 'fakeplay',
    variants: [
      { id: 'a', label: 'WAV stream', wav: true, args: () => ['--wav'] },
      { id: 'b', label: 'raw with -ac', args: (r) => ['--raw', '-ac', String(r)] },
      { id: 'c', label: 'raw with layout', args: (r) => ['--raw', '--layout', String(r)] },
    ],
  };
  const make = () => {
    const fake = fakeSpawn();
    let t = 0;
    const out = new AudioOut({ player, spawnFn: fake.spawnFn, now: () => t });
    const events = { problems: [], retries: [] };
    out.on('problem', (e) => events.problems.push(e));
    out.on('retry', (e) => events.retries.push(e));
    return { out, fake, events, advance: (ms) => { t += ms; out.tick(); } };
  };
  const chunk = Buffer.alloc(400, 5);

  it('writes the WAV header before any audio for a WAV variant', () => {
    const { out, fake, advance } = make();
    out.push(48000, chunk);
    advance(1);
    const pcm = fake.pcm(0);
    assert.deepEqual(pcm.subarray(0, 44), wavHeader(48000));
    assert.deepEqual(pcm.subarray(44), chunk);
  });

  it('tries the next variant when a player dies right after starting, and keeps going until one stays up', () => {
    const { out, fake, events, advance } = make();
    out.push(48000, chunk);
    advance(1);
    fake.calls[0].child.stderr.write("Unrecognized option 'x'\n");
    fake.calls[0].child.emit('exit', 1, null);
    assert.equal(events.retries.length, 1);
    assert.match(events.retries[0].error, /Unrecognized option/);
    assert.equal(events.problems.length, 0, 'not a failure yet');

    out.push(48000, chunk);
    advance(1);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.calls[1].args, ['--raw', '-ac', '48000']);
    assert.deepEqual(fake.pcm(1), chunk, 'raw variants get no header');

    fake.calls[1].child.emit('exit', 1, null); // the second dies too
    out.push(48000, chunk);
    advance(1);
    assert.deepEqual(fake.calls[2].args, ['--raw', '--layout', '48000']);
    advance(10_000); // and the third stays up
    out.push(48000, chunk);
    advance(1);
    assert.equal(events.problems.length, 0);
    assert.equal(fake.calls.length, 3);
  });

  it('gives up when every variant fails, and says what each one was and what the player said', () => {
    const { out, fake, events, advance } = make();
    for (let i = 0; i < 3; i++) {
      out.push(48000, chunk);
      advance(1);
      fake.calls[i].child.stderr.write(`attempt ${i} could not open audio device\n`);
      fake.calls[i].child.emit('exit', 1, null);
    }
    assert.equal(events.problems.length, 1);
    const m = events.problems[0].message;
    assert.match(m, /The audio player \(fakeplay\) stopped with exit code 1/);
    assert.match(m, /attempt 2 could not open audio device/);
    assert.match(m, /tried: WAV stream; raw with -ac; raw with layout/);
    assert.match(events.problems[0].hint, /insta-ascii audio-test/);
    out.push(48000, chunk);
    advance(1);
    assert.equal(fake.calls.length, 3, 'nothing more is started once it has given up');
  });

  it('does not retry a player that ran for a while and then died: that is not a spelling problem', () => {
    const { out, fake, events, advance } = make();
    out.push(48000, chunk);
    advance(1);
    advance(10_000);
    fake.calls[0].child.emit('exit', 1, null);
    assert.equal(events.retries.length, 0);
    assert.equal(events.problems.length, 1);
  });
});

describe('testPlayer (what `insta-ascii audio-test` runs)', () => {
  const variantsOf = (...vs) => ({ name: 'fakeplay', cmd: 'fakeplay', variants: vs });
  const wav = { id: 'wav', label: 'WAV stream', wav: true, realtime: true, args: () => ['--wav'] };
  const raw = { id: 'raw', label: 'raw', realtime: true, args: (r) => ['--raw', String(r)] };

  /** A fake player that "plays" for `ms` after its input ends, then exits with `code`. */
  const player = (script) => {
    const fake = fakeSpawn();
    let n = 0;
    const spawnFn = (cmd, args, opts) => {
      const child = fake.spawnFn(cmd, args, opts);
      const { ms = 0, code = 0, say = '' } = script[Math.min(n++, script.length - 1)];
      child.stdin.on('finish', () => {
        if (say) child.stderr.write(say);
        setTimeout(() => child.emit('close', code), ms);
      });
      return child;
    };
    return { spawnFn, calls: fake.calls, pcm: fake.pcm };
  };

  it('is OK when the player plays for about as long as the beep and exits cleanly', async () => {
    const f = player([{ ms: 700 }]);
    const r = await testPlayer(variantsOf(raw), { rate: 48000, seconds: 0.5, spawnFn: f.spawnFn });
    assert.equal(r.length, 1);
    assert.equal(r[0].ok, true);
    assert.equal(f.pcm(0).length, beep(48000, 0.5).length, 'the whole beep was sent');
  });
  it('sends a WAV header first when the variant wants one', async () => {
    const f = player([{ ms: 600 }]);
    await testPlayer(variantsOf(wav), { rate: 44100, seconds: 0.5, spawnFn: f.spawnFn });
    assert.deepEqual(f.pcm(0).subarray(0, 44), wavHeader(44100));
  });
  it('is FAILED when the player exits 0 far too soon (it could not open an audio device)', async () => {
    const f = player([{ ms: 5, say: "SDL_OpenAudio (2 channels, 44100 Hz): ALSA: Couldn't open audio device\n" }]);
    const [r] = await testPlayer(variantsOf(raw), { rate: 48000, seconds: 1, spawnFn: f.spawnFn });
    assert.equal(r.ok, false);
    assert.equal(r.code, 0);
    assert.match(r.error, /exited after 0\.\d s, before a 1 s beep could have played: SDL_OpenAudio/);
  });
  it('does not make that judgement for a custom command, which may finish at once (a recorder)', async () => {
    const f = player([{ ms: 0 }]);
    const custom = { id: 'custom', label: 'your command', realtime: false, args: () => [] };
    const [r] = await testPlayer(variantsOf(custom), { rate: 48000, seconds: 1, spawnFn: f.spawnFn });
    assert.equal(r.ok, true);
  });
  it('reports a non-zero exit with the player\'s own words', async () => {
    const f = player([{ code: 1, say: "Could not initialize SDL - Audio target 'x' not available\n" }]);
    const [r] = await testPlayer(variantsOf(raw), { rate: 48000, seconds: 0.5, spawnFn: f.spawnFn });
    assert.deepEqual([r.ok, r.code], [false, 1]);
    assert.match(r.error, /Could not initialize SDL/);
  });
  it('tries the variants in order and stops at the first that works', async () => {
    const f = player([{ code: 1, say: "Unrecognized option 'ac'\n" }, { ms: 600 }, { ms: 600 }]);
    const results = await testPlayer(variantsOf(raw, { ...raw, id: 'r2', label: 'second' }, { ...raw, id: 'r3', label: 'third' }), { rate: 48000, seconds: 0.5, spawnFn: f.spawnFn });
    assert.deepEqual(results.map((r) => r.ok), [false, true]);
    assert.equal(f.calls.length, 2, 'the third was never needed');
  });
  it('gives up on a player that never finishes', async () => {
    const fake = fakeSpawn();
    const [r] = await testPlayer(variantsOf(raw), { rate: 8000, seconds: 0.1, timeoutMs: 150, spawnFn: fake.spawnFn });
    assert.equal(r.ok, false);
    assert.match(r.error, /never finished/);
    assert.ok(fake.calls[0].child.killed);
  });
  it('reports an executable that is not there', async () => {
    const spawnFn = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })));
      return child;
    };
    const [r] = await testPlayer(variantsOf(raw), { rate: 8000, seconds: 0.1, spawnFn });
    assert.deepEqual([r.ok, r.error], [false, 'not found']);
  });
});

describe('a real ffplay that cannot open an audio output', { skip: hasFfplay ? false : 'ffplay is not installed' }, () => {
  it('is reported with ffplay\'s own reason, after every variant has been tried', async () => {
    // an audio driver that does not exist makes this fail on every machine, with or without a sound card
    const spawnFn = (cmd, args, opts) => spawn(cmd, args, { ...opts, env: { ...process.env, SDL_AUDIODRIVER: 'definitely-not-a-driver' } });
    const out = new AudioOut({ player: choosePlayer('ffplay'), spawnFn });
    const problem = new Promise((resolve) => out.on('problem', resolve));
    out.start();
    const feed = setInterval(() => out.push(48000, Buffer.alloc(9600)), 50);
    try {
      const err = await Promise.race([problem, wait(25_000).then(() => 'HUNG')]);
      assert.notEqual(err, 'HUNG', 'a failing player must be reported, not waited on');
      assert.ok(err instanceof FriendlyError);
      assert.match(err.message, /The audio player \(ffplay\) stopped with exit code 1: .*(Could not initialize SDL|not available)/);
      assert.match(err.message, /tried: self-describing WAV stream; raw PCM, -ar\/-ac options; raw PCM, -ch_layout option/);
      assert.match(err.hint, /audio-test/);
    } finally {
      clearInterval(feed);
      out.stop();
    }
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
    // ffplay is fed a WAV stream whose 44-byte header carries the rate; the PCM follows it
    const header = () => fake.pcm();
    const rate = () => (header().length >= 44 && header().toString('latin1', 0, 4) === 'RIFF' ? header().readUInt32LE(24) : NaN);
    const pcm = () => fake.pcm().subarray(44);
    return { page, fake, sound, pump, rate, pcm, reels: new Reels(page), close: async () => (sound.stop(), page.close()) };
  }

  it('captures a MUTED video (like Instagram\'s) as the right tone at the right level', async (t) => {
    if (skip) return t.skip(skip);
    const s = await open('/feed.html');
    try {
      await s.pump(3500);
      const pcm = s.pcm();
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
      const before = s.pcm().length;
      assert.equal(await s.reels.next(), true);
      await s.pump(3500);
      const after = s.pcm().subarray(before + Math.round(s.rate() * 4 * 0.8)); // skip the changeover
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
      assert.equal(s.pcm().length, 0);
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
      const frozen = s.pcm().length;
      await s.pump(2000);
      assert.equal(s.pcm().length, frozen, 'nothing while muted');
      await s.sound.setMuted(false);
      await s.pump(2500);
      assert.ok(s.pcm().length > frozen + s.rate() * 4 * 0.5, 'sound is back');
    } finally {
      await s.close();
    }
  });

  it('volume scales what is played', async (t) => {
    if (skip) return t.skip(skip);
    const s = await open('/feed.html');
    try {
      await s.pump(2500);
      const full = s.pcm().length;
      s.sound.setVolume(0.5);
      await s.pump(3000);
      const half = s.pcm().subarray(full + Math.round(s.rate() * 4 * 0.5));
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

  it('a player that fails shows in the HUD, and the reason is printed after the viewer exits (not lost with the screen)', async (t) => {
    if (skip) return t.skip(skip);
    const failing = `${process.execPath} ${path.join(here, 'fixtures', 'failing-player.js')} 1`;
    const term = runInPty(['--url', `${server.url}/feed.html`, '--fps', '8', '--audio-player', failing], { env: { INSTA_ASCII_HOME: tmpDir() } });
    try {
      await term.waitFor(/♪ ✗/, { timeout: 60_000 });
      const at = await term.waitFor(/sound: The audio player \(node\) stopped with exit code 1/, { timeout: 30_000 });
      term.send('\t'); // the panel says it, too
      await term.waitFor('unavailable', { from: at });
      term.send('\t');
      assert.equal(await term.finish(), 0);
      const tail = term.output().slice(term.output().lastIndexOf('\x1b[?1049l'));
      assert.match(tail, /warning: The audio player \(node\) stopped with exit code 1: Could not open the audio device/);
      assert.match(tail, /insta-ascii audio-test/);
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
