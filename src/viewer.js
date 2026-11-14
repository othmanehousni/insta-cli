import { startKeys } from './keys.js';
import { fitCols, renderLines, Screen } from './terminal.js';
import { FriendlyError, sleep } from './util.js';

export const STYLES = ['classic', 'detailed', 'blocks', 'minimal', 'binary', 'braille'];
export const COLORS = ['source', 'palette', 'mono', 'none'];
export const PALETTES = ['devault', 'phosphor', 'amber', 'ice', 'sunset', 'cyber', 'mono'];

const next = (list, current) => list[(list.indexOf(current) + 1) % list.length];

/**
 * The live loop: grab a frame from the reels page, let the Devault engine turn it into characters,
 * draw them, repeat. Capturing frame N+1 overlaps with rendering frame N (they live in different tabs).
 */
export async function runViewer({ frames, reels, bridge, page, opts, baseDepth, log }) {
  const state = {
    style: opts.ramp ? 'custom' : opts.style,
    color: opts.color,
    palette: opts.palette,
    edges: opts.edges,
    invert: opts.invert,
    paused: false,
    reel: 1,
    fps: 0,
    note: '',
  };
  const screen = new Screen();
  const actions = [];
  let quit = false;
  let failures = 0;

  const depth = () => (state.color === 'none' ? 'none' : baseDepth);
  const apply = async (partial) => {
    await bridge.configure(partial);
  };

  async function handle(key) {
    switch (key) {
      case 'q':
      case 'quit':
      case 'escape':
        quit = true;
        break;
      case 'j':
      case 'n':
      case 'down':
      case 'right':
        state.note = 'loading next reel…';
        if (await reels.next()) state.reel += 1;
        state.note = '';
        break;
      case 'k':
      case 'up':
      case 'left':
        state.note = 'loading previous reel…';
        if (await reels.prev()) state.reel = Math.max(1, state.reel - 1);
        state.note = '';
        break;
      case 'space': {
        const paused = await reels.togglePause();
        if (paused !== null) state.paused = paused;
        break;
      }
      case 's':
        state.style = next(STYLES, state.style);
        await apply({ style: state.style });
        break;
      case 'c':
        state.color = next(COLORS, state.color);
        await apply({ colorMode: state.color === 'source' ? 'source' : state.color === 'palette' ? 'palette' : 'mono' });
        break;
      case 'p':
        state.color = 'palette';
        state.palette = next(PALETTES, state.palette);
        await apply({ colorMode: 'palette', palette: state.palette });
        break;
      case 'e':
        state.edges = !state.edges;
        await apply({ edges: state.edges });
        break;
      case 'i':
        state.invert = !state.invert;
        await apply({ invert: state.invert });
        break;
      default:
    }
  }

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
      const t0 = performance.now();
      while (actions.length && !quit) {
        try {
          await handle(actions.shift());
        } catch (err) {
          log.debug(`key action failed: ${String(err.message).split('\n')[0]}`);
          state.note = 'that did not work, try again';
        }
      }
      if (quit) break;

      const frame = await pending;
      if (failures > 40) throw new FriendlyError('The page stopped responding.', 'Re-run with --debug for details.');
      const { cols: termCols, rows: termRows } = screen.size();
      const cols = fitCols({ termCols, termRows, srcW: frame?.w ?? 9, srcH: frame?.h ?? 16, maxCols: opts.cols });
      frames.width = Math.min(480, Math.max(160, cols * 3));
      pending = grab();

      if (!frame) {
        screen.draw([], 0, ' waiting for a video…  (q to quit)');
        await sleep(100);
        continue;
      }

      const d = depth();
      const grid = await bridge.render(frame, { cols, color: d !== 'none' });
      if (!grid) continue;
      const hud = [
        ` reel ${state.reel}${state.paused ? ' ❚❚' : ''}`,
        `${state.fps.toFixed(0)} fps`,
        `${state.style}/${state.color}${state.edges ? '' : '/no-edges'}`,
        state.note || 'j/k reel · space pause · s c p e i look · q quit',
      ].join(' · ');
      screen.draw(renderLines(grid, d), grid.cols, hud);

      const elapsed = performance.now() - t0;
      if (elapsed < minInterval) await sleep(minInterval - elapsed);
      // Real frame rate: time between consecutive drawn frames (includes the throttle sleep).
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
  }
}
