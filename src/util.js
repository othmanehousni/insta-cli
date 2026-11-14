export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A problem with how the CLI was invoked (exit code 2, shows usage). */
export class UsageError extends Error {}

/** A problem the user can act on (exit code 1, no stack trace). */
export class FriendlyError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

/**
 * Tiny stderr logger. Status messages go to stderr so stdout stays clean for
 * `--once` (which prints the frame there).
 */
export function makeLogger({ debug = false, quiet = false } = {}) {
  const write = (msg) => process.stderr.write(`${msg}\n`);
  return {
    info: (msg) => !quiet && write(msg),
    warn: (msg) => write(`warning: ${msg}`),
    debug: (msg) => debug && write(`[debug] ${msg}`),
  };
}
