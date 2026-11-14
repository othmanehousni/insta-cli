const CSI_FINAL = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'S-tab' };
const CSI_TILDE = { 1: 'home', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };

/**
 * Split a raw stdin chunk into key names: 'up' 'down' 'left' 'right' (with an 'S-' / 'C-' prefix when
 * shifted / ctrl'd) 'home' 'end' 'pageup' 'pagedown' 'delete' 'tab' 'S-tab' 'enter' 'escape' 'space'
 * 'backspace' 'quit' (Ctrl-C / Ctrl-D), or the character itself (case preserved). Unknown sequences are dropped.
 */
export function parseKeys(chunk) {
  const keys = [];
  const s = String(chunk);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\x1b') {
      const m = /^\x1b\[(\d+(?:;\d+)*)?([A-Za-z~])/.exec(s.slice(i));
      if (m) {
        const params = (m[1] ?? '').split(';').filter(Boolean).map(Number);
        const mod = params.length > 1 ? params[params.length - 1] : 1; // 2 = shift, 5 = ctrl
        const base = m[2] === '~' ? CSI_TILDE[params[0]] : CSI_FINAL[m[2]];
        if (base) keys.push(`${mod === 2 && !base.startsWith('S-') ? 'S-' : mod === 5 ? 'C-' : ''}${base}`);
        i += m[0].length - 1;
      } else if (i === s.length - 1) {
        keys.push('escape');
      } else if (s[i + 1] === 'O' && /[A-D]/.test(s[i + 2] ?? '')) {
        keys.push(CSI_FINAL[s[i + 2]]); // application-cursor-mode arrows
        i += 2;
      }
    } else if (ch === '\x03' || ch === '\x04') keys.push('quit'); // Ctrl-C / Ctrl-D
    else if (ch === ' ') keys.push('space');
    else if (ch === '\r' || ch === '\n') keys.push('enter');
    else if (ch === '\t') keys.push('tab');
    else if (ch === '\x7f' || ch === '\b') keys.push('backspace');
    else if (ch >= ' ') keys.push(ch);
  }
  return keys;
}

/** Put the terminal in raw mode and call onKey(name) for every key. Returns a stop() function. */
export function startKeys(onKey, stdin = process.stdin) {
  stdin.setRawMode(true);
  stdin.resume();
  const handler = (chunk) => parseKeys(chunk.toString('utf8')).forEach(onKey);
  stdin.on('data', handler);
  return () => {
    stdin.off('data', handler);
    try {
      stdin.setRawMode(false);
    } catch {
      /* stdin already closed */
    }
    stdin.pause();
  };
}

/** Read one line from the terminal without echoing it (for passwords and codes). */
export function promptHidden(question, { stdin = process.stdin, stderr = process.stderr } = {}) {
  return promptLine(question, { stdin, stderr, echo: false });
}

export function promptLine(question, { stdin = process.stdin, stderr = process.stderr, echo = true } = {}) {
  return new Promise((resolve, reject) => {
    stderr.write(question);
    let value = '';
    const raw = stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    const done = (fn, arg) => {
      stdin.off('data', onData);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      fn(arg);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(resolve, value);
        if (ch === '\x03') return done(reject, new Error('Cancelled.'));
        if (ch === '\x7f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            if (echo && raw) stderr.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          if (echo && raw) stderr.write(ch);
        }
      }
    };
    stdin.on('data', onData);
  });
}
