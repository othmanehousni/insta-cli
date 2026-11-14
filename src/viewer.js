import path from 'node:path';
import { Recorder, exportSize, saveStill, shotsDir, stamp } from './export.js';
import { startKeys } from './keys.js';
import { Panel } from './panel.js';
import { ensurePrivateDir } from './paths.js';
import { detectGraphics, encodingFor, imageFor, queryCellSize } from './protocols.js';
import { CONTROL_BY_KEY, LOOK_IDS, PIXEL_ONLY_STYLES, allLooks, lookPatch, stepValue } from './settings.js';
import { Screen, composeLines, fitBox, fitCols, halfBlockLines } from './terminal.js';
import { FriendlyError, sleep } from './util.js';

const PANEL_WIDTH = 40;
const MAX_IMAGE_PIXELS = 3_000_000;
const MAX_IMAGE_SIDE = 2400;
const RECORD_LONG_SIDE = 1280;
const COLOR_CYCLE = ['source', 'palette', 'mono', 'none'];
// Adaptive resolution: image / blocks rendering runs on the browser's WebGL, which is fast with a GPU and
// slow without one. The viewer measures how long a frame takes and trades resolution for smoothness.
const MIN_RES = 0.3;
const MIN_GLYPH_PX = 3; // narrowest glyph cell worth drawing in image mode

const nextIn = (list, current, dir = 1) => list[(list.indexOf(current) + dir + list.length) % list.length];

/**
 * The live loop: grab a frame from the page, let the Devault engine render it, draw it in the terminal, repeat.
 * Capturing frame N+1 overlaps with rendering frame N (they live in different tabs).
 *
 * Three ways to draw, all produced by the app's own engine:
 *   text    real characters (colour, tinted cells) - works in every terminal
 *   image   the app's actual canvas, every style and effect, via the Kitty / iTerm2 image protocols
 *   blocks  the app's canvas as half-block pixels - any truecolor terminal, lower fidelity
 */
export async function runViewer({ frames, reels, bridge, opts, settings: initialSettings, look: initialLook, baseDepth, audio = null, log }) {
  const info = bridge.info;
  const looks = allLooks(info);
  const lookLabel = (id) => looks.find((l) => l.id === id)?.label ?? id;

  // ---- how to draw
  const protocol = opts.graphics === 'auto' ? detectGraphics() : opts.graphics;
  const modes = ['text', 'blocks', ...(protocol ? ['image'] : [])];
  let mode = opts.render === 'auto' ? (protocol ? 'image' : 'text') : opts.render;
  if (mode === 'image' && !protocol) {
    throw new FriendlyError(
      'Image rendering needs a terminal that shows images, and none was detected.',
      'Use --graphics kitty (kitty, Ghostty) or --graphics iterm2 (iTerm2, WezTerm), or --render text / blocks.',
    );
  }
  let cell = { w: 9, h: 18 };
  if (protocol) cell = (await queryCellSize()) ?? cell;
  log.debug(`render ${mode}, graphics ${protocol ?? 'none'}, cell ${cell.w}x${cell.h}px`);

  // ---- state
  let settings = { ...initialSettings };
  let look = initialLook;
  let lookEdited = false;
  let plain = opts.color === 'none';
  const state = { paused: false, reel: 1, fps: 0, note: '', noteUntil: 0 };
  const panel = new Panel({ defaults: info.defaults, lookLabel });
  let panelOpen = false;
  let recording = null;
  let lastFrame = null;
  let lastLines = null;
  let frameNo = 0;
  let geometry = '';
  // ---- sound
  let volumePct = opts.volume ?? 100;
  let delayOffset = 0; // the person's own correction, in ms, on top of the measured lip-sync delay
  let measuredDelay = 0; // how far the picture lags the sound: the time from capturing a frame to drawing it
  let latencyEma = 0;
  let lastDelayUpdate = 0;
  const fixedDelay = typeof opts.audioDelay === 'number' ? opts.audioDelay : null;
  const soundState = () => ({ muted: audio.muted, volume: volumePct, offset: delayOffset, failed: audio.failed?.message ?? null });
  const applySound = () => {
    if (!audio) return;
    audio.setVolume(volumePct / 100);
    // The picture is drawn `measuredDelay` ms after its frame was captured, but the sound already reaches us
    // late by the tap's own batching, so only the difference needs adding. A fixed --audio-delay is taken as is.
    const base = fixedDelay ?? Math.max(0, measuredDelay - audio.out.tapLatencyMs());
    audio.setDelay(Math.min(3000, Math.max(0, base + delayOffset)));
  };
  audio?.out.on('problem', (err) => note(`sound: ${err.message}`, 12_000));
  applySound();

  let compare = 0; // the app's Compare: 0 = off, else the divider position (0..1) with the original to its left
  let res = 1; // adaptive resolution factor, MIN_RES..1
  let renderMs = 0; // smoothed time of the render step in image / blocks modes
  const t0 = performance.now();

  const screen = new Screen();
  const actions = [];
  let quit = false;
  let failures = 0;

  const note = (text, ms = 4000) => {
    state.note = text;
    state.noteUntil = performance.now() + ms;
  };
  const depth = () => (plain ? 'none' : baseDepth);
  const set = async (key, value) => {
    settings = { ...settings, [key]: value };
    lookEdited = true;
    await bridge.configure({ [key]: value });
  };
  const setLook = async (id) => {
    look = id;
    lookEdited = false;
    const patch = lookPatch(info, id);
    settings = { ...settings, ...patch };
    await bridge.configure(patch);
    note(`look: ${lookLabel(id)}`);
  };
  const setMode = (m) => {
    mode = m;
    screen.invalidate();
    note(`render: ${m}${m === 'image' ? ` (${protocol})` : ''}`);
  };

  async function toggleRecording() {
    if (recording) {
      const r = recording;
      recording = null;
      note('saving video…', 60_000);
      try {
        const done = await r.stop();
        note(`saved ${done.file} (${done.frames} frames)`, 8000);
      } catch (err) {
        note(`recording failed: ${err.message}`, 8000);
      }
      return;
    }
    const file = path.join(ensurePrivateDir(shotsDir()), `reel-${stamp()}.mp4`);
    recording = new Recorder({ file });
    recording.startedAt = performance.now();
    note(`recording to ${file}`);
  }

  async function toggleMute() {
    if (!audio) return note('there is no sound: no audio player was found (see --list audio)', 6000);
    await audio.setMuted(!audio.muted);
    note(audio.muted ? 'sound off' : 'sound on');
  }
  function changeVolume(delta) {
    if (!audio) return note('there is no sound: no audio player was found (see --list audio)', 6000);
    volumePct = Math.min(100, Math.max(0, volumePct + delta));
    applySound();
    note(`volume ${volumePct}%`);
  }
  function changeDelay(delta) {
    if (!audio) return;
    delayOffset = Math.min(3000, Math.max(-3000, delayOffset + delta));
    applySound();
    note(`sound delay ${delayOffset > 0 ? '+' : ''}${delayOffset} ms (picture ${delayOffset > 0 ? 'ahead of' : 'behind'} the sound by this much more)`, 6000);
  }

  async function handle(key) {
    if (key === 'quit') {
      quit = true;
      return;
    }
    if (panelOpen) {
      const a = panel.handleKey(key, settings, { look, mode, sound: audio ? soundState() : null });
      if (!a) return;
      if (a.type === 'close') {
        panelOpen = false;
        screen.invalidate();
      } else if (a.type === 'set') await set(a.key, a.value);
      else if (a.type === 'look') await setLook(nextIn(LOOK_IDS, look, a.dir));
      else if (a.type === 'mode') setMode(nextIn(modes, mode, a.dir));
      else if (a.type === 'sound') await toggleMute();
      else if (a.type === 'volume') changeVolume((a.big ? 10 : 5) * a.dir);
      else if (a.type === 'sync') changeDelay((a.big ? 250 : 50) * a.dir);
      return;
    }
    switch (key) {
      case 'q':
      case 'escape':
        quit = true;
        break;
      case 'j':
      case 'n':
      case 'down':
      case 'right':
        note('loading next reel…', 60_000);
        if (await reels.next()) state.reel += 1;
        state.note = '';
        break;
      case 'k':
      case 'up':
      case 'left':
        note('loading previous reel…', 60_000);
        if (await reels.prev()) state.reel = Math.max(1, state.reel - 1);
        state.note = '';
        break;
      case 'space': {
        const paused = await reels.togglePause();
        if (paused !== null) state.paused = paused;
        break;
      }
      case 'tab':
      case 'm':
        panelOpen = true;
        screen.invalidate();
        break;
      case 'l':
      case 'L':
        await setLook(nextIn(LOOK_IDS, look, key === 'l' ? 1 : -1));
        break;
      case 'v':
        setMode(nextIn(modes, mode));
        break;
      case 'a':
        await toggleMute();
        break;
      case '9':
        changeVolume(-10);
        break;
      case '0':
        changeVolume(10);
        break;
      case ',':
        changeDelay(-50);
        break;
      case '.':
        changeDelay(50);
        break;
      case 'o':
        compare = compare ? 0 : 0.5;
        screen.invalidate();
        note(compare ? 'compare: original | output   ( [ and ] move the divider )' : 'compare off');
        break;
      case '[':
      case ']':
        if (compare) {
          compare = Math.min(0.9, Math.max(0.1, compare + (key === ']' ? 0.1 : -0.1)));
          note(`compare: ${Math.round(compare * 100)}%`);
        }
        break;
      case 's':
        await set('style', nextIn(CONTROL_BY_KEY.style.choices.map((c) => c.value), settings.style));
        break;
      case 'c': {
        const next = nextIn(COLOR_CYCLE, plain ? 'none' : settings.colorMode);
        plain = next === 'none';
        if (!plain) await set('colorMode', next);
        note(`colour: ${next}`);
        break;
      }
      case 'p':
        plain = false;
        await set('colorMode', 'palette');
        await set('palette', nextIn(CONTROL_BY_KEY.palette.choices.map((c) => c.value), settings.palette));
        break;
      case 'e':
        await set('edges', !settings.edges);
        break;
      case 'i':
        await set('invert', !settings.invert);
        break;
      case '+':
      case '=':
        await set('cols', stepValue(CONTROL_BY_KEY.cols, settings.cols, 1, true));
        note(`detail: ${settings.cols} columns`);
        break;
      case '-':
        await set('cols', stepValue(CONTROL_BY_KEY.cols, settings.cols, -1, true));
        note(`detail: ${settings.cols} columns`);
        break;
      case 'x':
        if (!lastFrame) break;
        try {
          const files = await saveStill({ bridge, frame: lastFrame, settings, time: clock(), textLines: mode === 'text' ? lastLines : null });
          note(`saved ${files.png}`, 8000);
        } catch (err) {
          note(`could not save: ${err.message}`, 8000);
        }
        break;
      case 'r':
        await toggleRecording();
        break;
      default:
    }
  }

  const clock = () => (settings.animate ? (performance.now() - t0) / 1000 : 0);

  /** Called with how long the last image / blocks render took: lower the resolution if it cannot keep up. */
  const adapt = (ms) => {
    renderMs = renderMs ? renderMs * 0.7 + ms * 0.3 : ms;
    const budget = 1000 / opts.fps;
    if (renderMs > budget * 1.5 && res > MIN_RES) res = Math.max(MIN_RES, res * 0.85);
    else if (renderMs < budget * 0.6 && res < 1) res = Math.min(1, res * 1.08);
  };

  const grab = async () => {
    try {
      const frame = await frames.frame();
      failures = 0;
      return frame;
    } catch (err) {
      failures += 1;
      log.debug(`frame grab failed (${failures}): ${String(err.message).split('\n')[0]}`);
      return null;
    }
  };

  const stopKeys = startKeys((k) => actions.push(k));
  const onResize = () => screen.invalidate();
  const onSignal = () => {
    quit = true;
  };
  process.stdout.on('resize', onResize);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  screen.enter();

  const minInterval = 1000 / opts.fps;
  let pending = grab();
  let lastDraw = 0;
  try {
    while (!quit) {
      const frameStart = performance.now();
      while (actions.length && !quit) {
        try {
          await handle(actions.shift());
        } catch (err) {
          log.debug(`key action failed: ${String(err.message).split('\n')[0]}`);
          note('that did not work, try again');
        }
      }
      if (quit) break;

      const frame = await pending;
      if (failures > 40) throw new FriendlyError('The page stopped responding.', 'Re-run with --debug for details.');
      const term = screen.size();
      const panelW = panelOpen ? Math.min(PANEL_WIDTH, term.cols) : 0;
      const region = { w: Math.max(8, term.cols - (panelOpen && term.cols >= 70 ? panelW + 1 : panelOpen ? term.cols : 0)), h: term.rows - 1 };
      const hideBehindPanel = panelOpen && term.cols < 70;
      frames.width = Math.min(480, Math.max(160, (settings.cols ?? 130) * 2));
      pending = grab();

      if (!frame) {
        screen.put(0, 0, ' waiting for a video…  (q to quit)');
        screen.flush();
        geometry = ''; // the next real frame must clear this message
        await sleep(100);
        continue;
      }
      lastFrame = frame;
      frameNo += 1;

      // pixel-only styles (film, particle) cannot be written as characters
      const pixelOnly = PIXEL_ONLY_STYLES.includes(settings.style);
      const effective = mode === 'text' && pixelOnly ? (protocol ? 'image' : 'blocks') : mode;
      const time = clock();
      const d = depth();

      let geometryNow = `${term.cols}x${term.rows}|${effective}|${panelOpen}`;
      let drew = null;
      if (!hideBehindPanel) {
        if (effective === 'text') {
          const maxCols = Math.min(settings.cols, opts.cols ?? Infinity);
          const cols = fitCols({ termCols: region.w, termRows: region.h, srcW: frame.w, srcH: frame.h, maxCols, reserveRows: 0 });
          const grid = await bridge.render(frame, { cols, time, color: d !== 'none' });
          if (grid) {
            let lines;
            if (compare && d !== 'none' && grid.cols >= 6) {
              // Compare in text: the original as half-block pixels on the left, the letters on the right
              const leftCols = Math.max(1, Math.min(grid.cols - 3, Math.round(grid.cols * compare)));
              const orig = await bridge.scaleFrame(frame, { w: leftCols, h: grid.lines.length * 2, crop: leftCols / grid.cols });
              const left = halfBlockLines(orig, leftCols, grid.lines.length * 2, d);
              const right = composeLines(grid, settings, { depth: d, time, frameNo, fromCol: leftCols + 1 });
              lines = left.map((l, i) => `${l}\x1b[0;97m│\x1b[0m${right[i]}`);
            } else lines = composeLines(grid, settings, { depth: d, time, frameNo });
            lastLines = composeLines(grid, settings, { depth: 'none' });
            const left = Math.max(0, Math.floor((region.w - grid.cols) / 2));
            const top = Math.max(0, Math.floor((region.h - lines.length) / 2));
            geometryNow += `|${left}|${top}|${lines.length}|${grid.cols}`;
            drew = { lines, left, top, width: grid.cols };
          }
        } else if (effective === 'image') {
          const want = fitBox({ availCols: region.w, availRows: region.h, srcW: frame.w, srcH: frame.h, cellW: cell.w, cellH: cell.h });
          let k = opts.scale * res;
          const area = want.pxW * want.pxH * k * k;
          if (area > MAX_IMAGE_PIXELS) k *= Math.sqrt(MAX_IMAGE_PIXELS / area);
          k = Math.min(k, MAX_IMAGE_SIDE / Math.max(want.pxW, want.pxH));
          const rt = performance.now();
          const w = Math.round(want.pxW * k);
          const img = await bridge.renderImage(frame, {
            // The engine never draws a glyph smaller than 2x4 px, so fewer pixels must mean fewer glyphs too.
            cols: Math.max(20, Math.min(settings.cols, Math.floor(w / MIN_GLYPH_PX))),
            w,
            h: Math.round(want.pxH * k),
            time,
            encode: encodingFor(protocol),
            quality: 0.88,
            compare,
          });
          adapt(performance.now() - rt);
          if (img) {
            const box = fitBox({ availCols: region.w, availRows: region.h, srcW: img.w, srcH: img.h, cellW: cell.w, cellH: cell.h });
            const left = Math.max(0, Math.floor((region.w - box.cols) / 2));
            const top = Math.max(0, Math.floor((region.h - box.rows) / 2));
            geometryNow += `|${left}|${top}|${box.cols}x${box.rows}`;
            drew = { raw: imageFor(protocol, img, { cols: box.cols, rows: box.rows }), left, top };
          }
        } else {
          const box = fitBox({ availCols: region.w, availRows: region.h * 2, srcW: frame.w, srcH: frame.h, cellW: 1, cellH: 1 });
          const pxW = box.cols;
          const pxH = box.rows - (box.rows % 2);
          const rt = performance.now();
          const k = 3 * res;
          const img = await bridge.renderImage(frame, {
            cols: Math.max(20, Math.min(settings.cols, pxW)), // finer than the output can show is wasted work
            w: Math.min(MAX_IMAGE_SIDE, Math.round(pxW * k)),
            h: Math.min(MAX_IMAGE_SIDE, Math.round(pxH * k)),
            time,
            encode: 'raw',
            rawW: pxW,
            rawH: pxH,
            compare,
          });
          adapt(performance.now() - rt);
          if (img) {
            const lines = halfBlockLines(img.data, pxW, pxH, d);
            const left = Math.max(0, Math.floor((region.w - pxW) / 2));
            const top = Math.max(0, Math.floor((region.h - lines.length) / 2));
            geometryNow += `|${left}|${top}|${lines.length}|${pxW}`;
            drew = { lines, left, top, width: pxW };
          }
        }
      }

      if (geometryNow !== geometry) {
        geometry = geometryNow;
        screen.invalidate();
      }
      if (drew?.lines) drew.lines.forEach((line, i) => screen.put(drew.top + i, drew.left, line));
      if (drew?.raw) screen.putRaw(drew.top, drew.left, drew.raw, { image: true });

      if (panelOpen) {
        const x = hideBehindPanel ? 0 : term.cols - panelW;
        const lines = panel.render(panelW, term.rows - 1, settings, {
          look,
          mode,
          sound: audio ? soundState() : null,
          lookHint: looks.find((l) => l.id === look)?.hint,
          modeNote: mode === 'text' ? 'text mode: letters in any terminal' : mode === 'image' ? `app canvas via ${protocol}` : 'app canvas as half-block pixels',
        });
        lines.forEach((line, i) => screen.put(i, x, line));
      }

      // recording: the app's canvas at a fixed export size, straight into ffmpeg
      if (recording) {
        const { w, h } = exportSize(frame.w, frame.h, RECORD_LONG_SIDE);
        const img = await bridge.renderImage(frame, { cols: settings.cols, w, h, time, encode: 'jpeg', quality: 0.9 });
        if (img) {
          try {
            await recording.push(img.data);
          } catch (err) {
            note(`recording failed: ${err.message}`, 8000);
            recording = null;
          }
        }
      }

      const sec = recording ? Math.floor((performance.now() - recording.startedAt) / 1000) : 0;
      const shown = effective !== mode ? `${mode}→${effective}` : mode;
      if (state.note && performance.now() > state.noteUntil) state.note = '';
      const hud = [
        ` reel ${state.reel}${state.paused ? ' ❚❚' : ''}${recording ? ` ● REC ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : ''}`,
        `${state.fps.toFixed(0)} fps${audio ? ` · ${audio.failed ? '♪ ✗' : audio.muted ? '♪ muted' : `♪ ${volumePct}%`}` : ''}`,
        `${look}${lookEdited ? '*' : ''}${compare ? ` · compare ${Math.round(compare * 100)}%` : ''} · ${shown}${effective === 'image' ? `(${protocol})` : ''}${effective !== 'text' && res < 0.98 ? ` ${Math.round(res * 100)}%` : ''}`,
        state.note || 'j/k reel · space pause · Tab settings · a mute · l look · v render · x save · r rec · q quit',
      ].join(' · ');
      screen.put(term.rows - 1, 0, `${'\x1b[7m'}${hud.length > term.cols ? hud.slice(0, term.cols) : hud.padEnd(term.cols)}`);
      screen.flush();

      // Lip-sync: the sound is captured live, the picture is drawn a moment after it was captured. Hold the sound
      // back by that lag (smoothed; only re-aimed when it has drifted noticeably, so it does not stutter).
      if (audio && frame.capturedAt) {
        const lag = performance.now() - frame.capturedAt;
        latencyEma = latencyEma ? latencyEma * 0.85 + lag * 0.15 : lag;
        if (performance.now() - lastDelayUpdate > 1500 && Math.abs(latencyEma - measuredDelay) > 100) {
          measuredDelay = Math.min(1500, latencyEma);
          lastDelayUpdate = performance.now();
          applySound();
          log.debug(`lip-sync: the picture is drawn ${Math.round(measuredDelay)} ms after capture; sound delayed ${Math.round(audio.out.delayMs)} ms`);
        }
      }

      const elapsed = performance.now() - frameStart;
      if (elapsed < minInterval) await sleep(minInterval - elapsed);
      const now = performance.now();
      if (lastDraw) {
        const inst = 1000 / Math.max(1, now - lastDraw);
        state.fps = state.fps ? state.fps * 0.8 + inst * 0.2 : inst;
      }
      lastDraw = now;
    }
  } finally {
    pending.catch(() => {});
    stopKeys();
    process.stdout.off('resize', onResize);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    screen.leave();
    if (recording) {
      try {
        const done = await recording.stop();
        process.stderr.write(`saved ${done.file}\n`);
      } catch (err) {
        process.stderr.write(`recording failed: ${err.message}\n`);
      }
    }
  }
}
