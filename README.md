# mPlay3r

Lightweight, Winamp-inspired audio player built with **StencilJS**, **[dot-stash](https://github.com/jezoock/dot-stash)**, **Web Audio API**, and **Tauri v2**.

One tiny codebase produces:
- **Standalone Web App / PWA** (`www/`)
- **Embeddable Web Component** (`<mplay3r-app>`, usable in any HTML, React, Vue, or Angular app)
- **Portable Desktop Binary** (single executable + `portable.flag` / `./data/`)
- **Installable Desktop App** (NSIS/MSI on Windows, AppImage/Deb on Linux, DMG on macOS)

---

## Phase 1 Features (Base Player — Zero Plugins, Zero Scraping)

- **Winamp-grade playback controls**: Play, Pause, Stop, Previous (>3s restarts track), Next, Seek scrubber with buffer track, clickable Elapsed / Remaining time display, Volume, Mute, Stereo Balance (`L`–`C`–`R`), Shuffle, Repeat (`Off` → `All` → `One`), and Compact / Windowshade mode.
- **10-band Winamp Equalizer**: Native Web Audio API DSP graph (`60Hz`, `170Hz`, `310Hz`, `600Hz`, `1K`, `3K`, `6K`, `12K`, `14K`, `16K`), Preamp (`-12 dB` to `+12 dB`), live frequency response curve, On/Off bypass switch, Reset, and 14 classic Winamp presets (`Flat`, `Rock`, `Pop`, `Classical`, `Jazz`, `Electronic`, `Club`, `Full Bass`, `Full Treble`, `Full Bass & Treble`, `Vocal`, `Acoustic`, `Headphones`, `Soft`).
- **Playlist manager**: Open files, open folders, Drag & Drop anywhere on the player, instant search/filter, accessible keyboard & button reordering (`ds-sortable`), Import `.m3u` / `.m3u8` / `.pls`, Export `.m3u8`, and offline local filename + ID3v1/ID3v2 tag reading (zero network calls).
- **Minimalist theme with 5 live color schemes**: `obsidian`, `slate`, `amber`, `emerald`, and `sand`, powered by `dot-stash` scoped SCSS design tokens.
- **Built for theming with `ds-trigger`**: Every player control uses `<ds-trigger target="#mplay3r" action="...">` invoking public `@Method()`s on `<mplay3r-app>` — including a `headless` mode for Phase 2 radical themes.
- **Keyboard shortcuts**: `Space` Play/Pause, `Z` Prev, `X` Play, `C` Pause, `V` Stop, `B` Next, `S` Shuffle, `R` Repeat, `M` Mute, `←`/`→` Seek ±5s, `↑`/`↓` Volume ±5%.

---

## Project Roadmap

- **Phase 1 (current)**: Base player without plugins or scraping — transport, playlist, 10-band EQ, minimalist theme with 5 color palettes, Web + Embeddable Web Component + Tauri v2 Desktop (portable & installable).
- **Phase 2 (next)**: Integrated plugin & theme store, downloadable visualizer plugins (Canvas/WebGL/GLSL), metadata scraping plugins, DSP AudioWorklet plugins, radical full-layout themes, and Winamp `.wsz` skin loader plugin. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Quick Start

### Requirements
- Node.js `>= 22`
- For Desktop builds: Rust toolchain (`rustup`) and Tauri v2 OS prerequisites

### Web / Dev Server

```bash
npm install
npm start
```

Open `http://localhost:3333/` for the standalone app or `http://localhost:3333/embed-demo.html` for the multi-instance embed & external `ds-trigger` demo.

### Production Build & Tests

```bash
npm run build       # Compiles SCSS theme + Stencil www/, dist/, dist/components/, loader/
npm test            # Runs zero-dependency core unit tests on Node 22
npm run typecheck   # TypeScript type checking
npm run lint        # ESLint
npm run lint:css    # Stylelint
```

### Desktop (Tauri v2)

```bash
npm run desktop:dev     # Live desktop development
npm run desktop:build   # Builds portable binary + OS installers
```

**Portable mode**: place an empty `portable.flag` file (or a `data/` folder) next to the compiled `mPlay3r` binary (or set `MPLAY3R_PORTABLE=1`). All settings and playlists stay inside `./data/state.json`.

---

## Embedding `<mplay3r-app>` in Any Web App

Load the scoped minimalist stylesheet (`minimal.css` never touches host `body` or heading styles) and the Stencil ESM module:

```html
<link rel="stylesheet" href="/dist/css/minimal.css" />
<script type="module" src="/dist/mplay3r/mplay3r.esm.js"></script>

<mplay3r-app
  id="my-player"
  palette="sand"
  persist="false"
  tracks='[{"src":"/audio/demo.mp3","title":"Demo Track","artist":"Artist"}]'
></mplay3r-app>

<!-- Control the player declaratively from anywhere in your page with dot-stash ds-trigger -->
<ds-trigger type="button" mods="sm,stl-1" target="#my-player" action="togglePlay">Play / Pause</ds-trigger>
<ds-trigger type="button" mods="sm,stl-2" target="#my-player" action="toggleEqualizer">Equalizer</ds-trigger>
<ds-trigger type="button" mods="sm,stl-3" target="#my-player" action='setPalette:["amber"]'>Amber</ds-trigger>
```

For completely custom UIs (and Phase 2 full-layout themes), add `headless`:

```html
<mplay3r-app id="custom-player" headless>
  <ds-trigger type="button" target="#custom-player" action="previous">Prev</ds-trigger>
  <ds-trigger type="button" target="#custom-player" action="togglePlay">Play</ds-trigger>
  <ds-trigger type="button" target="#custom-player" action="next">Next</ds-trigger>
</mplay3r-app>
```

---

## License

MIT — see [LICENSE](LICENSE). Icons via `dot-stash` (Lucide, ISC License).
