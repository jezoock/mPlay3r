# mPlay3r Architecture & Two-Phase Roadmap

## Design Goals

1. **Minimal weight across all targets**:
   - **Web / Embeddable Custom Element**: StencilJS light-DOM components + tree-shaken `dot-stash` components (`ds-trigger`, `ds-range`, `ds-icon`, `ds-toggle`, `ds-select`, `ds-sortable`, `ds-badge`, `ds-tooltip`, `ds-toaster`) + zero-dependency TypeScript audio/playlist core + Web Audio API native DSP (no external DSP/state/UI runtime libraries).
   - **Desktop (Portable & Installable)**: Tauri v2 (Rust) wrapping the exact same `www/` Stencil build using the OS native WebView (~5–10 MB standalone binaries vs ~150 MB for Electron).
2. **Declarative control via `dot-stash` (`ds-trigger`)**:
   - `<mplay3r-app>` acts as the light-DOM state & audio controller exposing public `@Method()` actions (`play`, `pause`, `togglePlay`, `stop`, `previous`, `next`, `playTrack`, `setPalette`, `toggleEqualizer`, `applyEqPreset`, etc.).
   - Every control in the UI — and any external control in a host page or Phase 2 theme — triggers the player through `<ds-trigger target="#mplay3r" action="...">`.
3. **Scoped CSS Token Theming**:
   - Built on `pkg:dot-stash/scss/engine`.
   - Each color scheme (`obsidian`, `slate`, `amber`, `emerald`, `sand`) overrides `--ds-color-*` and `--mp-*` tokens inside `[data-mp-palette='...']` and re-emits `@include ds-tokens(colorset, focus)`.
   - `dist/css/minimal.css` never touches global `body` / heading tags, so `<mplay3r-app>` embeds cleanly into third-party web apps.

---

## Signal & Data Flow (Phase 1)

```text
  <ds-trigger target="#mplay3r" action="...">     Keyboard / Drag & Drop / MediaSession
                       │                                           │
                       └──────────────────┬────────────────────────┘
                                          ▼
                                   <mplay3r-app>
                       ┌──────────────────┴──────────────────┐
                       ▼                                     ▼
                 PlaylistStore                          AudioEngine
         (shuffle, repeat, filter,              HTMLAudioElement
          M3U/PLS I/O, reorder)                   └─► MediaElementSource
                                                        └─► Preamp (GainNode)
                                                              └─► 10× BiquadFilterNode (60Hz..16kHz)
                                                                    └─► StereoPannerNode (Balance)
                                                                          └─► Master GainNode
                                                                                └─► AnalyserNode ──► Destination
                                                                                       ▲
                                                                          (Phase 2 Visualizer Hook)
```

### Desktop Streaming (`src-tauri/`)

- Custom URI scheme protocol `mplay3r://` (`http://mplay3r.localhost/` on Windows WebView2) with HTTP `206 Partial Content` byte-range chunking (512 KB chunks) so large lossless FLAC files stream smoothly with flat RAM usage.
- Strict path allowlist (`AllowedPaths`): only files explicitly opened via OS dialogs or restored from saved user playlists are served.
- Portable mode auto-detection (`portable.flag`, adjacent `data/` folder, or `MPLAY3R_PORTABLE=1`): writes all state into `./data/state.json` next to the binary.

---

## Phase 2 Readiness (Plugins, Store, Scrapers & Radical Themes)

Phase 1 deliberately ships **zero plugins and zero network scraping**, while exposing clean extension contracts on `<mplay3r-app>` so Phase 2 requires no breaking rewrite:

| Phase 2 Capability | Phase 1 Hook Already in Place |
| :--- | :--- |
| **Full-layout custom themes** | `<mplay3r-app id="mplay3r" headless>` renders only slotted markup; custom themes place `<ds-trigger target="#mplay3r" action="...">` anywhere and subscribe to `mpStateChange` / `mpTimeUpdate`. |
| **Winamp `.wsz` skin plugin** | Mounts a sprite-based renderer inside headless mode or a theme slot, delegating all clicks to `<mplay3r-app>` methods via `ds-trigger`. |
| **Visualizer plugins (Canvas / WebGL / GLSL / MilkDrop)** | `await player.getAudioAnalyser()` returns the live `AnalyserNode` (`fftSize = 2048`) connected post-EQ & post-volume. |
| **DSP / Audio effect plugins (`AudioWorklet`)** | `await player.getAudioContext()` exposes the `AudioContext` for inserting worklet nodes into the signal chain. |
| **Metadata scraping plugins** | `mpTrackChange` / `mpPlaylistChange` events + track metadata patching keep scraping 100% opt-in and external to the base build (CORS-free via Tauri Rust on desktop, CORS-friendly APIs on web). |
| **Integrated plugin store** | Decentralized JSON manifest registry (SHA-256 verified) installing into `./data/plugins/` (desktop portable), OS app data (desktop installed), or IndexedDB (web). |
