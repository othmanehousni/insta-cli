import { configureEngine, initEngine, renderFrame } from './engine-page.js';
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

/** CLI options -> the app's own settings keys. */
export function engineSettings({ style, ramp, color, palette, edges, invert }) {
  return {
    style: ramp ? 'custom' : style,
    ...(ramp ? { customRamp: ramp } : {}),
    colorMode: color === 'source' ? 'source' : color === 'palette' ? 'palette' : 'mono',
    palette,
    edges,
    invert,
    bgMode: 'dark',
  };
}

/**
 * Drives the Devault ASCII generator (hosted app) in a hidden browser tab.
 *
 * The tab is locked down: it may only issue GET requests to the app's own origin, so the frames we
 * hand it (which come from your Instagram feed) cannot be sent anywhere, whatever the page does.
 */
export class AsciiBridge {
  constructor(page, blocked) {
    this.page = page;
    /** URLs the lockdown refused (for diagnostics/tests). */
    this.blocked = blocked;
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

    try {
      await page.evaluate(initEngine, settings);
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
    return new AsciiBridge(page, blocked);
  }

  /** Change app settings live (style, palette, colour mode, edges, invert, ...). */
  async configure(partial) {
    await this.page.evaluate(configureEngine, partial);
  }

  /**
   * @param frame  { kind: 'rgba', w, h, data } | { kind: 'image', mime, data }  (data is base64)
   * @returns {{ cols: number, rows: number, lines: string[], rgb: Buffer | null } | null}
   */
  async render(frame, { cols, color = true }) {
    const out = await this.page.evaluate(renderFrame, { frame, cols, withColor: color });
    if (!out) return null;
    return {
      cols: out.cols,
      rows: out.lines.length,
      lines: out.lines,
      rgb: out.rgb ? Buffer.from(out.rgb, 'base64') : null,
    };
  }

  async close() {
    await this.page.close().catch(() => {});
  }
}
