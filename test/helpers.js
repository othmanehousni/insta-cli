import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');
export const BIN = path.join(ROOT, 'bin', 'insta-ascii.js');

export const tmpDir = (prefix = 'insta-ascii-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Serves test/fixtures/* (and anything in `extra`) on a random local port. */
export async function startFixtureServer(extra = {}) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (extra[pathname]) return extra[pathname](req, res);
    const file = path.join(here, 'fixtures', pathname === '/' ? 'mock-reels.html' : path.basename(pathname));
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.webm') ? 'video/webm' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(res);
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(r)) };
}

/**
 * A stand-in for the Instagram login flow, built from what the real login page's DOM looks like
 * (input[name=email], input[name=pass], a submit input). Behaviour is chosen by username:
 *   good / twofa / twofa-retry -> sessions, with a 2FA step for the twofa* users (code 123456)
 *   bad                        -> "password was incorrect" error
 *   challenge                  -> redirect to /challenge/
 */
export async function startMockLoginServer() {
  const form = (note = '') => `<!doctype html><title>Login</title><body>
    <p>${note}</p>
    <form method="post" action="/accounts/login/">
      <input name="email" type="text" autocomplete="username webauthn">
      <input name="pass" type="password">
      <input type="submit" value="Log in">
    </form></body>`;
  const codeForm = (note = '') => `<!doctype html><title>Security code</title><body>
    <p>${note}</p>
    <form method="post" action="/accounts/login/two_factor/">
      <input name="verificationCode" type="text" autocomplete="one-time-code">
      <input type="submit" value="Confirm">
    </form></body>`;
  const body = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(new URLSearchParams(data)));
    });
  const login = (res) => res.writeHead(302, { 'set-cookie': 'sessionid=mock-session; Path=/; HttpOnly', location: '/' }).end();
  const html = (res, content) => res.writeHead(200, { 'content-type': 'text/html' }).end(content);

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (req.method === 'GET' && pathname === '/accounts/login/') return html(res, form());
    if (req.method === 'GET' && pathname === '/challenge/') return html(res, '<title>Challenge</title>Confirm it is you');
    if (req.method === 'GET') return html(res, '<title>Home</title>home');
    const params = await body(req);
    if (pathname === '/accounts/login/') {
      const user = params.get('email');
      if (params.get('pass') !== 'pw') return html(res, form('Sorry, your password was incorrect. Please double-check your password.'));
      if (user === 'challenge') return res.writeHead(302, { location: '/challenge/' }).end();
      if (user.startsWith('twofa')) return html(res, codeForm());
      return login(res);
    }
    if (pathname === '/accounts/login/two_factor/') {
      return params.get('verificationCode') === '123456' ? login(res) : html(res, codeForm("That code isn't valid."));
    }
    return res.writeHead(404).end();
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    site: { origin, loginUrl: `${origin}/accounts/login/` },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Run the CLI as a child process and collect its output. */
export function runCli(args, { env = {}, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** An RGBA frame (base64) with a solid disc on a dark background, for exercising the engine directly. */
export function discFrame({ w = 120, h = 213, disc = [255, 255, 255], bg = [0, 0, 0] } = {}) {
  const px = Buffer.alloc(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  const radius = w * 0.35;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
      const c = inside ? disc : bg;
      px.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return { kind: 'rgba', w, h, data: px.toString('base64') };
}

/** True when util-linux `script` is available (it gives a child a real pseudo-terminal). */
export function canPty() {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('script', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the CLI inside a real pseudo-terminal of the given size and drive it with keys.
 * Returns { output(), waitFor(pattern, {from, timeout}), send(keys), finish() }.
 * `output()` is everything the program has printed so far, escape sequences included.
 */
export function runInPty(args, { cols = 110, rows = 40, env = {} } = {}) {
  const quoted = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  const child = spawn('script', ['-qfec', `stty cols ${cols} rows ${rows}; exec ${process.execPath} ${BIN} ${quoted}`, '/dev/null'], {
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  // Streaming UTF-8 decoders: a multi-byte character (▀, ·, …) split across two reads must not be corrupted.
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  child.stdout.on('data', (d) => (out += decoders.stdout.write(d)));
  child.stderr.on('data', (d) => (out += decoders.stderr.write(d)));
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return {
    output: () => out,
    send: (keys) => child.stdin.write(keys),
    /** Wait until `pattern` (string or RegExp) shows up in the output after offset `from`. */
    async waitFor(pattern, { from = 0, timeout = 60_000 } = {}) {
      const end = Date.now() + timeout;
      for (;;) {
        const hay = out.slice(from);
        const hit = typeof pattern === 'string' ? hay.indexOf(pattern) : hay.search(pattern);
        if (hit >= 0) return out.length;
        if (Date.now() > end) throw new Error(`timed out waiting for ${pattern}\n--- output tail ---\n${JSON.stringify(out.slice(-600))}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async finish({ quitKey = 'q', timeout = 20_000 } = {}) {
      child.stdin.write(quitKey);
      const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r('timeout'), timeout))]);
      if (code === 'timeout') child.kill('SIGKILL');
      return code;
    },
    kill: () => child.kill('SIGKILL'),
  };
}

/** True when ffmpeg is installed (several tests build their media with it). */
export function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Two 8-second 9:16 videos with sound: 440 Hz and 880 Hz sine tones (Opus in WebM), plus a silent one.
 * Written into `dir`. Returns null when ffmpeg is missing.
 */
export function makeToneMedia(dir) {
  if (!hasFfmpeg()) return null;
  const make = (file, hz) =>
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=8`, '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=15:duration=8', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-b:a', '64k', '-shortest', path.join(dir, file)]);
  make('tone440.webm', 440);
  make('tone880.webm', 880);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=15:duration=8', '-c:v', 'libvpx', '-b:v', '300k', '-an', path.join(dir, 'silent.webm')]);
  return dir;
}

/** A feed of reels, one per file, that scrolls with ArrowDown/ArrowUp like the real page. The videos start MUTED, like Instagram's. */
export const feedPage = (files) => `<!doctype html><meta charset="utf-8"><title>sound feed</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#feed{height:100vh;overflow-y:scroll;scroll-snap-type:y mandatory;scrollbar-width:none}
section{height:100vh;scroll-snap-align:start;display:flex;justify-content:center;align-items:center}video{height:100vh;aspect-ratio:9/16;background:#111}</style>
<div id="feed">${files.map((f) => `<section><video src="${f}" muted loop autoplay playsinline></video></section>`).join('')}</div>
<script>
  document.querySelectorAll('video').forEach((v) => v.play().catch(() => {}));
  addEventListener('keydown', (e) => { const f = document.getElementById('feed');
    if (e.key === 'ArrowDown') f.scrollBy({ top: innerHeight }); if (e.key === 'ArrowUp') f.scrollBy({ top: -innerHeight }); });
</script>`;

/** Energy of `freq` in interleaved 16-bit stereo PCM (left channel), by the Goertzel algorithm. */
export function toneEnergy(pcm, rate, freq) {
  const n = Math.floor(pcm.length / 4);
  const w = (2 * Math.PI * freq) / rate;
  const k = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = pcm.readInt16LE(i * 4) / 32768 + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (n * n);
}

/** Which of `candidates` (Hz) carries the most energy in the PCM. */
export function dominantFrequency(pcm, rate, candidates = [220, 330, 440, 660, 880, 1320]) {
  return candidates.map((f) => [f, toneEnergy(pcm, rate, f)]).sort((a, b) => b[1] - a[1])[0][0];
}

/** RMS of the left channel of interleaved 16-bit stereo PCM, as a fraction of full scale. */
export function rmsOf(pcm) {
  const n = Math.floor(pcm.length / 4);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (pcm.readInt16LE(i * 4) / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, n));
}

/** A stand-in for a spawned player process: records its arguments and everything written to its stdin. */
export function fakeSpawn() {
  const calls = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    const chunks = [];
    child.stdin.on('data', (d) => chunks.push(d));
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.emit('exit', null);
    };
    calls.push({ cmd, args, chunks, child });
    return child;
  };
  return { spawnFn, calls, pcm: (i = 0) => Buffer.concat(calls[i]?.chunks ?? []) };
}
