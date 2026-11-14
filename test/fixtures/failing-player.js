// A stand-in audio player that fails like a real one that cannot open its device:
// `node failing-player.js <exit code>` says why on stderr, then exits with that code.
process.stderr.write("Could not open the audio device\n");
process.exit(Number(process.argv[2] ?? 1));
