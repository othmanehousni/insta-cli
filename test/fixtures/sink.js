// A stand-in audio player for tests: `node sink.js <rate> <outfile>` writes everything it receives on stdin
// (raw 16-bit stereo PCM) to <outfile>, and the rate it was started with to <outfile>.rate.
import fs from 'node:fs';

const [rate, out] = process.argv.slice(2);
fs.writeFileSync(`${out}.rate`, String(rate));
const file = fs.createWriteStream(out, { flags: 'a' });
process.stdin.pipe(file);
process.stdin.on('end', () => file.end());
