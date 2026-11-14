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
/** A player that dies within this long of starting did not accept its arguments or its audio device: try the next variant. */
const EARLY_EXIT_MS = 4000;

/**
 * A 44-byte WAV header for a stream of unknown length (sizes 0xFFFFFFFF), so a player can read the format from
 * the stream itself instead of from command-line options whose spelling differs between versions.
 */
export function wavHeader(rate, channels = CHANNELS, bits = 16) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(0xffffffff, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE((rate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(0xffffffff, 40);
  return h;
}

const ffplayBase = ['-nodisp', '-autoexit', '-loglevel', 'warning', '-fflags', 'nobuffer', '-flags', 'low_delay'];

/**
 * Players that can read audio on stdin, in order of preference. Each has one or more `variants`: ways of
 * invoking it. If a player dies right after starting, the next variant is tried, so a spelling that some version
 * of the player rejects does not mean no sound. `wav: true` means the stream starts with a WAV header; otherwise
 * it is raw signed 16-bit little-endian stereo and the arguments describe it.
 */
export const PLAYERS = [
  {
    name: 'ffplay',
    hint: 'comes with ffmpeg',
    variants: [
      { id: 'wav', label: 'self-describing WAV stream', wav: true, realtime: true, args: () => [...ffplayBase, '-probesize', '4096', '-analyzeduration', '100000', '-i', '-'] },
      { id: 'raw-ac', label: 'raw PCM, -ar/-ac options', realtime: true, args: (r) => [...ffplayBase, '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', String(r), '-ac', String(CHANNELS), '-i', '-'] },
      { id: 'raw-layout', label: 'raw PCM, -ch_layout option', realtime: true, args: (r) => [...ffplayBase, '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', String(r), '-ch_layout', 'stereo', '-i', '-'] },
    ],
  },
  {
    name: 'mpv',
    hint: 'mpv.io',
    variants: [{ id: 'raw', label: 'raw PCM', realtime: true, args: (r) => ['--no-config', '--no-video', '--msg-level=all=error', '--force-window=no', '--input-terminal=no', '--demuxer=rawaudio', '--demuxer-rawaudio-format=s16le', `--demuxer-rawaudio-rate=${r}`, `--demuxer-rawaudio-channels=${CHANNELS}`, '--audio-buffer=0.2', '--cache=no', '-'] }],
  },
  { name: 'play', hint: 'comes with SoX', variants: [{ id: 'raw', label: 'raw PCM', realtime: true, args: (r) => ['-q', '-t', 'raw', '-r', String(r), '-e', 'signed-integer', '-b', '16', '-c', String(CHANNELS), '-'] }] },
  { name: 'pw-cat', hint: 'PipeWire', variants: [{ id: 'raw', label: 'raw PCM', realtime: true, args: (r) => ['--playback', '--rate', String(r), '--channels', String(CHANNELS), '--format', 's16', '-'] }] },
  { name: 'paplay', hint: 'PulseAudio', variants: [{ id: 'raw', label: 'raw PCM', realtime: true, args: (r) => ['--raw', `--rate=${r}`, `--channels=${CHANNELS}`, '--format=s16le', '--latency-msec=100'] }] },
  { name: 'aplay', hint: 'ALSA', variants: [{ id: 'raw', label: 'raw PCM', realtime: true, args: (r) => ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(r), '-c', String(CHANNELS), '-'] }] },
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
 * @returns {{ name, cmd, variants: [{ id, label, wav?, args(rate) }] } | null}  null when nothing is available (only for 'auto')
 */
export function choosePlayer(preference = 'auto', which = findExecutable) {
  if (!preference || preference === 'auto') {
    for (const p of PLAYERS) {
      const cmd = which(p.name);
      if (cmd) return { name: p.name, cmd, variants: p.variants };
    }
    return null;
  }
  const known = PLAYERS.find((p) => p.name === preference);
  if (known) {
    const cmd = which(known.name);
    if (!cmd) throw new FriendlyError(`The audio player "${known.name}" was not found.`, `Install it (${known.hint}), or use --audio-player auto.`);
    return { name: known.name, cmd, variants: known.variants };
  }
  const [cmd, ...rest] = parseCommand(preference);
  return { name: path.basename(cmd), cmd, variants: [{ id: 'custom', label: 'your command', realtime: false, args: (rate) => rest.map((a) => a.replace('{rate}', String(rate)).replace('{channels}', String(CHANNELS))) }] };
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
 * The part of a player's error output that says what went wrong, on one line. Players are chatty: ALSA alone
 * prints a screenful of configuration lookups around the one line that matters ("Couldn't open audio device").
 */
export function reasonFrom(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const noise = (l) => /^ALSA lib /.test(l) || /^\[AVIOContext/.test(l) || /^Statistics:/.test(l) || /snd_func_|snd_config_|snd_pcm_open|parse_card|confmisc|conf\.c/.test(l);
  const unique = (list) => [...new Set(list)];
  // 1. the lines that name the actual problem
  const decisive = /SDL_OpenAudio|audio open failed|Couldn't open audio|Unrecognized option|Option .* not found|Device or resource busy|Permission denied|No such device/i;
  const named = unique(lines.filter((l) => decisive.test(l) && !noise(l)));
  if (named.length) return named.slice(-3).join(' | ').slice(0, 320);
  // 2. anything that sounds like an error
  const generic = /Failed|Could not|Invalid|not found|denied|unavailable|Unknown|Cannot|Can't|can't|error/i;
  const errors = unique(lines.filter((l) => generic.test(l) && !noise(l)));
  if (errors.length) return errors.slice(-3).join(' | ').slice(0, 320);
  // 3. whatever it last said
  const rest = lines.filter((l) => !noise(l));
  return (rest.length ? rest : lines).slice(-2).join(' | ').slice(0, 320);
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
    this.killedByUs = new WeakSet(); // players we stopped on purpose (restart for a new rate): their exit is not a failure
    this.variant = 0; // index into player.variants
    this.attempts = []; // [{ label, code, error }] for variants that died early
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
    const { cmd, name, variants } = this.player;
    const variant = variants[this.variant];
    let child;
    try {
      child = this.spawnFn(cmd, variant.args(this.rate), { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      return this.#fail(new FriendlyError(`Could not start the audio player (${name}): ${err.message}`));
    }
    this.child = child;
    const startedAt = this.now();
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    child.stdin.on('error', () => {}); // EPIPE when the player exits
    child.on('error', (err) => this.#fail(new FriendlyError(`Could not start the audio player (${name}): ${err.code === 'ENOENT' ? 'not found' : err.message}`)));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping || this.killedByUs.has(child)) return;
      // We never close the player's stdin while playing, so it has no reason to stop on its own: a clean exit
      // (code 0) is also a failure. Some players quit silently with 0 when they cannot open an audio device.
      const reason = reasonFrom(stderr);
      const how = code ? `stopped with exit code ${code}` : signal ? `was killed (${signal})` : 'quit by itself without playing anything';
      this.attempts.push({ label: variant.label, code, error: reason });
      const early = this.now() - startedAt < EARLY_EXIT_MS;
      if (early && this.variant + 1 < variants.length) {
        this.variant += 1; // the next chunk starts the next variant
        this.emit('retry', { from: variant, to: variants[this.variant], code, error: reason });
        return;
      }
      const tried = this.attempts.length > 1 ? ` (tried: ${this.attempts.map((a) => a.label).join('; ')})` : '';
      this.#fail(
        new FriendlyError(
          `The audio player (${name}) ${how}${reason ? `: ${reason}` : ''}${tried}`,
          `Run \`insta-ascii audio-test\` to see what ${name} says, or pick another player with --audio-player (see --list audio).`,
        ),
      );
    });
    if (variant.wav) child.stdin.write(wavHeader(this.rate));
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
    if (child) this.killedByUs.add(child);
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

/** A short, pleasant test tone as raw 16-bit stereo PCM (440 Hz with a quick fade in and out). */
export function beep(rate, seconds = 1, hz = 440, amplitude = 0.25) {
  const n = Math.round(rate * seconds);
  const fade = Math.round(rate * 0.05);
  const pcm = Buffer.alloc(n * CHANNELS * 2);
  for (let i = 0; i < n; i++) {
    const envelope = Math.min(1, i / fade, (n - 1 - i) / fade);
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amplitude * envelope * 32767);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  return pcm;
}

/**
 * Play a beep through each variant of a player, in order, stopping at the first that works.
 * @returns [{ variant, ok, code, error, ms }]
 */
export async function testPlayer(player, { rate = 48000, seconds = 1, timeoutMs = 15_000, spawnFn = spawn } = {}) {
  const pcm = beep(rate, seconds);
  const results = [];
  for (const variant of player.variants) {
    const result = await new Promise((resolve) => {
      const t0 = Date.now();
      let stderr = '';
      let timer;
      const done = (r) => {
        clearTimeout(timer);
        resolve({ ms: Date.now() - t0, ...r });
      };
      let child;
      try {
        child = spawnFn(player.cmd, variant.args(rate), { stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (err) {
        return done({ ok: false, code: null, error: err.message });
      }
      child.stderr?.on('data', (d) => {
        stderr = (stderr + d).slice(-2000);
      });
      child.stdin.on('error', () => {});
      child.on('error', (err) => done({ ok: false, code: null, error: err.code === 'ENOENT' ? 'not found' : err.message }));
      child.on('close', (code) => {
        const ms = Date.now() - t0;
        const reason = reasonFrom(stderr);
        // A real player takes about as long as the audio to play it. Exiting 0 far sooner means it gave up
        // (typically: no usable audio output) without saying so through its exit code.
        if (code === 0 && variant.realtime !== false && ms < seconds * 1000 * 0.7) {
          return done({ ok: false, code, error: `it exited after ${(ms / 1000).toFixed(1)} s, before a ${seconds} s beep could have played${reason ? `: ${reason}` : ' (usually: no usable audio output)'}` });
        }
        done({ ok: code === 0, code, error: reason });
      });
      timer = setTimeout(() => {
        child.kill();
        done({ ok: false, code: null, error: 'it never finished playing' });
      }, timeoutMs);
      if (variant.wav) child.stdin.write(wavHeader(rate));
      child.stdin.end(pcm);
    });
    results.push({ variant, ...result });
    if (result.ok) break;
  }
  return results;
}
