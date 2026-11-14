import { configureEngine, initEngine, renderFrame, renderImage, scaleFrame } from './engine-page.js';
import { FriendlyError } from './util.js';

export const DEFAULT_APP_URL = 'https://devault-ascii.pages.dev/ascii-generator/app/';

// The app's own UI script animates a sample image in software GL, which on its own costs ~50ms per
// browser round-trip. We only need its engine module, so that one script is not allowed to boot.
// If the file is ever renamed this simply stops matching: still correct, just slower.
const APP_UI_ENTRY = /\/app-[A-Za-z0-9_-]+\.js$/;

/**
 * What the app page may do on the network: GET files from its own origin, nothing else.
 * ('skip-ui' = a same-origin file that is deliberately not loaded, see APP_UI_ENTRY.)
 *
 * This matters beyond the app's own Content-Security-Policy, which explicitly permits connections to
 * its auth and stats workers and to Google sign-in. Frames from your feed must not go to any of them.
 */
export function lockdownVerdict(method, url, origin) {
  const u = new URL(url);
  if (method !== 'GET' || u.origin !== origin) return 'block';
  return APP_UI_ENTRY.test(u.pathname) ? 'skip-ui' : 'allow';
}

/** The few CLI flags that are shorthand for app settings -> the app's own settings keys (undefined = not given). */
export function flagSettings({ style, ramp, color, palette, edges, invert, cols }) {
  return {
    style: ramp ? 'custom' : style,
    customRamp: ramp,
    colorMode: color === undefined || color === 'none' ? undefined : color,
    palette,
    edges,
    invert,
    cols,
  };
}

/**
 * Drives the Devault ASCII generator (hosted app) in a hidden browser tab.
 *
 * The tab is locked down: it may only issue GET requests to the app's own origin, so the frames we
 * hand it (which come from your Instagram feed) cannot be sent anywhere, whatever the page does.
 */
export class AsciiBridge {
  constructor(page, blocked, info) {
    this.page = page;
    /** URLs the lockdown refused (for diagnostics/tests). */
    this.blocked = blocked;
    /** What the live engine reports: { defaults, base, looks, palettes, styles }. */
    this.info = info;
  }

  static async open(context, { appUrl = DEFAULT_APP_URL, settings = {} } = {}) {
    const page = await context.newPage();
    const origin = new URL(appUrl).origin;
    const blocked = [];

    await page.setViewportSize({ width: 160, height: 120 }); // keeps the app's UI cheap if it ever does run
    await page.route('**/*', (route) => {
      const req = route.request();
      const verdict = lockdownVerdict(req.method(), req.url(), origin);
      if (verdict === 'allow') return route.continue();
      if (verdict === 'block') blocked.push(`${req.method()} ${req.url()}`);
      return route.abort();
    });
    page.on('popup', (popup) => popup.close().catch(() => {}));

    try {
      await page.goto(appUrl, { waitUntil: 'load', timeout: 30_000 });
    } catch (err) {
      await page.close().catch(() => {});
      throw new FriendlyError(
        `Could not load the ASCII generator at ${appUrl}: ${err.message.split('\n')[0]}`,
        'Check your internet connection, or point --app-url at another copy of the app.',
      );
    }

    let info;
    try {
      info = await page.evaluate(initEngine, settings);
    } catch (err) {
      await page.close().catch(() => {});
      const msg = String(err.message);
      if (msg.includes('ENGINE_NOT_FOUND')) {
        throw new FriendlyError(
          `Could not find the ASCII engine in ${appUrl}.`,
          'The app may have been redesigned since this CLI was written; check for an update.',
        );
      }
      if (/webgl|context/i.test(msg)) {
        throw new FriendlyError(
          'The ASCII engine needs WebGL2, which this browser did not provide.',
          'Try --software-gl (software rendering), --browser chrome, or --headed.',
        );
      }
      throw new FriendlyError(`The ASCII engine failed to start: ${msg.split('\n')[0]}`);
    }
    return new AsciiBridge(page, blocked, info);
  }

  /** Change app settings live (style, palette, colour mode, edges, invert, ...). */
  async configure(partial) {
    await this.page.evaluate(configureEngine, partial);
  }

  /**
   * The glyph grid for one frame (real characters + colours), for drawing text in the terminal.
   * @param frame  { kind: 'rgba', w, h, data } | { kind: 'image', mime, data }  (data is base64)
   * @returns {{ cols, rows, kind, lines, fg, alpha, bg, tint } | null}  the colour fields are Buffers (or null)
   */
  async render(frame, { cols, time = 0, color = true }) {
    const out = await this.page.evaluate(renderFrame, { frame, cols, time, withColor: color });
    if (!out) return null;
    const buf = (b64) => (b64 ? Buffer.from(b64, 'base64') : null);
    return {
      cols: out.cols,
      rows: out.lines.length,
      kind: out.kind,
      lines: out.lines,
      fg: buf(out.fg),
      alpha: buf(out.alpha),
      bg: buf(out.bg),
      tint: buf(out.tint),
    };
  }

  /**
   * The app's own canvas for one frame, with every style and effect, at a chosen pixel size.
   * @param encode 'png' | 'jpeg' | 'raw' (raw = RGBA at rawW x rawH, for half-block drawing)
   * @param compare 0..1: show the original picture left of this fraction of the width (the app's Compare)
   * @returns {{ w, h, cols, rows, mime, data: Buffer } | null}
   */
  async renderImage(frame, { cols, w, h, time = 0, encode = 'png', quality = 0.85, rawW, rawH, compare }) {
    const out = await this.page.evaluate(renderImage, { frame, cols, w, h, time, encode, quality, rawW, rawH, compare });
    if (!out) return null;
    return { ...out, data: Buffer.from(out.data, 'base64') };
  }

  /** The source picture as raw RGBA at w x h (optionally only its left `crop` fraction). */
  async scaleFrame(frame, { w, h, crop }) {
    return Buffer.from(await this.page.evaluate(scaleFrame, { frame, w, h, crop }), 'base64');
  }

  async close() {
    await this.page.close().catch(() => {});
  }
}
