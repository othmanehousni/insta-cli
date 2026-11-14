import { chromium } from 'playwright';
import { FriendlyError } from './util.js';

/**
 * Launch a persistent browser profile. The profile directory is where the Instagram login lives, so
 * `login` and `reels` share it and you only log in once.
 *
 * browser: 'auto' (installed Google Chrome if present, else Playwright's Chromium) | 'chrome' | 'chromium'
 * viewport: fixed page size (the reel is captured from it); pass null for a free-sized window
 */
export async function launchSession({
  profileDir,
  headed = false,
  browser = 'auto',
  softwareGl = false,
  viewport = { width: 1280, height: 960 },
  log,
}) {
  const args = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];
  if (softwareGl) args.push('--enable-unsafe-swiftshader'); // opt-in: lets headless browsers without a GPU provide WebGL

  const channels = browser === 'chrome' ? ['chrome'] : browser === 'chromium' ? [undefined] : ['chrome', undefined];
  let lastError;
  for (const channel of channels) {
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        headless: !headed,
        ...(channel ? { channel } : {}),
        viewport, // null lets a visible window size itself
        args,
      });
      log?.debug(`browser: ${channel ?? 'playwright chromium'}${headed ? ' (headed)' : ''}`);
      return {
        context,
        browserName: channel ?? 'chromium',
        close: async () => {
          await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
        },
      };
    } catch (err) {
      lastError = err;
      const msg = String(err.message);
      if (/ProcessSingleton|profile (appears to be|is) in use|SingletonLock/i.test(msg)) {
        throw new FriendlyError(
          'Another browser is already using the insta-ascii profile.',
          'Close the other insta-ascii run (or any leftover browser) and try again.',
        );
      }
      if (/Missing X server|\$DISPLAY|headed browser without having a XServer/i.test(msg)) {
        throw new FriendlyError(
          'A visible browser window was requested but no display is available.',
          'Run this on a machine with a desktop, or omit --headed / --manual.',
        );
      }
      log?.debug(`launch with ${channel ?? 'chromium'} failed: ${msg.split('\n')[0]}`);
    }
  }
  throw new FriendlyError(
    `Could not start a browser (${String(lastError?.message).split('\n')[0]}).`,
    'Install Google Chrome, or run: npx playwright install chromium',
  );
}
