import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { installAudioTap, setAudioWanted } from './audio-page.js';
import { FriendlyError } from './util.js';

/*
 * Sound: the page's audio arrives here as 16-bit stereo PCM (see audio-page.js) and is piped, with volume and
 * a lip-sync delay applied, into a command-line audio player. Nothing is installed as a dependency: any of the
 * players below that can read raw PCM on stdin will do.
 */

const CHANNELS = 2;
/** Frames the page batches before sending: sound reaches Node this long after it happened (about 186 ms at 44.1 kHz). */
export const TAP_BUFFER_FRAMES = 8192;

/** Players that can read raw signed 16-bit little-endian stereo on stdin, in order of preference. */
export const PLAYERS = [
  {
    name: 'ffplay',
    hint: 'comes with ffmpeg',
    args: (r) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', String(r), '-ac', String(CHANNELS), '-i', '-'],
  },
  {
    name: 'mpv',
    hint: 'mpv.io',
    args: (r) => ['--no-config', '--no-video', '--really-quiet', '--force-window=no', '--input-terminal=no', '--demuxer=rawaudio', '--demuxer-rawaudio-format=s16le', `--demuxer-rawaudio-rate=${r}`, `--demuxer-rawaudio-channels=${CHANNELS}`, '--audio-buffer=0.2', '--cache=no', '-'],
  },
  { name: 'play', hint: 'comes with SoX', args: (r) => ['-q', '-t', 'raw', '-r', String(r), '-e', 'signed-integer', '-b', '16', '-c', String(CHANNELS), '-'] },
  { name: 'pw-cat', hint: 'PipeWire', args: (r) => ['--playback', '--rate', String(r), '--channels', String(CHANNELS), '--format', 's16', '-'] },
  { name: 'paplay', hint: 'PulseAudio', args: (r) => ['--raw', `--rate=${r}`, `--channels=${CHANNELS}`, '--format=s16le', '--latency-msec=100'] },
  { name: 'aplay', hint: 'ALSA', args: (r) => ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(r), '-c', String(CHANNELS), '-'] },
];

/** Full path of an executable on PATH, or null. */
export function findExecutable(name, env = process.env) {
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...String(env.PATHEXT ?? '.EXE;.CMD').split(';')] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) {
          if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
          return file;
        }
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Split a custom player command on spaces (no shell, no quoting). */
export function parseCommand(text) {
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new FriendlyError('--audio-player is empty.');
  return parts;
}

/**
 * Pick the player to use.
 * @param preference undefined/'auto' (first known player found), a known player name, or a custom command
 *                   such as "node sink.js {rate}" whose {rate} / {channels} are filled in. It must read raw
 *                   signed 16-bit little-endian stereo PCM on stdin.
 * @returns {{ name, cmd, args(rate) } | null}  null when nothing is available (only for 'auto')
 */
export function choosePlayer(preference = 'auto', which = findExecutable) {
  if (!preference || preference === 'auto') {
    for (const p of PLAYERS) {
      const cmd = which(p.name);
      if (cmd) return { name: p.name, cmd, args: p.args };
    }
    return null;
  }
  const known = PLAYERS.find((p) => p.name === preference);
  if (known) {
    const cmd = which(known.name);
    if (!cmd) throw new FriendlyError(`The audio player "${known.name}" was not found.`, `Install it (${known.hint}), or use --audio-player auto.`);
    return { name: known.name, cmd, args: known.args };
  }
  const [cmd, ...rest] = parseCommand(preference);
  return { name: path.basename(cmd), cmd, args: (rate) => rest.map((a) => a.replace('{rate}', String(rate)).replace('{channels}', String(CHANNELS))) };
}

/** Multiply 16-bit little-endian PCM by `gain` (clamped). */
export function applyGain(pcm, gain) {
  if (gain === 1) return pcm;
  const out = Buffer.allocUnsafe(pcm.length - (pcm.length % 2));
  for (let i = 0; i < out.length; i += 2) {
    const v = Math.round(pcm.readInt16LE(i) * gain);
    out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i);
  }
  return out;
}

/**
 * Feeds PCM chunks to an audio player process.
 * - delayMs holds the sound back so it lines up with the picture (which is rendered a moment after it was captured)
 * - volume (0..1) and mute are applied here, so they take effect within one chunk
 * - if the player cannot keep up, chunks are dropped instead of letting the sound lag further behind
 * Emits 'problem' (with a FriendlyError) once if the player cannot start or stops.
 */
export class AudioOut extends EventEmitter {
  constructor({ player, volume = 1, delayMs = 0, spawnFn = spawn, now = () => performance.now(), tickMs = 15 }) {
    super();
    this.player = player;
    this.volume = volume;
    this.muted = false;
    this.delayMs = delayMs;
    this.rate = 0;
    this.failed = null;
    this.dropped = 0;
    this.written = 0;
    this.spawnFn = spawnFn;
    this.now = now;
    this.tickMs = tickMs;
    this.queue = [];
    this.child = null;
    this.timer = null;
    this.stopping = false;
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.muted) this.queue.length = 0;
  }

  setDelay(ms) {
    this.delayMs = Math.max(0, ms);
  }

  /** How late the page's batching makes the sound, in ms (0 until the rate is known: assume 44.1 kHz). */
  tapLatencyMs() {
    return (TAP_BUFFER_FRAMES / (this.rate || 44100)) * 1000;
  }

  /** One chunk of interleaved 16-bit stereo PCM at `rate` Hz. */
  push(rate, pcm) {
    if (this.muted || this.failed || this.stopping) return;
    if (this.rate && rate !== this.rate) this.#killPlayer(); // the page's audio device changed rate: restart the player
    this.rate = rate;
    this.queue.push({ due: this.now() + this.delayMs, pcm });
  }

  tick() {
    const t = this.now();
    while (this.queue.length && this.queue[0].due <= t) this.#write(this.queue.shift().pcm);
  }

  #write(pcm) {
    if (this.muted || this.failed || this.stopping) return;
    if (!this.child && !this.#spawnPlayer()) return;
    const stdin = this.child.stdin;
    if (!stdin.writable) return;
    if (stdin.writableLength > this.rate * CHANNELS * 2 * 0.5) {
      this.dropped += 1; // more than half a second queued inside the player: it is not keeping up
      return;
    }
    const data = applyGain(pcm, this.volume);
    this.written += data.length;
    stdin.write(data);
  }

  #spawnPlayer() {
    const { cmd, args, name } = this.player;
    let child;
    try {
      child = this.spawnFn(cmd, args(this.rate), { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (err) {
      return this.#fail(new FriendlyError(`Could not start the audio player (${name}): ${err.message}`));
    }
    this.child = child;
    child.stdin.on('error', () => {}); // EPIPE when the player exits
    child.on('error', (err) => this.#fail(new FriendlyError(`Could not start the audio player (${name}): ${err.code === 'ENOENT' ? 'not found' : err.message}`)));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (!this.stopping && code !== 0 && code !== null) {
        this.#fail(new FriendlyError(`The audio player (${name}) stopped with exit code ${code}.`, 'Is an audio output device available? Try another player with --audio-player.'));
      }
    });
    return true;
  }

  #fail(err) {
    if (this.failed) return false;
    this.failed = err;
    this.queue.length = 0;
    this.emit('problem', err);
    return false;
  }

  #killPlayer() {
    const child = this.child;
    this.child = null;
    try {
      child?.stdin.end();
      child?.kill();
    } catch {
      /* already gone */
    }
  }

  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.queue.length = 0;
    this.#killPlayer();
  }
}

/**
 * Tap the sound of the page and play it.
 * @returns the AudioOut, plus mute / volume / delay controls that also tell the page to stop converting while muted
 */
export async function startAudio({ page, player, volume = 1, delayMs = 0, spawnFn }) {
  const out = new AudioOut({ player, volume, delayMs, spawnFn });
  await page.exposeFunction('__iaAudio', (rate, b64) => out.push(rate, Buffer.from(b64, 'base64')));
  await page.addInitScript(installAudioTap, { wanted: true, buffer: TAP_BUFFER_FRAMES }); // also for pages loaded later
  await page.evaluate(installAudioTap, { wanted: true, buffer: TAP_BUFFER_FRAMES }).catch(() => {});
  await page.evaluate(setAudioWanted, true).catch(() => {}); // in case the tap was already installed switched off
  out.start();
  return {
    out,
    get muted() {
      return out.muted;
    },
    get volume() {
      return out.volume;
    },
    get failed() {
      return out.failed;
    },
    async setMuted(m) {
      out.setMuted(m);
      await page.evaluate(setAudioWanted, !m).catch(() => {});
    },
    setVolume: (v) => out.setVolume(v),
    setDelay: (ms) => out.setDelay(ms),
    stop: () => out.stop(),
  };
}

/** For `--list audio`. */
export function describePlayers(which = findExecutable) {
  return PLAYERS.map((p) => ({ name: p.name, hint: p.hint, path: which(p.name) }));
}
