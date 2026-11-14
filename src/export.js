import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, homeDir } from './paths.js';
import { FriendlyError } from './util.js';

export const shotsDir = () => path.join(homeDir(), 'shots');

const pad = (n) => String(n).padStart(2, '0');
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Pixel size for an export whose long side is `longSide`, keeping the source's aspect ratio. */
export function exportSize(srcW, srcH, longSide = 1920) {
  const k = longSide / Math.max(srcW, srcH);
  return { w: Math.max(2, Math.round(srcW * k)), h: Math.max(2, Math.round(srcH * k)) };
}

/**
 * Save the current frame the way the app's "Export image" does: the app's own canvas as a PNG at a high
 * resolution (every style and effect, whatever the terminal can show). When `textLines` is given the plain
 * text version is saved next to it.
 * @returns {{ png: string, txt?: string }} the files written
 */
export async function saveStill({ bridge, frame, settings, time, textLines, dir = shotsDir(), name = `reel-${stamp()}`, longSide = 1920 }) {
  ensurePrivateDir(dir);
  const { w, h } = exportSize(frame.w, frame.h, longSide);
  const img = await bridge.renderImage(frame, { cols: settings.cols, w, h, time, encode: 'png' });
  if (!img) throw new FriendlyError('Nothing to save yet: no frame has been captured.');
  const files = { png: path.join(dir, `${name}.png`) };
  fs.writeFileSync(files.png, img.data, { mode: 0o600 });
  if (textLines) {
    files.txt = path.join(dir, `${name}.txt`);
    fs.writeFileSync(files.txt, `${textLines.join('\n')}\n`, { mode: 0o600 });
  }
  return files;
}

/**
 * Records the app's canvas to an MP4, like the app's video export, by piping JPEG frames into ffmpeg.
 * Frames are timestamped by when they arrive, so the video plays at the speed you watched it.
 */
export class Recorder {
  /** @param ffmpeg path or name of the ffmpeg binary */
  constructor({ file, ffmpeg = 'ffmpeg' }) {
    this.file = file;
    this.frames = 0;
    this.error = null;
    this.child = spawn(
      ffmpeg,
      [
        '-loglevel', 'error', '-y',
        '-use_wallclock_as_timestamps', '1',
        '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', '-',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        file,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    this.stderr = '';
    this.child.stderr.on('data', (d) => (this.stderr += d));
    this.child.stdin.on('error', () => {});
    // Resolves when ffmpeg exits, or straight away if it could not even be started (which emits 'error' and never 'close').
    this.exited = new Promise((resolve) => {
      this.child.on('close', resolve);
      this.child.on('error', (err) => {
        this.error = err.code === 'ENOENT' ? new FriendlyError('Recording needs ffmpeg, which was not found.', 'Install ffmpeg (e.g. `brew install ffmpeg`) and try again.') : err;
        resolve(-1);
      });
    });
  }

  /** Add one JPEG frame. Waits if ffmpeg is falling behind. */
  async push(jpeg) {
    if (this.error) throw this.error;
    if (!this.child.stdin.writable) return;
    this.frames += 1;
    if (!this.child.stdin.write(jpeg)) await new Promise((r) => this.child.stdin.once('drain', r));
  }

  /** Finish the file. Resolves to { file, frames }. */
  async stop() {
    if (this.error) throw this.error;
    this.child.stdin.end();
    const code = await this.exited;
    if (this.error) throw this.error;
    if (code !== 0 || !this.frames) {
      throw new FriendlyError(`ffmpeg could not write the video${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : '.'}`);
    }
    return { file: this.file, frames: this.frames };
  }
}
