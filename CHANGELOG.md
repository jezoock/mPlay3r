# Changelog

All notable changes to **mPlay3r** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-27

### Added — Phase 1 (Lightweight Core Player)
- **StencilJS + `dot-stash` UI (`<mplay3r-app>`)**: Light-DOM Web Components (`<mp-header>`, `<mp-transport>`, `<mp-equalizer>`, `<mp-playlist>`) with 38 public `@Method()`s driven declaratively via `<ds-trigger>`, `headless` mode, compact/windowshade mode, MediaSession API, Drag & Drop, and Winamp keyboard bindings (`Space`, `Z`, `X`, `C`, `V`, `B`, `S`, `R`, `M`, arrows).
- **Native Web Audio API Engine & 10-band Winamp Equalizer**: Lazy-initialized DSP graph (`Preamp → 10× Peaking BiquadFilterNode 60Hz..16kHz → StereoPanner → MasterGain → AnalyserNode`), click-free parameter smoothing, bypass On/Off preserving settings, and 14 classic Winamp EQ presets.
- **Playlist Store & Offline Tags**: Fisher-Yates shuffle, Repeat (`off` / `all` / `one`), Winamp *Previous* (>3s restarts track), instant search, `ds-sortable` reordering, M3U/M3U8/PLS import & M3U8 export, and zero-network local ID3v1/ID3v2.3/ID3v2.4 metadata extraction.
- **Minimalist Theme (5 Scoped Palettes)**: `obsidian`, `slate`, `amber`, `emerald`, and `sand` compiled on `pkg:dot-stash/scss/engine` (`minimal.css` ~8.2 KB gzip, zero global host pollution).
- **Web / PWA & Embeddable Web Component**: Offline-capable app-shell Service Worker (`sw.js`, skipping Range/audio/cross-origin requests), SVG PWA icon, `manifest.webmanifest`, multi-instance `embed-demo.html`, and automated CI bundle weight budgets (`scripts/check-size.mjs`).
- **Tauri v2 Desktop (Portable & Installable)**: Size-optimized Rust shell (`opt-level = "s"`, `lto = true`, `strip = true`), `mplay3r://` HTTP `206 Partial Content` streaming with strict canonical `AllowedPaths` security allowlist, automatic portable mode detection (`portable.flag`, `./data/`, `MPLAY3R_PORTABLE=1`), and native OS file/folder/playlist dialogs.

### Added — Phase 2 (Plugin SDK, Store & Official Addons Ecosystem)
- **Plugin SDK & Sandboxed `PluginHost`** (`mplay3r/plugin-sdk`): 6 plugin categories (`source`, `broadcast`, `visualizer`, `scraper`, `dsp`, `theme`), 10 least-privilege declarative permissions, error isolation, automatic disposer cleanup, 4 UI slots (`visualizer`, `track-info`, `panel`, `theme-root`), and extensible `RadioProvider` / `MediaSourceProvider` registries.
- **Lazy-Loaded Addons Store (`<mp-store>`)**: Zero bytes added to `minimal.css`, cryptographic **SHA-256** verification via Web Crypto API before native ESM loading, zero-dependency local `.zip` plugin installer (`DecompressionStream('deflate-raw')`), multi-registry support, connected by default to the official [`jezoock/mPlay3r-addons`](https://github.com/jezoock/mPlay3r-addons) registry (10 official zero-dependency addons: Web/FM Radio, Freebox Multiposte, Podcasts, Local LAN Share + Rust server, Live Broadcast SSE/WebRTC, Visualizers, AudioWorklet DSP, Metadata Scraper, Winamp Classic/Hi-Fi Rack themes, and Winamp `.wsz` skin loader).
- **Release & GitHub Pages Pipelines**: Subpath-safe PWA/Embed builds deployed automatically to GitHub Pages (`.github/workflows/pages.yml`), combined Desktop + Web/Embed release artifacts with `SHA256SUMS.txt` (`.github/workflows/release.yml`), and automated release-readiness checks (`npm run check:release`).
