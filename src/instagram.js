import { inspectMainVideo } from './capture.js';
import { FriendlyError, sleep } from './util.js';

export const REELS_URL = 'https://www.instagram.com/reels/';
export const LOGIN_URL = 'https://www.instagram.com/accounts/login/';
/** Where sessions live and where the login form is. Overridable so the login flow can be tested against a local stand-in. */
export const INSTAGRAM = { origin: 'https://www.instagram.com', loginUrl: LOGIN_URL };

// The email/pass names were checked against the live login page. The 2FA field and the submit
// fallback are best-effort (they need a real account to exercise) and therefore list alternatives.
const SEL = {
  user: 'input[name="email"], input[name="username"], input[autocomplete~="username"]',
  pass: 'input[name="pass"], input[name="password"], input[type="password"]',
  code: 'input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label="Security code"]',
  submit: 'button[type="submit"], input[type="submit"]',
};

const MANUAL_HINT = 'Run `insta-ascii login --manual` to sign in by hand in a visible browser window.';

export class NotLoggedInError extends Error {
  constructor() {
    super('Instagram redirected to the login page: no valid session.');
  }
}

export const isInstagramUrl = (url) => {
  try {
    const host = new URL(url).hostname;
    return host === 'instagram.com' || host.endsWith('.instagram.com');
  } catch {
    return false;
  }
};

const isLoginUrl = (url) => /\/accounts\/login/.test(new URL(url).pathname);
const isChallengeUrl = (url) => /\/(challenge|accounts\/suspended|accounts\/disabled)/.test(new URL(url).pathname);

/** True when the browser profile holds an Instagram session cookie. */
export async function hasSession(context, site = INSTAGRAM) {
  const cookies = await context.cookies(site.origin);
  return cookies.some((c) => c.name === 'sessionid' && c.value);
}

/** Dismiss cookie banners and "Not now" prompts that sit in front of the page. */
export async function dismissPopups(page, { rounds = 3 } = {}) {
  // Order matters: for cookie banners prefer the privacy-preserving answer.
  const labels = [
    /^decline optional cookies$/i,
    /^only allow essential cookies$/i,
    /^allow essential and optional cookies$/i,
    /^allow all cookies$/i,
    /^not now$/i,
  ];
  for (let round = 0; round < rounds; round++) {
    let clicked = false;
    for (const name of labels) {
      const button = page.getByRole('button', { name }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 3000 }).catch(() => {});
        clicked = true;
        await sleep(500);
        break;
      }
    }
    if (!clicked) break;
  }
}

async function readLoginError(page) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const m = text.match(
    /^.*(password was incorrect|incorrect password|doesn.t belong to an account|couldn.t find an account|wait a few minutes|try again later|temporarily (blocked|locked)).*$/im,
  );
  return m ? m[0].trim().slice(0, 200) : null;
}

/**
 * Log in with a username and password in the (usually headless) browser.
 * `askCode(prompt)` is called if Instagram asks for a two-factor code.
 */
export async function login(page, context, { username, password, askCode, log, timeoutMs = 60_000, site = INSTAGRAM }) {
  log?.info('Signing in to Instagram…');
  await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await dismissPopups(page);

  const userBox = page.locator(SEL.user).first();
  try {
    await userBox.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    throw new FriendlyError('The Instagram login form did not appear.', `Re-run with --debug --headed to see the page. ${MANUAL_HINT}`);
  }
  await userBox.fill(username);
  const passBox = page.locator(SEL.pass).first();
  await passBox.fill(password);
  await passBox.press('Enter');

  const started = Date.now();
  let deadline = started + timeoutMs;
  let codeAttempts = 0;
  let clickedSubmit = false;
  while (Date.now() < deadline) {
    await sleep(700);
    if (await hasSession(context, site)) {
      await sleep(1500);
      await dismissPopups(page); // "Save your login info?" / "Turn on notifications"
      return;
    }
    if (isChallengeUrl(page.url())) {
      throw new FriendlyError('Instagram wants an extra security check before it will let this browser in.', MANUAL_HINT);
    }
    const codeBox = page.locator(SEL.code).first();
    if (await codeBox.isVisible().catch(() => false)) {
      if (!askCode) {
        throw new FriendlyError('Instagram asks for a two-factor code, but this run is not interactive.', MANUAL_HINT);
      }
      if (++codeAttempts > 3) throw new FriendlyError('Too many incorrect security codes.');
      const code = (await askCode(codeAttempts > 1 ? 'That code was not accepted. Security code: ' : 'Instagram security code: ')).trim();
      await codeBox.fill(code);
      await codeBox.press('Enter');
      await sleep(1500);
      deadline = Date.now() + timeoutMs;
      continue;
    }
    const problem = await readLoginError(page);
    if (problem) throw new FriendlyError(`Instagram rejected the login: ${problem}`, 'Check the username and password. If Instagram is rate-limiting you, wait a while.');
    if (!clickedSubmit && Date.now() - started > 4000 && (await userBox.isVisible().catch(() => false))) {
      clickedSubmit = true; // Enter did not submit; press the button too
      await page.locator(SEL.submit).first().click({ timeout: 2000 }).catch(() => {});
    }
  }
  throw new FriendlyError('Timed out waiting for Instagram to finish signing in.', MANUAL_HINT);
}

/** Open a visible window and wait for the person to sign in themselves (handles 2FA, captchas, checkpoints). */
export async function loginManually(page, context, { log, timeoutMs = 10 * 60_000, site = INSTAGRAM } = {}) {
  await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  log?.info('A browser window is open. Sign in to Instagram there; this continues by itself once you are in.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new FriendlyError('The browser window was closed before sign-in finished.');
    if (await hasSession(context, site)) {
      await sleep(2500); // let Instagram finish writing its cookies and storage
      return;
    }
    await sleep(1000);
  }
  throw new FriendlyError('Timed out waiting for you to sign in.');
}

/** Load the reels feed and wait until a video is actually playable. */
export async function openFeed(page, url, { onInstagram, log } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (onInstagram) {
    if (isLoginUrl(page.url())) throw new NotLoggedInError();
    await dismissPopups(page, { rounds: 2 });
  }
  try {
    await page.waitForFunction(
      (stills) =>
        [...document.querySelectorAll('video')].some((v) => v.readyState >= 2 && v.videoWidth > 0) ||
        // on pages that are not Instagram a plain picture will do (the app's "upload an image" case)
        (stills && [...document.querySelectorAll('img')].some((i) => i.complete && i.naturalWidth >= 200)),
      !onInstagram,
      { timeout: 30_000 },
    );
  } catch {
    if (onInstagram && isLoginUrl(page.url())) throw new NotLoggedInError();
    throw new FriendlyError(
      'No video started playing on the page.',
      'Re-run with --debug (saves a screenshot) or --headed to see what Instagram is showing.',
    );
  }
  log?.debug(`reels page ready at ${page.url()}`);
}

/** Moves through the feed the way a person would: arrow keys, with mouse wheel as a fallback. */
export class Reels {
  constructor(page, log) {
    this.page = page;
    this.log = log;
  }

  async #id() {
    const info = await this.page.evaluate(inspectMainVideo, { grabWidth: 0 });
    return info.ok ? info.id : null;
  }

  async #waitChange(before, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await sleep(150);
      const now = await this.#id().catch(() => null);
      if (now && now !== before) return true;
    }
    return false;
  }

  async #move(down) {
    const before = await this.#id();
    await this.page.keyboard.press(down ? 'ArrowDown' : 'ArrowUp');
    if (await this.#waitChange(before, 1500)) return true;
    const vp = this.page.viewportSize() ?? { width: 1280, height: 960 };
    await this.page.mouse.move(vp.width / 2, vp.height / 2);
    await this.page.mouse.wheel(0, down ? vp.height : -vp.height);
    return this.#waitChange(before, 2500);
  }

  next() {
    return this.#move(true);
  }

  prev() {
    return this.#move(false);
  }

  /** Pause/resume the reel on screen. Returns the new paused state (null if no video). */
  async togglePause() {
    return this.page.evaluate(() => {
      const v = window.__insta_ascii_main;
      if (!v || v.tagName !== 'VIDEO') return null;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
      return v.paused;
    });
  }
}
