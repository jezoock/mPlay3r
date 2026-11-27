import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AudioEngine } from '../src/core/audio-engine';
import { parseId3TagsFromBuffer } from '../src/core/metadata';
import { parsePlaylistContent, serializeM3u } from '../src/core/playlist-io';
import { PlaylistStore } from '../src/core/playlist-store';
import type { PlayerSnapshot, Track } from '../src/core/types';
import {
  createMemoryPluginStorage,
  PluginHost,
  PluginIntegrityError,
  PluginPermissionError,
  PluginStore,
  sha256Hex,
} from '../src/plugins';
import type { MPlay3rPlugin, PluginHostAdapter, PluginManifest } from '../src/plugins';

function createMockAudioEnv() {
  const listeners = new Map<string, Array<() => void>>();
  const audioEl = {
    src: '',
    preload: '',
    crossOrigin: null as string | null,
    currentTime: 0,
    duration: 240,
    volume: 1,
    muted: false,
    playbackRate: 1,
    defaultPlaybackRate: 1,
    preservesPitch: true,
    buffered: { length: 1, end: () => 180 },
    error: null as { code: number } | null,
    removeAttribute() {
      this.crossOrigin = null;
    },
    load() {
      // Simulate browsers resetting playbackRate on audio.load().
      this.playbackRate = 1;
    },
    async play() {
      listeners.get('playing')?.forEach(fn => fn());
    },
    pause() {
      listeners.get('pause')?.forEach(fn => fn());
    },
    addEventListener(type: string, fn: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    emit(type: string) {
      listeners.get(type)?.forEach(fn => fn());
    },
  };

  const makeParam = (initial = 0) => ({
    value: initial,
    setTargetAtTime(val: number) {
      this.value = val;
    },
  });

  const analyser = { fftSize: 2048, smoothingTimeConstant: 0.8, connect: () => undefined };
  const audioContext = {
    state: 'running',
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    async resume() {
      this.state = 'running';
    },
    async close() {
      this.state = 'closed';
    },
    createMediaElementSource: () => ({ connect: () => undefined }),
    createGain: () => ({ gain: makeParam(1), connect: () => undefined }),
    createBiquadFilter: () => ({
      type: '',
      frequency: makeParam(0),
      Q: makeParam(1),
      gain: makeParam(0),
      connect: () => undefined,
    }),
    createStereoPanner: () => ({ pan: makeParam(0), connect: () => undefined }),
    createAnalyser: () => analyser,
  };

  return { audioEl, audioContext, analyser };
}

/**
 * Full headless integration harness wiring real `AudioEngine` + real `PlaylistStore`
 * + real `PluginHost` + real `PluginStore` identically to `<mplay3r-app>`.
 */
function createIntegratedRuntime(registryFetcher: typeof fetch) {
  const env = createMockAudioEnv();
  const playlist = new PlaylistStore();
  const notifications: Array<{ message: string; variant: string }> = [];
  const storage = createMemoryPluginStorage();

  const engine = new AudioEngine(
    {},
    {
      createAudioElement: () => env.audioEl as unknown as HTMLAudioElement,
      createAudioContext: () => env.audioContext as unknown as AudioContext,
    },
  );

  const buildSnapshot = (): PlayerSnapshot => ({
    status: engine.getStatus(),
    currentTrack: playlist.getCurrentTrack(),
    currentIndex: playlist.getCurrentIndex(),
    tracks: playlist.getTracks(),
    currentTime: engine.getCurrentTime(),
    duration: engine.getDuration(),
    buffered: engine.getBuffered(),
    volume: engine.getVolume(),
    muted: engine.isMuted(),
    balance: engine.getBalance(),
    playbackRate: engine.getPlaybackRate(),
    shuffle: playlist.isShuffle(),
    repeat: playlist.getRepeat(),
    showRemaining: false,
    equalizer: engine.getEqualizerState(),
    palette: 'obsidian',
    showEqualizer: false,
    showPlaylist: true,
    compact: false,
  });

  const adapter: PluginHostAdapter = {
    coreVersion: '0.1.0',
    getPlayerTarget: () => '#mplay3r-e2e',
    getState: buildSnapshot,
    playback: {
      play: async () => {
        const track = playlist.getCurrentTrack();
        if (track) await engine.play(track.src);
      },
      pause: async () => engine.pause(),
      togglePlay: async () => {
        if (engine.getStatus() === 'playing') {
          engine.pause();
        } else {
          const track = playlist.getCurrentTrack();
          if (track) await engine.play(track.src);
        }
      },
      stop: async () => engine.stop(),
      next: async () => {
        const res = playlist.next(false);
        if (res.action === 'play' && res.track) {
          host.emitPlayerEvent('trackChange', { track: res.track, index: res.index });
          await engine.play(res.track.src);
        }
      },
      previous: async () => {
        const res = playlist.previous(engine.getCurrentTime());
        if (res.action === 'play' && res.track) {
          host.emitPlayerEvent('trackChange', { track: res.track, index: res.index });
          await engine.play(res.track.src);
        }
      },
      seek: async seconds => {
        engine.seek(seconds);
      },
      setVolume: async vol => {
        engine.setVolume(vol);
      },
      setPlaybackRate: async rate => {
        engine.setPlaybackRate(rate);
      },
      getPlaybackRate: () => engine.getPlaybackRate(),
      getStatus: () => engine.getStatus(),
    },
    playlist: {
      addTracks: async (inputs, autoplayIfEmpty = false) => {
        const wasEmpty = playlist.getTracks().length === 0;
        const added = playlist.addTracks(inputs);
        if (wasEmpty && added.length > 0) {
          const first = playlist.getCurrentTrack();
          if (first) {
            host.emitPlayerEvent('trackChange', { track: first, index: 0 });
            if (autoplayIfEmpty) {
              await engine.play(first.src);
            } else {
              engine.loadSource(first.src);
            }
          }
        }
        return added;
      },
      removeTrack: async id => {
        playlist.removeTrack(id);
      },
      clearPlaylist: async () => {
        engine.stop();
        playlist.clear();
      },
    },
    updateTrackMetadata: async (trackId, patch) => {
      const existing = playlist.getTracks().find(t => t.id === trackId);
      if (!existing) return false;
      playlist.updateTrackMeta(trackId, patch);
      return true;
    },
    getAudioAnalyser: async () => engine.getAnalyserNode(),
    getAudioContext: async () => engine.getAudioContext(),
    notify: async (message, variant = '') => {
      notifications.push({ message, variant });
    },
    fetcher: registryFetcher,
  };

  const host = new PluginHost(adapter, storage);

  const dataUrlModuleLoader = async (sourceBytes: Uint8Array): Promise<MPlay3rPlugin> => {
    let bin = '';
    for (let i = 0; i < sourceBytes.length; i += 1) {
      bin += String.fromCharCode(sourceBytes[i]);
    }
    const mod = (await import(`data:text/javascript;base64,${btoa(bin)}`)) as {
      default?: MPlay3rPlugin;
      plugin?: MPlay3rPlugin;
    };
    const plugin = mod.default ?? mod.plugin;
    if (!plugin) throw new Error('Invalid test ESM plugin bundle');
    return plugin;
  };

  const store = new PluginStore({
    coreVersion: '0.1.0',
    initialRegistries: ['https://addons.mplay3r.test/registry.json'],
    storageBackend: storage,
    fetcher: registryFetcher,
    moduleLoader: dataUrlModuleLoader,
  });

  return { env, engine, playlist, host, store, notifications };
}

async function createSignedRegistry(
  bundles: Array<{ file: string; manifest: PluginManifest; source: string }>,
): Promise<{
  fetcher: typeof fetch;
  tamperFile(file: string, nextSource: string): void;
}> {
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  const registryPlugins: PluginManifest[] = [];

  for (const item of bundles) {
    const bytes = encoder.encode(item.source);
    const digest = await sha256Hex(bytes);
    files.set(item.file, bytes);
    registryPlugins.push({
      ...item.manifest,
      entry: `./dist/${item.file}`,
      sha256: digest,
      sizeBytes: bytes.byteLength,
    });
  }

  const registryJson = JSON.stringify({
    schemaVersion: 1,
    name: 'mPlay3r E2E Official Registry',
    plugins: registryPlugins,
  });

  const fetcher = (async (input: string | URL) => {
    const href = String(input);
    if (href === 'https://addons.mplay3r.test/registry.json') {
      return new Response(registryJson, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const prefix = 'https://addons.mplay3r.test/dist/';
    if (href.startsWith(prefix)) {
      const name = href.slice(prefix.length);
      const bytes = files.get(name);
      if (bytes) {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return new Response(copy.buffer, { status: 200, headers: { 'Content-Type': 'text/javascript' } });
      }
    }
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;

  return {
    fetcher,
    tamperFile(file: string, nextSource: string) {
      files.set(file, encoder.encode(nextSource));
    },
  };
}

describe('PR #19 — End-to-End Core ↔ Addons Integration Suite', () => {
  it('installs SHA-256 verified plugins, enforces tamper rejection, wires Radio/MediaSource/Scraper/Visualizer/Themes without audio interruption, and cleans up on uninstall', async () => {
    const radioBoxManifest: PluginManifest = {
      id: 'mplay3r.radio-bbox',
      name: 'Bbox Radios',
      version: '1.0.0',
      description: 'Bouygues Bbox ISP radio provider',
      category: 'source',
      permissions: ['network'],
      minCoreVersion: '0.1.0',
    };
    const radioBoxSource = `
      export const manifest = ${JSON.stringify(radioBoxManifest)};
      export default {
        manifest,
        activate(ctx) {
          ctx.registerProvider('radio', {
            id: 'bbox-bouygues',
            name: 'Bbox (Bouygues)',
            async searchStations(q) {
              return [{
                id: 'bbox:fip',
                name: 'FIP ' + q,
                streamUrl: 'https://icecast.radiofrance.fr/fip-hifi.aac',
                providerId: 'bbox-bouygues',
                isLive: true,
              }];
            },
          });
        },
      };
    `;

    const subsonicManifest: PluginManifest = {
      id: 'mplay3r.source-subsonic',
      name: 'Subsonic & Navidrome',
      version: '1.0.0',
      description: 'OpenSubsonic source + playback rate driver',
      category: 'source',
      permissions: ['playlist-write', 'playback-control', 'ui-slot'],
      minCoreVersion: '0.1.0',
    };
    const subsonicSource = `
      export const manifest = ${JSON.stringify(subsonicManifest)};
      export default {
        manifest,
        async activate(ctx) {
          ctx.registerProvider('media-source', {
            id: 'mplay3r-subsonic',
            name: 'Subsonic / Navidrome',
            async search(q) {
              return [
                { id: 'sub:1', title: q + ' Ep 1', streamUrl: 'https://navidrome.local/rest/stream.view?id=1', artist: 'Daft Punk', providerId: 'mplay3r-subsonic' },
                { id: 'sub:2', title: q + ' Ep 2', streamUrl: 'https://navidrome.local/rest/stream.view?id=2', artist: 'Air', providerId: 'mplay3r-subsonic' },
              ];
            },
          });
          ctx.registerSlot({ id: 'subsonic-panel', slot: 'panel', title: 'Subsonic', mount() {} });
          await ctx.playlist.addTracks([
            { id: 'tr-1', src: 'https://navidrome.local/rest/stream.view?id=1', title: '01 - raw_filename' },
            { id: 'tr-2', src: 'https://navidrome.local/rest/stream.view?id=2', title: '02 - Voyager' },
          ], true);
          await ctx.playback.setPlaybackRate(1.5);
        },
      };
    `;

    const scraperManifest: PluginManifest = {
      id: 'mplay3r.scraper',
      name: 'Metadata Scraper',
      version: '1.0.0',
      description: 'Opt-in track metadata enrichment on trackChange',
      category: 'scraper',
      permissions: ['track-metadata', 'audio-analyser', 'ui-slot'],
      minCoreVersion: '0.1.0',
    };
    const scraperSource = `
      export const manifest = ${JSON.stringify(scraperManifest)};
      export default {
        manifest,
        activate(ctx) {
          ctx.registerSlot({ id: 'lyrics', slot: 'track-info', title: 'Lyrics', mount() {} });
          ctx.on('trackChange', ({ track }) => {
            if (track && track.id === 'tr-2') {
              void ctx.updateTrackMetadata('tr-2', { title: 'Voyager (Remastered)', artist: 'Daft Punk', album: 'Discovery' });
            }
          });
        },
      };
    `;

    const themeClassicManifest: PluginManifest = {
      id: 'mplay3r.theme-classic',
      name: 'Winamp Classic 2.x',
      version: '1.0.0',
      description: 'Classic beveled deck structural theme',
      category: 'theme',
      permissions: ['theme'],
      minCoreVersion: '0.1.0',
    };
    const themeClassicSource = `
      export const manifest = ${JSON.stringify(themeClassicManifest)};
      export default {
        manifest,
        activate(ctx) {
          ctx.registerTheme({ id: 'classic-2x', name: 'Winamp Classic 2.x', css: '.mp-shell { border-radius: 0; }' });
        },
      };
    `;

    const tamperedManifest: PluginManifest = {
      id: 'mplay3r.tampered',
      name: 'Tampered Bundle',
      version: '1.0.0',
      description: 'Must be rejected before execution',
      category: 'dsp',
      permissions: [],
      minCoreVersion: '0.1.0',
    };
    const tamperedOriginal = `
      export const manifest = ${JSON.stringify(tamperedManifest)};
      export default { manifest, activate() {} };
    `;

    const signed = await createSignedRegistry([
      { file: 'radio-bbox.js', manifest: radioBoxManifest, source: radioBoxSource },
      { file: 'source-subsonic.js', manifest: subsonicManifest, source: subsonicSource },
      { file: 'scraper.js', manifest: scraperManifest, source: scraperSource },
      { file: 'theme-classic.js', manifest: themeClassicManifest, source: themeClassicSource },
      { file: 'tampered.js', manifest: tamperedManifest, source: tamperedOriginal },
    ]);

    const { env, engine, playlist, host, store } = createIntegratedRuntime(signed.fetcher);

    // 1. Refresh official signed catalog
    const catalog = await store.refreshCatalog(host.getPlugins());
    assert.equal(catalog.errors.length, 0);
    assert.equal(catalog.items.length, 5);

    const byId = new Map(catalog.items.map(i => [i.manifest.id, i]));

    // 2. Flip a single byte in tampered.js and verify SHA-256 blocks loading BEFORE execution
    signed.tamperFile('tampered.js', `${tamperedOriginal}\nglobalThis.__SHOULD_NOT_RUN__ = true;\n`);
    await assert.rejects(
      () => store.installFromCatalog(byId.get('mplay3r.tampered')!, host),
      PluginIntegrityError,
    );
    assert.equal(host.getPlugin('mplay3r.tampered'), undefined);
    assert.equal((globalThis as { __SHOULD_NOT_RUN__?: boolean }).__SHOULD_NOT_RUN__, undefined);

    // 3. Install ISP box radio + scraper + Subsonic connector from signed catalog
    await store.installFromCatalog(byId.get('mplay3r.radio-bbox')!, host);
    await store.installFromCatalog(byId.get('mplay3r.scraper')!, host);
    await store.installFromCatalog(byId.get('mplay3r.source-subsonic')!, host);

    // Cross-plugin RadioProvider & MediaSourceProvider discovery
    const radioProviders = host.getProviders('radio');
    assert.equal(radioProviders.length, 1);
    const stations = await radioProviders[0].searchStations('FM');
    assert.equal(stations[0].name, 'FIP FM');

    const mediaProviders = host.getProviders('media-source');
    assert.equal(mediaProviders.length, 1);
    const searchHits = await mediaProviders[0].search('Daft');
    assert.equal(searchHits.length, 2);

    // Subsonic plugin queued 2 tracks, auto-played track 1, and set speed to 1.5x!
    assert.equal(engine.getStatus(), 'playing');
    assert.equal(engine.getPlaybackRate(), 1.5);
    assert.equal(env.audioEl.playbackRate, 1.5);
    assert.equal(env.audioEl.preservesPitch, true);
    assert.ok(engine.getAnalyserNode() !== null, 'Live Web Audio AnalyserNode must be ready during playback');

    // 4. Advance to track 2: speed persists across loadSource() AND scraper enriches metadata!
    const nav = playlist.next(false);
    assert.equal(nav.action, 'play');
    assert.ok(nav.track);
    host.emitPlayerEvent('trackChange', { track: nav.track, index: nav.index });
    await engine.play(nav.track.src);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(env.audioEl.playbackRate, 1.5, 'Playback speed must persist across track changes');
    const enriched = playlist.getTracks().find((t: Track) => t.id === 'tr-2');
    assert.equal(enriched?.title, 'Voyager (Remastered)');
    assert.equal(enriched?.artist, 'Daft Punk');
    assert.equal(enriched?.album, 'Discovery');

    // M3U export + re-import round-trip reflects enriched metadata
    const m3u = serializeM3u(playlist.getTracks());
    const reimported = parsePlaylistContent(m3u, 'session.m3u8');
    assert.equal(reimported.length, 2);
    assert.equal(reimported[1].artist, 'Daft Punk');
    assert.equal(reimported[1].title, 'Voyager (Remastered)');

    // 5. Hot structural theme switch during active playback with EQ enabled -> ZERO audio interruption!
    engine.applyEqPreset('rock');
    engine.seek(42);
    await store.installFromCatalog(byId.get('mplay3r.theme-classic')!, host);
    assert.equal(host.getActiveTheme()?.id, 'classic-2x');
    assert.equal(engine.getStatus(), 'playing');
    assert.equal(engine.getCurrentTime(), 42);
    assert.equal(engine.getEqualizerState().preset, 'rock');
    assert.equal(engine.getPlaybackRate(), 1.5);

    // Switch back to default minimalist theme hot
    host.setActiveTheme(null);
    assert.equal(host.getActiveTheme(), null);
    assert.equal(engine.getStatus(), 'playing');
    assert.equal(engine.getCurrentTime(), 42);

    // 6. Unauthorized plugin trying to mutate playback or track metadata is strictly isolated
    let blockedErr: unknown = null;
    await host.install({
      manifest: {
        id: 'mplay3r.readonly-test',
        name: 'Readonly Plugin',
        version: '1.0.0',
        description: 'Has zero write permissions',
        category: 'visualizer',
        permissions: [],
        minCoreVersion: '0.1.0',
      },
      async activate(ctx) {
        try {
          await ctx.updateTrackMetadata('tr-2', { title: 'Hacked' });
        } catch (err) {
          blockedErr = err;
        }
      },
    });
    assert.ok(blockedErr instanceof PluginPermissionError);
    assert.equal(playlist.getTracks().find(t => t.id === 'tr-2')?.title, 'Voyager (Remastered)');

    // 7. Full teardown & uninstall releases every slot, provider, theme, and plugin
    for (const rec of host.getPlugins()) {
      await host.uninstall(rec.manifest.id);
    }
    assert.equal(host.getPlugins().length, 0);
    assert.equal(host.getSlots().length, 0);
    assert.equal(host.getThemes().length, 0);
    assert.equal(host.getProviders('radio').length, 0);
    assert.equal(host.getProviders('media-source').length, 0);

    engine.destroy();
  });

  it('round-trips Rust-format ID3v2.3 UTF-16LE-with-BOM headers through TypeScript parseId3TagsFromBuffer()', () => {
    // Matches exact byte layout produced by src-tauri/src/tags.rs (ID3v2.3 + UTF-16LE BOM 0x01 0xFF 0xFE).
    const makeFrame = (id: string, text: string): Uint8Array => {
      const payload = new Uint8Array(1 + 2 + text.length * 2);
      payload[0] = 0x01; // UTF-16 with BOM
      payload[1] = 0xff;
      payload[2] = 0xfe;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        payload[3 + i * 2] = code & 0xff;
        payload[3 + i * 2 + 1] = (code >> 8) & 0xff;
      }
      const frame = new Uint8Array(10 + payload.length);
      for (let i = 0; i < 4; i += 1) frame[i] = id.charCodeAt(i);
      new DataView(frame.buffer).setUint32(4, payload.length, false);
      frame.set(payload, 10);
      return frame;
    };

    const frames = [
      makeFrame('TIT2', 'Été — Cœur'),
      makeFrame('TPE1', 'Daft Punk'),
      makeFrame('TALB', 'Discovery (Édition Spéciale)'),
    ];
    const bodySize = frames.reduce((sum, f) => sum + f.length, 0);
    const audioTail = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
    const file = new Uint8Array(10 + bodySize + audioTail.length);
    file[0] = 0x49; // I
    file[1] = 0x44; // D
    file[2] = 0x33; // 3
    file[3] = 3; // v2.3
    file[4] = 0;
    file[5] = 0;
    // Syncsafe tag size
    file[6] = (bodySize >> 21) & 0x7f;
    file[7] = (bodySize >> 14) & 0x7f;
    file[8] = (bodySize >> 7) & 0x7f;
    file[9] = bodySize & 0x7f;
    let offset = 10;
    for (const f of frames) {
      file.set(f, offset);
      offset += f.length;
    }
    file.set(audioTail, offset);

    const parsed = parseId3TagsFromBuffer(file.buffer);
    assert.equal(parsed.title, 'Été — Cœur');
    assert.equal(parsed.artist, 'Daft Punk');
    assert.equal(parsed.album, 'Discovery (Édition Spéciale)');
  });
});
