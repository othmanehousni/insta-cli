import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lockdownVerdict } from '../src/ascii.js';

const ORIGIN = 'https://devault-ascii.pages.dev';
const verdict = (method, url) => lockdownVerdict(method, url, ORIGIN);

describe('lockdownVerdict', () => {
  it('allows GET requests for the app\'s own files, including the engine', () => {
    assert.equal(verdict('GET', `${ORIGIN}/ascii-generator/app/`), 'allow');
    assert.equal(verdict('GET', `${ORIGIN}/ascii-generator/assets/engine-KFb3x7U4.js`), 'allow');
    assert.equal(verdict('GET', `${ORIGIN}/ascii-generator/assets/edge.worker-BWxGAxQQ.js`), 'allow');
    assert.equal(verdict('GET', `${ORIGIN}/ascii-generator/assets/preload-helper-BnuTFHBF.js`), 'allow');
  });
  it('does not boot the app\'s own UI script, and does not confuse other files with it', () => {
    assert.equal(verdict('GET', `${ORIGIN}/ascii-generator/assets/app-XaF-hpZC.js`), 'skip-ui');
    assert.equal(verdict('GET', `${ORIGIN}/ascii-generator/assets/webapp-1.js`), 'allow');
    assert.equal(verdict('GET', `${ORIGIN}/ascii-generator/assets/app-Dx8QQc0S.css`), 'allow'); // styles are harmless
  });
  it('blocks anything that is not a same-origin GET', () => {
    assert.equal(verdict('POST', `${ORIGIN}/ascii-generator/app/`), 'block');
    assert.equal(verdict('PUT', `${ORIGIN}/x`), 'block');
    assert.equal(verdict('GET', 'https://devault-ascii-stats.rk360ironjr.workers.dev/'), 'block');
    assert.equal(verdict('GET', 'https://devault-ascii-auth.rk360ironjr.workers.dev/'), 'block');
    assert.equal(verdict('GET', 'https://accounts.google.com/gsi/client'), 'block');
    assert.equal(verdict('GET', 'https://evil.example/?ascii=' + ORIGIN), 'block');
  });
  it('treats another scheme, port or lookalike host as a different origin', () => {
    assert.equal(verdict('GET', 'http://devault-ascii.pages.dev/x'), 'block');
    assert.equal(verdict('GET', 'https://devault-ascii.pages.dev:8443/x'), 'block');
    assert.equal(verdict('GET', 'https://devault-ascii.pages.dev.evil.example/x'), 'block');
  });
});
