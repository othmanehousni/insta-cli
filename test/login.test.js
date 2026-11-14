// Tests the login state machine against a local stand-in for Instagram's login flow.
// This verifies OUR logic (filling the form, polling, 2FA prompt, error and challenge detection).
// It does not prove Instagram's real pages behave the same; see the README.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { launchSession } from '../src/browser.js';
import { FriendlyError } from '../src/util.js';
import { hasSession, login, loginManually } from '../src/instagram.js';
import { startMockLoginServer, tmpDir } from './helpers.js';

describe('login flow (mock Instagram)', () => {
  let mock;
  let session;
  let page;

  before(async () => {
    mock = await startMockLoginServer();
    session = await launchSession({ profileDir: tmpDir() });
    page = session.context.pages()[0] ?? (await session.context.newPage());
  });
  after(async () => {
    await session?.close();
    await mock?.close();
  });

  const attempt = (username, password, extra = {}) =>
    login(page, session.context, { username, password, site: mock.site, timeoutMs: 15_000, ...extra });

  async function reset() {
    await session.context.clearCookies();
  }

  it('signs in with a valid username and password', async () => {
    await reset();
    assert.equal(await hasSession(session.context, mock.site), false);
    await attempt('good', 'pw');
    assert.equal(await hasSession(session.context, mock.site), true);
  });

  it('reports a wrong password instead of hanging', async () => {
    await reset();
    await assert.rejects(attempt('good', 'nope'), (err) => {
      assert.ok(err instanceof FriendlyError);
      assert.match(err.message, /rejected the login.*password was incorrect/i);
      return true;
    });
    assert.equal(await hasSession(session.context, mock.site), false);
  });

  it('asks for the two-factor code and finishes sign-in with it', async () => {
    await reset();
    const asked = [];
    await attempt('twofa', 'pw', { askCode: async (q) => (asked.push(q), '123456') });
    assert.equal(asked.length, 1);
    assert.equal(await hasSession(session.context, mock.site), true);
  });

  it('asks again after a wrong two-factor code', async () => {
    await reset();
    const codes = ['000000', '123456'];
    const asked = [];
    await attempt('twofa-retry', 'pw', { askCode: async (q) => (asked.push(q), codes.shift()) });
    assert.equal(asked.length, 2);
    assert.match(asked[1], /not accepted/i);
    assert.equal(await hasSession(session.context, mock.site), true);
  });

  it('gives up after repeated wrong codes', async () => {
    await reset();
    await assert.rejects(
      attempt('twofa', 'pw', { askCode: async () => '000000' }),
      (err) => err instanceof FriendlyError && /too many incorrect/i.test(err.message),
    );
  });

  it('explains that 2FA needs a terminal when the run is not interactive', async () => {
    await reset();
    await assert.rejects(attempt('twofa', 'pw', { askCode: null }), (err) => {
      assert.match(err.message, /two-factor.*not interactive/i);
      assert.match(err.hint, /login --manual/);
      return true;
    });
  });

  it('points to manual login when Instagram demands a security check', async () => {
    await reset();
    await assert.rejects(attempt('challenge', 'pw'), (err) => {
      assert.match(err.message, /security check/i);
      assert.match(err.hint, /login --manual/);
      return true;
    });
  });

  it('manual login completes as soon as the person has signed in', async () => {
    await reset();
    const done = loginManually(page, session.context, { site: mock.site, timeoutMs: 30_000 });
    await page.waitForSelector('input[name="email"]');
    await page.fill('input[name="email"]', 'good');
    await page.fill('input[name="pass"]', 'pw');
    await page.click('input[type="submit"]');
    await done;
    assert.equal(await hasSession(session.context, mock.site), true);
  });
});
