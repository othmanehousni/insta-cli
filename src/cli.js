import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AsciiBridge, DEFAULT_APP_URL, engineSettings } from './ascii.js';
import { launchSession } from './browser.js';
import { FrameSource } from './capture.js';
import {
  NotLoggedInError,
  REELS_URL,
  Reels,
  dismissPopups,
  hasSession,
  isInstagramUrl,
  login,
  loginManually,
  openFeed,
} from './instagram.js';
import { promptHidden, promptLine } from './keys.js';
import { debugDir, ensurePrivateDir, ensureProfileDir, homeDir, removeProfile } from './paths.js';
import { detectDepth, fitCols, renderLines } from './terminal.js';
import { FriendlyError, UsageError, makeLogger } from './util.js';
import { COLORS, PALETTES, STYLES, runViewer } from './viewer.js';

const VERSION = '0.1.0';

const USAGE = `insta-ascii ${VERSION} — your Instagram Reels, in the terminal, rendered by the Devault ASCII generator

Usage
  insta-ascii [reels] [options]     watch the Reels feed (default command)
  insta-ascii login [--manual]      sign in and remember the session
  insta-ascii logout                forget the saved session

Keys while watching
  j / ↓   next reel          k / ↑   previous reel       space   pause / resume
  s       cycle style        c       cycle colour mode   p       cycle palette
  e       toggle outlines    i       invert              q       quit

Look
  -s, --style <name>     ${STYLES.join(' | ')}   [classic]
      --ramp <chars>     your own character ramp, light to dense, e.g. " .:-=+*#%@"
  -c, --color <mode>     ${COLORS.join(' | ')}   [source]
      --palette <name>   ${PALETTES.join(' | ')}   [devault] (with --color palette)
      --no-edges         turn off the app's outline glyphs (faster)
      --invert           invert brightness (light terminal backgrounds)
  -w, --cols <n>         maximum columns (default: as many as fit the terminal)
      --depth <mode>     auto | truecolor | 256 | none   [auto]
      --fps <n>          frame-rate cap   [15]

Source
      --capture <what>   video (the reel) | page (the whole viewport)   [video]
      --url <url>        open another page instead of instagram.com/reels/
      --once             print one frame to stdout and exit (no terminal needed)

Account & browser
  -u, --username <name>  Instagram username (else INSTAGRAM_USERNAME, else you are asked)
                         The password is read from INSTAGRAM_PASSWORD or typed in (never a flag).
      --manual           (login) sign in by hand in a visible browser window
      --browser <name>   auto | chrome | chromium   [auto]
      --headed           show the browser window
      --software-gl      allow software WebGL (headless machines without a GPU)
      --app-url <url>    ASCII generator app   [${DEFAULT_APP_URL}]
      --debug            verbose logging; saves a screenshot to ${path.join('~', '.insta-ascii', 'debug')} on failure
  -h, --help, -v, --version
`;

const OPTIONS = {
  style: { type: 'string', short: 's', default: 'classic' },
  ramp: { type: 'string' },
  color: { type: 'string', short: 'c', default: 'source' },
  palette: { type: 'string', default: 'devault' },
  'no-edges': { type: 'boolean', default: false },
  invert: { type: 'boolean', default: false },
  cols: { type: 'string', short: 'w' },
  depth: { type: 'string', default: 'auto' },
  fps: { type: 'string', default: '15' },
  capture: { type: 'string', default: 'video' },
  url: { type: 'string' },
  once: { type: 'boolean', default: false },
  username: { type: 'string', short: 'u' },
  manual: { type: 'boolean', default: false },
  browser: { type: 'string', default: 'auto' },
  headed: { type: 'boolean', default: false },
  'software-gl': { type: 'boolean', default: false },
  'app-url': { type: 'string', default: DEFAULT_APP_URL },
  debug: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

const oneOf = (name, value, allowed) => {
  if (!allowed.includes(value)) throw new UsageError(`--${name} must be one of: ${allowed.join(', ')} (got "${value}")`);
  return value;
};
const positiveInt = (name, value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive whole number (got "${value}")`);
  return n;
};

function resolveOptions(v) {
  if (v.ramp !== undefined && v.ramp.length < 2) throw new UsageError('--ramp needs at least two characters.');
  try {
    new URL(v['app-url']);
    if (v.url) new URL(v.url);
  } catch {
    throw new UsageError('--url / --app-url must be full URLs, e.g. https://www.instagram.com/reels/');
  }
  return {
    style: v.ramp ? 'custom' : oneOf('style', v.style, STYLES),
    ramp: v.ramp,
    color: oneOf('color', v.color, COLORS),
    palette: oneOf('palette', v.palette, PALETTES),
    edges: !v['no-edges'],
    invert: v.invert,
    cols: v.cols === undefined ? undefined : positiveInt('cols', v.cols),
    depth: oneOf('depth', v.depth, ['auto', 'truecolor', '256', 'none']),
    fps: positiveInt('fps', v.fps),
    capture: oneOf('capture', v.capture, ['video', 'page']),
    url: v.url ?? REELS_URL,
    once: v.once,
    username: v.username,
    manual: v.manual,
    browser: oneOf('browser', v.browser, ['auto', 'chrome', 'chromium']),
    headed: v.headed,
    softwareGl: v['software-gl'],
    appUrl: v['app-url'],
    debug: v.debug,
  };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const command = positionals[0] ?? 'reels';
  try {
    if (positionals.length > 1 || !['reels', 'login', 'logout'].includes(command)) {
      throw new UsageError(`Unknown command: ${positionals.join(' ')}`);
    }
    const opts = resolveOptions(values);
    if (command === 'logout') return cmdLogout();
    if (command === 'login') return await cmdLogin(opts);
    return await cmdReels(opts);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\nRun insta-ascii --help for usage.\n`);
      return 2;
    }
    if (err instanceof FriendlyError) {
      process.stderr.write(`error: ${err.message}\n${err.hint ? `hint: ${err.hint}\n` : ''}`);
      return 1;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------

function cmdLogout() {
  const removed = removeProfile();
  process.stdout.write(removed ? 'Signed out: the saved browser profile was deleted.\n' : 'Nothing to do: no saved session.\n');
  return 0;
}

async function getCredentials(opts) {
  const username = opts.username || process.env.INSTAGRAM_USERNAME;
  const password = process.env.INSTAGRAM_PASSWORD;
  const canAsk = process.stdin.isTTY && process.stderr.isTTY;
  if (username && password) return { username, password };
  if (!canAsk) {
    throw new FriendlyError(
      'Not signed in, and there is no terminal to ask for credentials.',
      'Set INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD, or run `insta-ascii login` once in a terminal.',
    );
  }
  const u = username || (await promptLine('Instagram username: ')).trim();
  const p = password || (await promptHidden('Password (hidden): '));
  if (!u || !p) throw new FriendlyError('A username and password are required.');
  return { username: u, password: p };
}

const askCode = () => (process.stdin.isTTY ? (q) => promptLine(q) : null);

async function signIn(page, context, opts, log, creds) {
  await login(page, context, { ...(creds ?? (await getCredentials(opts))), askCode: askCode(), log });
}

async function cmdLogin(opts) {
  const log = makeLogger(opts);
  // Ask for credentials first, so a typo in the prompt does not cost a browser start-up.
  const creds = opts.manual ? null : await getCredentials(opts);
  const session = await launchSession({
    profileDir: ensureProfileDir(),
    headed: opts.manual || opts.headed,
    viewport: opts.manual ? null : undefined, // a manual login window can size itself
    browser: opts.browser,
    softwareGl: opts.softwareGl,
    log,
  });
  try {
    const page = session.context.pages()[0] ?? (await session.context.newPage());
    if (opts.manual) await loginManually(page, session.context, { log });
    else await signIn(page, session.context, opts, log, creds);
    log.info(`Signed in. The session is saved in ${homeDir()} — run \`insta-ascii\` to watch reels.`);
    return 0;
  } catch (err) {
    await saveDebugShot(session.context, opts, 'login-failed', log);
    throw err;
  } finally {
    await session.close();
  }
}

async function saveDebugShot(context, opts, name, log) {
  if (!opts.debug) return;
  try {
    const page = context.pages().find((p) => !p.isClosed());
    if (!page) return;
    const file = path.join(ensurePrivateDir(debugDir()), `${name}-${Date.now()}.png`);
    await page.screenshot({ path: file });
    fs.chmodSync(file, 0o600);
    log.info(`Saved a screenshot of the failing page to ${file} (it may show account details; delete it when done).`);
  } catch {
    /* best effort */
  }
}

async function cmdReels(opts) {
  const log = makeLogger({ debug: opts.debug });
  if (!opts.once && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new UsageError('Watching needs an interactive terminal. Use --once to print a single frame instead.');
  }
  const onInstagram = isInstagramUrl(opts.url);
  const baseDepth = detectDepth(opts.depth);

  log.info('Starting the browser…');
  const session = await launchSession({
    profileDir: ensureProfileDir(),
    headed: opts.headed,
    browser: opts.browser,
    softwareGl: opts.softwareGl,
    log,
  });
  let bridge;
  try {
    const { context } = session;
    const page = context.pages()[0] ?? (await context.newPage());

    if (onInstagram && !(await hasSession(context))) await signIn(page, context, opts, log);

    log.info('Loading the ASCII generator…');
    bridge = await AsciiBridge.open(context, { appUrl: opts.appUrl, settings: engineSettings(opts) });

    log.info('Opening reels…');
    try {
      await openFeed(page, opts.url, { onInstagram, log });
    } catch (err) {
      if (!(err instanceof NotLoggedInError)) throw err;
      log.info('The saved session is no longer valid.');
      await signIn(page, context, opts, log);
      await openFeed(page, opts.url, { onInstagram, log });
    }
    if (onInstagram) await dismissPopups(page, { rounds: 1 });

    const frames = new FrameSource(page, { mode: opts.capture, log });
    const reels = new Reels(page, log);

    if (opts.once) return await printOnce({ frames, bridge, opts, baseDepth });
    await runViewer({ frames, reels, bridge, page, opts, baseDepth, log });
    return 0;
  } catch (err) {
    await saveDebugShot(session.context, opts, 'reels-failed', log);
    throw err;
  } finally {
    await bridge?.close();
    await session.close();
  }
}

async function printOnce({ frames, bridge, opts, baseDepth }) {
  let frame = null;
  for (let i = 0; i < 20 && !frame; i++) {
    frame = await frames.frame();
    if (!frame) await new Promise((r) => setTimeout(r, 250));
  }
  if (!frame) throw new FriendlyError('No frame could be captured from the page.');
  // An explicit --cols is honoured exactly; otherwise fit the terminal (80x40 when stdout is a pipe).
  const cols =
    opts.cols ??
    fitCols({
      termCols: process.stdout.columns || 80,
      termRows: process.stdout.rows || 40,
      srcW: frame.w,
      srcH: frame.h,
      reserveRows: 0,
    });
  const depth = opts.color === 'none' ? 'none' : baseDepth;
  const grid = await bridge.render(frame, { cols, color: depth !== 'none' });
  if (!grid) throw new FriendlyError('The ASCII engine returned nothing for this frame.');
  process.stdout.write(`${renderLines(grid, depth).join('\n')}\n`);
  return 0;
}
