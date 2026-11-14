/** Split a raw stdin chunk into key names. Unknown keys are ignored. */
export function parseKeys(chunk) {
  const keys = [];
  const s = String(chunk);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\x1b') {
      const seq = s.slice(i, i + 3);
      if (seq === '\x1b[A') keys.push('up');
      else if (seq === '\x1b[B') keys.push('down');
      else if (seq === '\x1b[C') keys.push('right');
      else if (seq === '\x1b[D') keys.push('left');
      else if (s.length === 1) keys.push('escape');
      i += seq.startsWith('\x1b[') ? 2 : 0;
    } else if (ch === '\x03' || ch === '\x04') keys.push('quit'); // Ctrl-C / Ctrl-D
    else if (ch === ' ') keys.push('space');
    else if (ch === '\r' || ch === '\n') keys.push('enter');
    else keys.push(ch.toLowerCase());
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
