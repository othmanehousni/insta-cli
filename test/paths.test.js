import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PROFILE_MARKER, ensureProfileDir, profileDir, removeProfile } from '../src/paths.js';
import { tmpDir } from './helpers.js';

describe('saved session storage', () => {
  let saved;
  beforeEach(() => {
    saved = process.env.INSTA_ASCII_HOME;
    process.env.INSTA_ASCII_HOME = tmpDir();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INSTA_ASCII_HOME;
    else process.env.INSTA_ASCII_HOME = saved;
  });

  it('creates a private profile directory with a marker', { skip: process.platform === 'win32' }, () => {
    const dir = ensureProfileDir();
    assert.equal(dir, profileDir());
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(dir)).mode & 0o777, 0o700);
    assert.ok(fs.existsSync(path.join(dir, PROFILE_MARKER)));
  });

  it('logout deletes a profile this tool created', () => {
    const dir = ensureProfileDir();
    fs.writeFileSync(path.join(dir, 'Cookies'), 'secret');
    assert.equal(removeProfile(), true);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(removeProfile(), false); // nothing left
  });

  it('logout refuses to delete a directory it did not create', () => {
    const dir = profileDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'precious.txt'), 'do not delete');
    assert.throws(() => removeProfile(), /not created by insta-ascii/);
    assert.ok(fs.existsSync(path.join(dir, 'precious.txt')));
  });
});
