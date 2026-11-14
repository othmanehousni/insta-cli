import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Marker written into the profile dir so `logout` only ever deletes a directory this tool created. */
export const PROFILE_MARKER = '.insta-ascii-profile';

export function homeDir() {
  return path.resolve(process.env.INSTA_ASCII_HOME || path.join(os.homedir(), '.insta-ascii'));
}

export const profileDir = () => path.join(homeDir(), 'profile');
export const debugDir = () => path.join(homeDir(), 'debug');

/** Create a private (0700) directory; the browser profile holds the logged-in session. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* not supported on every platform/filesystem */
  }
  return dir;
}

export function ensureProfileDir() {
  ensurePrivateDir(homeDir());
  const dir = ensurePrivateDir(profileDir());
  const marker = path.join(dir, PROFILE_MARKER);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'created by insta-ascii\n', { mode: 0o600 });
  return dir;
}

/** Delete the saved session. Refuses to touch a directory that wasn't created by this tool. */
export function removeProfile() {
  const dir = profileDir();
  if (!fs.existsSync(dir)) return false;
  if (!fs.existsSync(path.join(dir, PROFILE_MARKER))) {
    throw new Error(`Refusing to delete ${dir}: it was not created by insta-ascii (marker file missing).`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
