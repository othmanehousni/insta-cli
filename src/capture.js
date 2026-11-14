/*
 * Getting pixels out of the page that is showing the reels.
 *
 * Primary path (mode 'video'): inside the page, draw the <video> that is most on screen onto a small
 * canvas and read the raw RGBA back. No image encoding/decoding, and no UI chrome in the picture.
 * Fallbacks: if the canvas is tainted (cross-origin media), or for mode 'page', take a screenshot.
 */

/**
 * Runs INSIDE the reels page (serialised by Playwright, so it must stay self-contained).
 * Finds the main media (the <video> covering the most viewport area, else the biggest image or canvas)
 * and optionally grabs a frame from it.
 */
export function inspectMainVideo({ grabWidth }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Source size and readiness of a media element. Videos win; stills (img / canvas) are the fallback.
  const dims = (el) =>
    el.tagName === 'VIDEO'
      ? [el.videoWidth, el.videoHeight, el.readyState >= 2]
      : el.tagName === 'IMG'
        ? [el.naturalWidth, el.naturalHeight, el.complete]
        : [el.width, el.height, true];
  const pick = (selector) => {
    let found = null;
    let area = 0;
    for (const el of document.querySelectorAll(selector)) {
      const [mw, mh, ready] = dims(el);
      if (!ready || !mw || !mh) continue;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (w * h > area) {
        found = el;
        area = w * h;
      }
    }
    return found;
  };
  const best = pick('video') || pick('img, canvas');
  if (!best) return { ok: false, reason: 'no-video' };
  const [mediaW, mediaH] = dims(best);
  window.__insta_ascii_main = best; // lets pause/resume act on the same element

  window.__insta_ascii_ids = window.__insta_ascii_ids || { n: 0 };
  if (!best.__iaId) best.__iaId = ++window.__insta_ascii_ids.n;
  const r = best.getBoundingClientRect();
  const info = {
    ok: true,
    id: `${best.__iaId}|${best.currentSrc || best.src || ''}`,
    paused: best.tagName === 'VIDEO' ? best.paused : false,
    videoW: mediaW,
    videoH: mediaH,
    rect: {
      x: Math.max(0, r.left),
      y: Math.max(0, r.top),
      width: Math.max(1, Math.min(r.right, vw) - Math.max(r.left, 0)),
      height: Math.max(1, Math.min(r.bottom, vh) - Math.max(r.top, 0)),
    },
  };
  if (!grabWidth) return info;

  const w = Math.max(16, Math.min(grabWidth, mediaW));
  const h = Math.max(16, Math.round((w * mediaH) / mediaW));
  try {
    const canvas = (window.__insta_ascii_canvas = window.__insta_ascii_canvas || document.createElement('canvas'));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(best, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data; // throws SecurityError when tainted
    let bin = '';
    for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
    return { ...info, w, h, b64: btoa(bin) };
  } catch (err) {
    return { ...info, ok: false, reason: 'tainted', error: String(err && err.message) };
  }
}

export class FrameSource {
  /**
   * @param page   the Instagram (or test) page
   * @param mode   'video' (the playing reel) | 'page' (the whole viewport)
   * @param width  source width for the in-page grab; ~3x the terminal columns is plenty
   */
  constructor(page, { mode = 'video', width = 240, log } = {}) {
    this.page = page;
    this.mode = mode;
    this.width = width;
    this.log = log;
    this.useScreenshots = mode === 'page';
  }

  async #screenshot(clip) {
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 75, scale: 'css', ...(clip ? { clip } : {}) });
    const vp = this.page.viewportSize() ?? { width: 1280, height: 960 };
    return {
      kind: 'image',
      mime: 'image/jpeg',
      data: buf.toString('base64'),
      w: clip ? clip.width : vp.width, // css pixels == screenshot pixels (scale: 'css')
      h: clip ? clip.height : vp.height,
    };
  }

  /** The next frame to render, or null while no video is ready yet. */
  async frame() {
    if (this.mode === 'page') return this.#screenshot();

    const info = await this.page.evaluate(inspectMainVideo, { grabWidth: this.useScreenshots ? 0 : this.width });
    if (info.ok && info.b64) return { kind: 'rgba', w: info.w, h: info.h, data: info.b64 };
    if (info.reason === 'tainted' && !this.useScreenshots) {
      this.log?.debug(`canvas read-back blocked (${info.error}); using screenshots of the video area instead`);
      this.useScreenshots = true;
    }
    if (info.ok || info.reason === 'tainted') return this.#screenshot(info.rect);
    return null;
  }

  /** Which reel is showing and whether it is paused (cheap: no pixels). */
  async current() {
    const info = await this.page.evaluate(inspectMainVideo, { grabWidth: 0 });
    return info.ok ? info : null;
  }
}
