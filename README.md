# insta-ascii

Your Instagram **Reels feed, in the terminal**. The CLI signs in to your account, opens the Reels
page, and turns the playing video into ASCII, using the
[Devault ASCII generator](https://devault-ascii.pages.dev/ascii-generator/app/) as the renderer.

One frame from the project's *test* feed (not Instagram content), printed with `--once --color none --cols 34`:

```
::::::::::::::::::::::::::::::::::
::::::::::::::::----:::::::::::---
::::::::::::://------\\::::-------
:::::::::::///@@@@@@@@\\----------
:::::::::::|/@@@@@@@@@@\|---------
:::::::::::|@@@@@@@@@@@@|---------
:::::::::::|\@@@@@@@@@@/|---------
::::::::::--\\\@@@@@@///----------
::::::--------\\----//------------
::--------------------------------
----------------------------------
```

In the terminal it is live, coloured by default, and keyboard-driven.

## How it works

```
 Chrome, signed in to Instagram ──► frame of the reel on screen
        (your saved session)                │
                                            ▼
                      Devault ASCII generator (loaded from its hosted URL, run in a hidden tab)
                                            │  glyph + colour for every cell
                                            ▼
                                    your terminal (ANSI colour)
```

- A real browser (Playwright, using your installed Chrome when there is one) logs in and plays the
  reel, because reels live in Instagram's logged-in web app.
- Each frame is read straight off the playing `<video>` (raw pixels, no image encoding). If the page
  doesn't allow that, it falls back to screenshots of the video area; `--capture page` renders the
  whole page instead.
- The frame is handed to the **Devault ASCII generator**: the hosted app is loaded and its own engine
  does the image-to-characters conversion, with the app's own settings (style, palette, colour mode,
  outlines, invert). The app only paints a canvas and has no text export, so the CLI reads the glyph
  grid from the engine it loads, with the same glyph-to-character mapping the app uses.

## Requirements

- Node.js 18.17 or newer
- Google Chrome, **or** run `npx playwright install chromium` once
- Internet access (Instagram, and `devault-ascii.pages.dev` for the renderer)
- A terminal with 24-bit colour for the best result (256-colour and plain output also work)

## Install

```bash
git clone https://github.com/othmanehousni/insta-cli.git
cd insta-cli
npm install
npm link        # optional: puts `insta-ascii` on your PATH (otherwise use `node bin/insta-ascii.js`)
```

## Sign in

```bash
insta-ascii login
```

You are asked for your username and password (the password is typed hidden and is never a flag, so it
doesn't land in your shell history). For scripts, set `INSTAGRAM_USERNAME` and `INSTAGRAM_PASSWORD`
instead. If Instagram asks for a two-factor code you will be prompted for it.

```bash
insta-ascii login --manual
```

Opens a **visible browser window** and waits while you sign in yourself. Use this if Instagram
challenges the automated login (security checks, captchas, "was this you?"). It is the most reliable
way in. The session is saved to a private browser profile and reused by every later run.

`insta-ascii logout` deletes that profile. `insta-ascii` on its own will also sign in for you if there
is no valid session yet.

## Watch

```bash
insta-ascii
```

| Key | Action |
| --- | --- |
| `j` / `↓` | next reel |
| `k` / `↑` | previous reel |
| `space` | pause / resume |
| `s` | cycle style: classic, detailed, blocks, minimal, binary, braille |
| `c` | cycle colour: source, palette, mono, none |
| `p` | cycle the app's palettes (devault, phosphor, amber, ice, sunset, cyber, mono) |
| `e` | toggle the app's outline glyphs (off is faster) |
| `i` | invert brightness (for light terminal backgrounds) |
| `q` | quit |

The picture is as large as fits your terminal (a reel is portrait, so height is usually the limit) and
re-fits when you resize the window.

### Options

| Option | Meaning | Default |
| --- | --- | --- |
| `-s, --style <name>` | `classic` `detailed` `blocks` `minimal` `binary` `braille` | `classic` |
| `--ramp <chars>` | your own character ramp, light to dense, e.g. `" .:-=+*#%@"` | |
| `-c, --color <mode>` | `source` (the video's colours), `palette`, `mono`, `none` | `source` |
| `--palette <name>` | the app's palette, used with `--color palette` | `devault` |
| `--no-edges` | turn off the app's outline glyphs | outlines on |
| `--invert` | invert brightness | off |
| `-w, --cols <n>` | maximum columns | fit the terminal |
| `--depth <mode>` | `auto` `truecolor` `256` `none` (`NO_COLOR` is respected) | `auto` |
| `--fps <n>` | frame-rate cap | `15` |
| `--capture <what>` | `video` (the reel) or `page` (the whole viewport) | `video` |
| `--once` | print one frame to stdout and exit (no terminal needed) | |
| `--url <url>` | open another page instead of `instagram.com/reels/` | |
| `-u, --username <name>` | Instagram username | `INSTAGRAM_USERNAME` or prompt |
| `--browser <name>` | `auto` `chrome` `chromium` | `auto` |
| `--headed` | show the browser window | headless |
| `--software-gl` | allow software WebGL (headless machines without a GPU) | off |
| `--app-url <url>` | the ASCII generator app | the Devault URL |
| `--debug` | verbose logging; saves a screenshot on failure | off |

Run `insta-ascii --help` for the same list. Only the styles that are made of characters can be drawn
in a terminal; the app's picture-only looks (dots, bricks, particles, film, tiles) are not offered.

## Privacy and security

- **Your session** lives in a browser profile at `~/.insta-ascii/profile` (override with
  `INSTA_ASCII_HOME`), created readable by you only. Treat it like a password. `insta-ascii logout`
  removes it, and refuses to delete a directory it didn't create.
- **The renderer tab is locked down.** The hosted app is allowed to make `GET` requests to its own
  files and nothing else. This matters because the app's own Content-Security-Policy *permits*
  connections to its auth and stats services and to Google sign-in. Frames from your feed can't be
  sent to any of those, or anywhere. The app's UI script is not run at all; only its engine is.
- `--debug` saves screenshots under `~/.insta-ascii/debug`; they can show account details, so delete
  them when you are done.
- This tool has no telemetry of its own. (The browser talks to Instagram, of course, and loads the
  renderer's files from the Devault site.)

## Limitations, honestly

- **Instagram's terms** don't allow automated access, and automated sign-ins from a headless browser
  are more likely to be challenged than your normal browser. Use it with your own account, at your own
  risk, and prefer `login --manual`.
- **This was developed without an Instagram account to test against.** What was verified: the live
  Devault engine, the full CLI and interactive viewer in a real pseudo-terminal, reel navigation, pause,
  the screenshot fallback for cross-origin video, and the login flow (password, wrong password,
  two-factor, security challenge, manual) against a local stand-in whose form fields match the real login
  page (`email` / `pass`, checked against the live page). **Not verified:** Instagram's real post-login
  pages, 2FA form, and reels markup. Those can change at any time. If something doesn't work, run with
  `--debug --headed` to see what the page is showing.
- The reels page is driven like a person would: arrow keys, with the mouse wheel as a fallback.
- **No audio**: it's a picture in a terminal.
- If the Devault app is redesigned, the engine may not be found; the CLI says so instead of guessing.
- Frame rate depends on your machine and the outline setting (`e` / `--no-edges` is faster); `--fps`
  caps it.

## Development

```bash
npm test
```

Covers: terminal rendering and key parsing (pure unit tests); the allow/block decision for the renderer
tab; the bridge to the **live** Devault app (grid shape, colours, braille/blocks/custom ramps, outlines,
lockdown, skipped if the app can't be reached); the CLI end to end against a local reels feed
(`--once`, colour depths, `--capture page`, argument errors); feed navigation and pause; the
cross-origin-video fallback (needs `ffmpeg`, skipped without); the login state machine against a mock
login server; and profile storage and `logout` safety.

```
bin/insta-ascii.js   entry point
src/cli.js           flags, commands, login orchestration, --once
src/viewer.js        the live loop and keys
src/instagram.js     login, session check, feed navigation
src/capture.js       getting frames out of the page
src/ascii.js         the bridge to the Devault app (+ network lockdown)
src/engine-page.js   code that runs inside the app's page
src/terminal.js      colour, fitting, full-screen drawing
test/                unit, integration and end-to-end tests, plus a mock feed and mock login
```
