/*
 * Terminal graphics: showing the app's own canvas as a real image in the terminal.
 *
 *   kitty   Kitty graphics protocol  (kitty, Ghostty; PNG, sent in 4 KB base64 chunks)
 *   iterm2  iTerm2 inline images      (iTerm2, WezTerm, mintty; any image format, one OSC sequence)
 *
 * Both place the image at the cursor and scale it into a box of cols x rows cells.
 */

/**
 * Which protocol this terminal speaks, judged from its environment; null when none is known.
 * Terminal multiplexers swallow these sequences unless passthrough is configured, so they count as "none".
 * VS Code's terminal understands the iTerm2 protocol only when "terminal.integrated.enableImages" is on, and
 * a silent blank picture is a worse failure than text, so it must be asked for with --graphics iterm2.
 */
export function detectGraphics(env = process.env) {
  if (env.TMUX || env.STY) return null;
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'kitty';
  if (env.TERM_PROGRAM === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'kitty';
  if (env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') return 'iterm2';
  if (env.TERM_PROGRAM === 'WezTerm' || env.WEZTERM_EXECUTABLE) return 'iterm2';
  if (env.TERM_PROGRAM === 'mintty') return 'iterm2';
  return null;
}

const KITTY_CHUNK = 4096;

/** Kitty graphics: transmit and display a PNG in a box of cols x rows cells; the cursor does not move. */
export function kittyImage(png, { cols, rows, id = 1 }) {
  const b64 = png.toString('base64');
  let out = '';
  for (let i = 0; i < b64.length; i += KITTY_CHUNK) {
    const more = i + KITTY_CHUNK < b64.length ? 1 : 0;
    // q=2: no replies (they would arrive on stdin as keystrokes). Re-using the id replaces the previous frame.
    const control = i === 0 ? `a=T,f=100,t=d,q=2,i=${id},c=${cols},r=${rows},C=1,m=${more}` : `m=${more}`;
    out += `\x1b_G${control};${b64.slice(i, i + KITTY_CHUNK)}\x1b\\`;
  }
  return out;
}

/** Remove every image this program placed (Kitty). */
export const kittyClear = () => '\x1b_Ga=d,d=A,q=2\x1b\\';

/** iTerm2 inline image in a box of cols x rows cells. */
export function itermImage(data, { cols, rows }) {
  return `\x1b]1337;File=inline=1;size=${data.length};width=${cols};height=${rows};preserveAspectRatio=0:${data.toString('base64')}\x07`;
}

/** The encoded image the terminal wants, and the bytes that show it. */
export function imageFor(protocol, image, box) {
  return protocol === 'kitty' ? kittyImage(image.data, box) : itermImage(image.data, box);
}

/** What to ask the engine for: Kitty needs PNG; iTerm2 takes JPEG, which is much faster to produce. */
export const encodingFor = (protocol) => (protocol === 'kitty' ? 'png' : 'jpeg');

/**
 * Ask the terminal how big one cell is in pixels (CSI 16 t -> CSI 6 ; h ; w t).
 * Resolves null if there is no answer in time (the caller then assumes a typical 9x18 cell).
 */
export function queryCellSize({ stdin = process.stdin, stdout = process.stdout, timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    if (!stdin.isTTY || !stdout.isTTY) return resolve(null);
    let buf = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (value) => {
      clearTimeout(timer);
      stdin.off('data', onData);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
      resolve(value);
    };
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const m = /\x1b\[6;(\d+);(\d+)t/.exec(buf);
      if (m) finish({ w: Number(m[2]), h: Number(m[1]) });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stdin.on('data', onData);
    stdout.write('\x1b[16t');
  });
}
