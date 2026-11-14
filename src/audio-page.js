/*
 * Runs INSIDE the reels page (serialised by Playwright, so it must stay self-contained).
 *
 * Takes the sound of the video that is on screen and hands it to Node as 16-bit stereo PCM, through the
 * function `window.__iaAudio(sampleRate, base64)` that Node exposes.
 *
 * The tap uses video.captureStream() rather than createMediaElementSource() because
 *   - captureStream carries the sound even while the element is muted (Instagram starts reels muted, and
 *     muting is its own state that we have no business fighting), and
 *   - it does not permanently reroute the element's output.
 * The browser itself stays muted (--mute-audio), so nothing is played twice.
 */
export function installAudioTap(opts) {
  if (window.__ia_audio) return;
  const BUFFER = (opts && opts.buffer) || 8192; // ~186 ms at 44.1 kHz: the page's main thread is busy, so favour glitch-free over snappy
  const MAX_TRIES = 12; // per element, for videos whose audio track shows up late or never (silent reels)
  const A = (window.__ia_audio = { ctx: null, sp: null, el: null, src: null, wanted: !!(opts && opts.wanted), pending: 0, tries: new WeakMap(), lastTry: 0 });

  const ensure = () => {
    if (A.ctx) return true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      A.ctx = new Ctx({ latencyHint: 'playback' });
    } catch {
      return false;
    }
    A.sp = A.ctx.createScriptProcessor(BUFFER, 2, 2);
    A.sp.onaudioprocess = (e) => {
      // No source attached (a silent video, or between reels): the processor still ticks, but there is nothing to send.
      if (!A.wanted || !A.src || typeof window.__iaAudio !== 'function') return;
      if (A.pending > 6) return; // Node is not keeping up: drop sound rather than let it lag behind the picture
      const L = e.inputBuffer.getChannelData(0);
      const R = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : L;
      const pcm = new Int16Array(L.length * 2);
      for (let i = 0; i < L.length; i++) {
        const l = L[i] < -1 ? -1 : L[i] > 1 ? 1 : L[i];
        const r = R[i] < -1 ? -1 : R[i] > 1 ? 1 : R[i];
        pcm[i * 2] = l < 0 ? l * 32768 : l * 32767;
        pcm[i * 2 + 1] = r < 0 ? r * 32768 : r * 32767;
      }
      const bytes = new Uint8Array(pcm.buffer);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      A.pending += 1;
      Promise.resolve(window.__iaAudio(A.ctx.sampleRate, btoa(bin))).finally(() => {
        A.pending -= 1;
      });
    };
    A.sp.connect(A.ctx.destination); // must be connected to run; it writes silence, and the browser is muted anyway
    return true;
  };

  const detach = () => {
    try {
      A.src?.disconnect();
    } catch {
      /* already gone */
    }
    A.src = null;
  };

  /** Follow the video that is on screen: attach to its audio, switch when the reel changes. */
  A.sync = (video) => {
    if (!A.wanted || !video || video.tagName !== 'VIDEO' || !ensure()) return;
    if (A.ctx.state !== 'running') A.ctx.resume().catch(() => {});
    if (A.el === video && A.src) return;
    const now = performance.now();
    if (A.el === video && now - A.lastTry < 800) return;
    const tries = (A.tries.get(video) ?? 0) + 1;
    if (A.el !== video) detach();
    A.el = video;
    if (tries > MAX_TRIES) return;
    A.tries.set(video, tries);
    A.lastTry = now;
    let tracks = [];
    try {
      tracks = video.captureStream ? video.captureStream().getAudioTracks() : [];
    } catch {
      /* not capturable (for example protected content) */
    }
    if (!tracks.length) return;
    A.src = A.ctx.createMediaStreamSource(new MediaStream(tracks));
    A.src.connect(A.sp);
  };
}

/** Turn capturing on or off (off while muted, so nothing is converted or sent). */
export function setAudioWanted(wanted) {
  if (window.__ia_audio) window.__ia_audio.wanted = !!wanted;
  return !!window.__ia_audio;
}
