import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Recorder, exportSize, saveStill, stamp } from '../src/export.js';
import { FriendlyError } from '../src/util.js';
import { tmpDir } from './helpers.js';

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('exportSize', () => {
  it('keeps the aspect ratio and sets the long side', () => {
    assert.deepEqual(exportSize(540, 960, 1920), { w: 1080, h: 1920 });
    assert.deepEqual(exportSize(1600, 900, 1920), { w: 1920, h: 1080 });
    assert.deepEqual(exportSize(100, 100, 50), { w: 50, h: 50 });
  });
  it('never returns a zero-size image', () => {
    const { w, h } = exportSize(5000, 1, 100);
    assert.ok(w >= 2 && h >= 2);
  });
});

describe('stamp', () => {
  it('is a sortable timestamp', () => {
    assert.match(stamp(new Date(2026, 10, 14, 9, 5, 7)), /^20261114-090507$/);
  });
});

describe('saveStill', () => {
  const frame = { kind: 'rgba', w: 90, h: 160, data: '' };

  it('writes the app\'s canvas as a private PNG at the export size, plus the text when given', async () => {
    const dir = path.join(tmpDir(), 'shots');
    let asked;
    const bridge = {
      async renderImage(f, opts) {
        asked = opts;
        return { data: Buffer.from('\x89PNG fake') };
      },
    };
    const files = await saveStill({ bridge, frame, settings: { cols: 150 }, time: 2, textLines: ['ab', 'cd'], dir, name: 'shot' });
    assert.equal(files.png, path.join(dir, 'shot.png'));
    assert.equal(fs.readFileSync(files.png, 'utf8'), '\x89PNG fake');
    assert.equal(fs.readFileSync(files.txt, 'utf8'), 'ab\ncd\n');
    assert.deepEqual({ cols: asked.cols, w: asked.w, h: asked.h, time: asked.time, encode: asked.encode }, { cols: 150, w: 1080, h: 1920, time: 2, encode: 'png' });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(files.png).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }
  });
  it('writes only the PNG when there is no text', async () => {
    const dir = tmpDir();
    const files = await saveStill({ bridge: { renderImage: async () => ({ data: Buffer.from('x') }) }, frame, settings: { cols: 100 }, dir, name: 'only' });
    assert.equal(files.txt, undefined);
    assert.ok(!fs.existsSync(path.join(dir, 'only.txt')));
  });
  it('says so when there is nothing to save', async () => {
    await assert.rejects(saveStill({ bridge: { renderImage: async () => null }, frame, settings: { cols: 100 }, dir: tmpDir() }), FriendlyError);
  });
});

describe('Recorder', () => {
  it('turns pushed JPEG frames into a playable H.264 MP4', async (t) => {
    if (!hasFfmpeg()) return t.skip('ffmpeg is not installed');
    const jpeg = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1', '-frames:v', '1', '-f', 'mjpeg', '-']);
    const file = path.join(tmpDir(), 'out.mp4');
    const rec = new Recorder({ file });
    for (let i = 0; i < 6; i++) {
      await rec.push(jpeg);
      await new Promise((r) => setTimeout(r, 120));
    }
    const done = await rec.stop();
    assert.equal(done.frames, 6);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'csv=p=0', file]).toString().trim();
    assert.equal(probe, 'h264,320,240,yuv420p');
  });

  it('says what is wrong instead of hanging when ffmpeg is not installed', async () => {
    const rec = new Recorder({ file: path.join(tmpDir(), 'x.mp4'), ffmpeg: 'definitely-not-ffmpeg-xyz' });
    const outcome = await Promise.race([
      rec.stop().then(() => 'finished', (err) => err),
      new Promise((r) => setTimeout(() => r('HUNG'), 4000)),
    ]);
    assert.notEqual(outcome, 'HUNG', 'stop() must not hang');
    assert.ok(outcome instanceof FriendlyError);
    assert.match(outcome.message, /needs ffmpeg/);
    assert.match(outcome.hint, /Install ffmpeg/);
  });

  it('refuses to write a video with no frames', async (t) => {
    if (!hasFfmpeg()) return t.skip('ffmpeg is not installed');
    const rec = new Recorder({ file: path.join(tmpDir(), 'empty.mp4') });
    await assert.rejects(rec.stop(), FriendlyError);
  });
});
