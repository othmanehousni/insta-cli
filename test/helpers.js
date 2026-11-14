import { spawn } from 'node:child_process';
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
