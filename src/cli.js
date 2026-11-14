import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AsciiBridge, DEFAULT_APP_URL, flagSettings } from './ascii.js';
import { choosePlayer, describePlayers, startAudio } from './audio.js';
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
import { saveStill } from './export.js';
import {
  DEFAULT_LOOK,
  LOOK_IDS,
  PALETTE_IDS,
  PIXEL_ONLY_STYLES,
  STYLE_IDS,
  listing,
  parseSetting,
  resolveSettings,
} from './settings.js';
import { composeLines, detectDepth, fitCols, halfBlockLines } from './terminal.js';
import { FriendlyError, UsageError, makeLogger } from './util.js';
import { runViewer } from './viewer.js';

const COLORS = ['source', 'palette', 'mono', 'none'];

const VERSION = '0.1.0';

const USAGE = `insta-ascii ${VERSION} — your Instagram Reels, in the terminal, rendered by the Devault ASCII generator

Usage
  insta-ascii [reels] [options]     watch the Reels feed (default command)
  insta-ascii login [--manual]      sign in and remember the session
  insta-ascii logout                forget the saved session
  insta-ascii --list <what>         looks | styles | palettes | settings | audio

Keys while watching
  j / ↓   next reel          k / ↑   previous reel       space   pause / resume
  Tab     settings panel     l / L   next / previous look
  v       text / image / blocks rendering                 x       save a PNG (and .txt)
  r       record an MP4 (needs ffmpeg)                    q       quit
  o       compare with the original  ([ ] move the divider)
  a mute · 9 / 0 volume · , / . sound delay
  s style · c colour · p palette · e outlines · i invert · + / - detail

Look  (everything the Devault app offers: 13 styles, its preset looks and every slider)
      --look <id>        start from a look [${DEFAULT_LOOK}]; ${LOOK_IDS.slice(0, 6).join(', ')}, … (see --list looks)
  -s, --style <id>       ${STYLE_IDS.join(' | ')}
      --ramp <chars>     your own character ramp, light to dense, e.g. " .:-=+*#%@"
  -c, --color <mode>     ${COLORS.join(' | ')}   (none = plain text)
      --palette <id>     ${PALETTE_IDS.join(' | ')}
      --no-edges         turn off outline tracing
      --invert           invert brightness
  -w, --cols <n>         Detail (columns), 20-400
      --set <key=value>  any app setting, repeatable: --set underlay=60 --set bloom=30 (see --list settings)

Rendering
      --render <mode>    auto | text | image | blocks   [auto: image where the terminal can show it, else text]
                         text = real characters · image = the app's own canvas (every style and effect)
                         blocks = that canvas as half-block pixels (any truecolor terminal)
      --graphics <proto> auto | kitty | iterm2          image protocol (kitty, Ghostty / iTerm2, WezTerm)
      --scale <n>        image resolution multiplier, 0.2-3   [1]
      --depth <mode>     auto | truecolor | 256 | none   [auto]
      --fps <n>          frame-rate cap   [15]

Sound  (played through a command-line player: ffplay, mpv, sox, pw-cat, paplay or aplay)
      --no-audio         no sound
      --volume <n>       0-100   [100]
      --audio-player <p> auto | ffplay | mpv | play | pw-cat | paplay | aplay | a command reading raw
                         16-bit stereo PCM on stdin, e.g. "aplay -q -t raw -f S16_LE -r {rate} -c {channels} -"   [auto]
      --audio-delay <ms> auto | a fixed delay that holds the sound back behind the picture   [auto]

Source
      --capture <what>   video (the reel) | page (the whole viewport)   [video]
      --url <url>        open another page instead of instagram.com/reels/
      --file <path>      render a local image or video instead of Reels
      --once             print one frame to stdout and exit (no terminal needed)
      --out <file.png>   with --once: also save the app's canvas as a PNG at export resolution

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
  look: { type: 'string', default: DEFAULT_LOOK },
  style: { type: 'string', short: 's' },
  ramp: { type: 'string' },
  color: { type: 'string', short: 'c' },
  palette: { type: 'string' },
  'no-edges': { type: 'boolean', default: false },
  invert: { type: 'boolean', default: false },
  cols: { type: 'string', short: 'w' },
  set: { type: 'string', multiple: true },
  list: { type: 'string' },
  render: { type: 'string', default: 'auto' },
  graphics: { type: 'string', default: 'auto' },
  scale: { type: 'string', default: '1' },
  file: { type: 'string' },
  out: { type: 'string' },
  'no-audio': { type: 'boolean', default: false },
  volume: { type: 'string', default: '100' },
  'audio-player': { type: 'string', default: 'auto' },
  'audio-delay': { type: 'string', default: 'auto' },
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
  if (v.file && v.url) throw new UsageError('Use either --file or --url, not both.');
  let url = v.url ?? REELS_URL;
  if (v.file) {
    const abs = path.resolve(v.file);
    if (!fs.existsSync(abs)) throw new UsageError(`--file: no such file: ${v.file}`);
    url = pathToFileURL(abs).href;
  }
  const scale = Number(v.scale);
  if (!Number.isFinite(scale) || scale < 0.2 || scale > 3) throw new UsageError(`--scale must be a number from 0.2 to 3 (got "${v.scale}")`);
  if (v.out && !v.once) throw new UsageError('--out needs --once.');
  const volume = Number(v.volume);
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new UsageError(`--volume must be a whole number from 0 to 100 (got "${v.volume}")`);
  let audioDelay = 'auto';
  if (v['audio-delay'] !== 'auto') {
    audioDelay = Number(v['audio-delay']);
    if (!Number.isFinite(audioDelay) || audioDelay < 0 || audioDelay > 5000) throw new UsageError(`--audio-delay must be "auto" or a number of milliseconds from 0 to 5000 (got "${v['audio-delay']}")`);
  }
  if (v['audio-player'].trim() === '') throw new UsageError('--audio-player is empty.');
  return {
    look: oneOf('look', v.look, LOOK_IDS),
    style: v.style === undefined ? undefined : oneOf('style', v.style, STYLE_IDS),
    ramp: v.ramp,
    color: v.color === undefined ? undefined : oneOf('color', v.color, COLORS),
    palette: v.palette === undefined ? undefined : oneOf('palette', v.palette, PALETTE_IDS),
    edges: v['no-edges'] ? false : undefined,
    invert: v.invert ? true : undefined,
    cols: v.cols === undefined ? undefined : positiveInt('cols', v.cols),
    sets: (v.set ?? []).map(parseSetting),
    list: v.list,
    render: oneOf('render', v.render, ['auto', 'text', 'image', 'blocks']),
    graphics: oneOf('graphics', v.graphics, ['auto', 'kitty', 'iterm2']),
    scale,
    depth: oneOf('depth', v.depth, ['auto', 'truecolor', '256', 'none']),
    fps: positiveInt('fps', v.fps),
    capture: oneOf('capture', v.capture, ['video', 'page']),
    url,
    out: v.out,
    audio: !v['no-audio'],
    volume,
    audioPlayer: v['audio-player'],
    audioDelay,
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

  if (values.list !== undefined) {
    try {
      process.stdout.write(values.list === 'audio' ? audioListing() : listing(values.list));
      return 0;
    } catch (err) {
      if (err instanceof UsageError) {
        process.stderr.write(`${err.message}\n`);
        return 2;
      }
      throw err;
    }
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

function audioListing() {
  const lines = ['Audio players (the first one found is used; --audio-player picks another):'];
  const players = describePlayers();
  for (const p of players) lines.push(`  ${p.name.padEnd(8)} ${p.path ? `found  ${p.path}` : `-      (${p.hint})`}`);
  const first = players.find((p) => p.path);
  lines.push('', first ? `Sound will play through: ${first.name}` : 'None found: there will be no sound. Install ffmpeg (for ffplay), mpv or sox.');
  lines.push('A custom command may be given to --audio-player; it must read raw signed 16-bit little-endian stereo PCM on stdin.', '{rate} and {channels} in it are filled in. On macOS, `brew install ffmpeg` provides ffplay.');
  return `${lines.join('\n')}\n`;
}

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
  let sound = null;
  try {
    const { context } = session;
    const page = context.pages()[0] ?? (await context.newPage());

    if (onInstagram && !(await hasSession(context))) await signIn(page, context, opts, log);

    log.info('Loading the ASCII generator…');
    bridge = await AsciiBridge.open(context, { appUrl: opts.appUrl });
    // The app's own defaults and looks come from the live engine; flags and --set layer on top.
    const settings = resolveSettings(bridge.info, { look: opts.look, flags: flagSettings(opts), sets: opts.sets });
    await bridge.configure(settings);

    if (!opts.once && opts.audio) {
      const player = choosePlayer(opts.audioPlayer); // throws a friendly error for an explicit player that is missing
      if (player) {
        sound = await startAudio({ page, player, volume: opts.volume / 100, delayMs: typeof opts.audioDelay === 'number' ? opts.audioDelay : 0 });
        log.debug(`sound: ${player.name}`);
      } else {
        log.warn('no audio player found, so there will be no sound. Install ffmpeg (ffplay), mpv or sox; see --list audio.');
      }
    }

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

    if (opts.once) return await printOnce({ frames, bridge, opts, settings, baseDepth });
    await runViewer({ frames, reels, bridge, opts, settings, look: opts.look, baseDepth, audio: sound, log });
    return 0;
  } catch (err) {
    await saveDebugShot(session.context, opts, 'reels-failed', log);
    throw err;
  } finally {
    sound?.stop();
    await bridge?.close();
    await session.close();
  }
}

async function printOnce({ frames, bridge, opts, settings, baseDepth }) {
  let frame = null;
  for (let i = 0; i < 20 && !frame; i++) {
    frame = await frames.frame();
    if (!frame) await new Promise((r) => setTimeout(r, 250));
  }
  if (!frame) throw new FriendlyError('No frame could be captured from the page.');
  const depth = opts.color === 'none' ? 'none' : baseDepth;
  const pixelOnly = PIXEL_ONLY_STYLES.includes(settings.style);

  let lines;
  if (pixelOnly) {
    // film and particles are not made of characters: draw the app's canvas as half-block pixels
    const w = opts.cols ?? Math.min(process.stdout.columns || 80, 100);
    const h = Math.max(2, Math.round((frame.h / frame.w) * w) & ~1);
    const img = await bridge.renderImage(frame, { cols: settings.cols, w: w * 4, h: h * 4, encode: 'raw', rawW: w, rawH: h });
    if (!img) throw new FriendlyError('The ASCII engine returned nothing for this frame.');
    lines = halfBlockLines(img.data, w, h, depth);
  } else {
    // An explicit --cols is honoured exactly; otherwise fit the terminal (80x40 when stdout is a pipe).
    const cols =
      opts.cols ??
      fitCols({
        termCols: process.stdout.columns || 80,
        termRows: process.stdout.rows || 40,
        srcW: frame.w,
        srcH: frame.h,
        maxCols: settings.cols,
        reserveRows: 0,
      });
    const grid = await bridge.render(frame, { cols, time: 0, color: depth !== 'none' });
    if (!grid) throw new FriendlyError('The ASCII engine returned nothing for this frame.');
    lines = composeLines(grid, settings, { depth });
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  if (opts.out) {
    const dir = path.dirname(path.resolve(opts.out));
    const name = path.basename(opts.out).replace(/\.png$/i, '');
    const files = await saveStill({ bridge, frame, settings, time: 0, dir, name, textLines: null });
    process.stderr.write(`saved ${files.png}\n`);
  }
  return 0;
}
