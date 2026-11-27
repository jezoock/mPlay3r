import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EQUALIZER_STATE } from '../src/core/constants';
import type { PlayerSnapshot, Track } from '../src/core/types';
import {
  compareSemver,
  createMemoryPluginStorage,
  isCoreVersionCompatible,
  PluginHost,
  PluginPermissionError,
  PluginValidationError,
  validatePluginManifest,
} from '../src/plugins';
import type { MPlay3rPlugin, PluginHostAdapter, PluginManifest, RadioProvider } from '../src/plugins';

const root = fileURLToPath(new URL('..', import.meta.url));

function createSnapshot(): PlayerSnapshot {
  return {
    status: 'stopped',
    currentTrack: null,
    currentIndex: -1,
    tracks: [],
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 0.85,
    muted: false,
    balance: 0,
    shuffle: false,
    repeat: 'off',
    showRemaining: false,
    equalizer: { ...DEFAULT_EQUALIZER_STATE, bands: [...DEFAULT_EQUALIZER_STATE.bands] },
    palette: 'obsidian',
    showEqualizer: false,
    showPlaylist: true,
    compact: false,
  };
}

function createMockAdapter(overrides: Partial<PluginHostAdapter> = {}): {
  adapter: PluginHostAdapter;
  calls: string[];
  patchedMeta: Array<{ trackId: string; title?: string }>;
  notifications: string[];
} {
  const calls: string[] = [];
  const patchedMeta: Array<{ trackId: string; title?: string }> = [];
  const notifications: string[] = [];
  const snapshot = createSnapshot();

  const adapter: PluginHostAdapter = {
    coreVersion: '0.1.0',
    getPlayerTarget: () => '#mplay3r',
    getState: () => snapshot,
    playback: {
      play: async () => void calls.push('play'),
      pause: async () => void calls.push('pause'),
      togglePlay: async () => void calls.push('togglePlay'),
      stop: async () => void calls.push('stop'),
      next: async () => void calls.push('next'),
      previous: async () => void calls.push('previous'),
      seek: async seconds => void calls.push(`seek:${seconds}`),
      setVolume: async vol => void calls.push(`volume:${vol}`),
      getStatus: () => snapshot.status,
    },
    playlist: {
      addTracks: async inputs => {
        calls.push(`addTracks:${inputs.length}`);
        return inputs.map((input, idx) => ({ id: `t-${idx}`, src: input.src, title: input.title || 'Track' })) as Track[];
      },
      removeTrack: async id => void calls.push(`removeTrack:${id}`),
      clearPlaylist: async () => void calls.push('clearPlaylist'),
    },
    updateTrackMetadata: async (trackId, patch) => {
      patchedMeta.push({ trackId, title: patch.title });
      return true;
    },
    getAudioAnalyser: async () => ({ fftSize: 2048 }) as unknown as AnalyserNode,
    getAudioContext: async () => ({ sampleRate: 48000 }) as unknown as AudioContext,
    notify: async message => void notifications.push(message),
    fetcher: (async url => ({ ok: true, status: 200, url: String(url) }) as unknown as Response) as typeof fetch,
    ...overrides,
  };

  return { adapter, calls, patchedMeta, notifications };
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'mplay3r.demo',
    name: 'Demo Plugin',
    version: '1.0.0',
    description: 'Unit test plugin',
    category: 'source',
    permissions: [],
    minCoreVersion: '0.1.0',
    ...overrides,
  };
}

describe('PR #7 Plugin SDK & Sandboxed PluginHost', () => {
  describe('manifest validation & semver compatibility', () => {
    it('validates well-formed manifests and deduplicates permissions', () => {
      const result = validatePluginManifest({
        id: 'mplay3r.radio-freebox',
        name: 'Freebox Radio Provider',
        version: '1.2.3',
        description: 'Provides Freebox multiposte radio streams',
        category: 'source',
        permissions: ['network', 'network', 'ui-slot'],
        minCoreVersion: '0.1.0',
        sha256: 'a'.repeat(64),
        sizeBytes: 4096,
      });

      assert.equal(result.valid, true);
      assert.ok(result.manifest);
      assert.deepEqual(result.manifest.permissions, ['network', 'ui-slot']);
      assert.equal(result.manifest.sha256, 'a'.repeat(64));
    });

    it('rejects malformed ids, unknown categories/permissions, invalid sha256, and incompatible minCoreVersion', () => {
      const invalid = validatePluginManifest({
        id: 'INVALID ID!',
        name: '',
        version: 'not-semver',
        description: '',
        category: 'unknown',
        permissions: ['root-shell'],
        sha256: 'deadbeef',
        sizeBytes: -10,
      });
      assert.equal(invalid.valid, false);
      assert.ok(invalid.errors.length >= 6);

      assert.equal(compareSemver('0.1.0', '0.2.0'), -1);
      assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
      assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
      assert.equal(isCoreVersionCompatible('0.1.0', '0.1.0'), true);
      assert.equal(isCoreVersionCompatible('0.2.0', '0.1.0'), false);
    });
  });

  describe('lifecycle, automatic cleanup & provider registry', () => {
    it('runs install -> enable -> disable -> uninstall and auto-cleans listeners, slots, themes, and providers', async () => {
      const { adapter } = createMockAdapter();
      const host = new PluginHost(adapter, createMemoryPluginStorage());
      const events: string[] = [];
      let deactivated = 0;

      const freeboxProvider: RadioProvider = {
        id: 'freebox-multiposte',
        name: 'Freebox Radios',
        async searchStations() {
          return [{ id: 'fip', name: 'FIP', streamUrl: 'https://stream.radiofrance.fr/fip/fip.m3u8', providerId: 'freebox-multiposte', isLive: true }];
        },
      };

      const plugin: MPlay3rPlugin = {
        manifest: makeManifest({
          id: 'mplay3r.radio-freebox',
          category: 'source',
          permissions: ['ui-slot', 'theme'],
        }),
        activate(ctx) {
          assert.equal(ctx.playerTarget, '#mplay3r');
          ctx.on('trackChange', ({ index }) => events.push(`track:${index}`));
          ctx.registerSlot({ id: 'radio-panel', slot: 'panel', title: 'Radios', mount: () => undefined });
          ctx.registerTheme({ id: 'retro', name: 'Retro CSS', css: '.mp-app { --mp-border: red; }' });
          ctx.registerProvider('radio', freeboxProvider);
        },
        deactivate() {
          deactivated += 1;
        },
      };

      const installed = await host.install(plugin);
      assert.equal(installed.status, 'active');
      assert.equal(host.getSlots('panel').length, 1);
      assert.equal(host.getActiveTheme()?.id, 'retro');
      assert.equal(host.getProviders('radio').length, 1);

      host.emitPlayerEvent('trackChange', { track: null, index: 2 });
      assert.deepEqual(events, ['track:2']);

      // Rejects duplicate installation of the same plugin id.
      await assert.rejects(() => host.install(plugin), PluginValidationError);

      // Disabling invokes deactivate() and releases EVERY resource even without manual cleanup.
      const disabled = await host.disable('mplay3r.radio-freebox');
      assert.equal(disabled.status, 'disabled');
      assert.equal(deactivated, 1);
      assert.equal(host.getSlots().length, 0);
      assert.equal(host.getActiveTheme(), null);
      assert.equal(host.getProviders('radio').length, 0);

      host.emitPlayerEvent('trackChange', { track: null, index: 3 });
      assert.deepEqual(events, ['track:2'], 'Listener must not fire after plugin disable');

      assert.equal(await host.uninstall('mplay3r.radio-freebox'), true);
      assert.equal(host.getPlugins().length, 0);
    });

    it('rejects plugins requiring a newer mPlay3r core version', async () => {
      const { adapter } = createMockAdapter({ coreVersion: '0.1.0' });
      const host = new PluginHost(adapter, createMemoryPluginStorage());
      const futurePlugin: MPlay3rPlugin = {
        manifest: makeManifest({ id: 'mplay3r.future', minCoreVersion: '2.0.0' }),
        activate() {},
      };
      await assert.rejects(() => host.install(futurePlugin), PluginValidationError);
    });
  });

  describe('strict least-privilege permission gating', () => {
    it('throws PluginPermissionError for every undeclared capability', async () => {
      const { adapter } = createMockAdapter();
      const host = new PluginHost(adapter, createMemoryPluginStorage());
      let capturedCtx: Parameters<MPlay3rPlugin['activate']>[0] | undefined;

      await host.install({
        manifest: makeManifest({ id: 'mplay3r.restricted', permissions: [] }),
        activate(ctx) {
          capturedCtx = ctx;
        },
      });

      assert.ok(capturedCtx);
      await assert.rejects(() => capturedCtx!.playback.play(), (err: unknown) => err instanceof PluginPermissionError && err.permission === 'playback-control');
      await assert.rejects(() => capturedCtx!.playlist.addTracks([{ src: '/a.mp3' }]), (err: unknown) => err instanceof PluginPermissionError && err.permission === 'playlist-write');
      await assert.rejects(() => capturedCtx!.updateTrackMetadata('t1', { title: 'New' }), (err: unknown) => err instanceof PluginPermissionError && err.permission === 'track-metadata');
      await assert.rejects(() => capturedCtx!.getAudioAnalyser(), (err: unknown) => err instanceof PluginPermissionError && err.permission === 'audio-analyser');
      await assert.rejects(() => capturedCtx!.getAudioContext(), (err: unknown) => err instanceof PluginPermissionError && err.permission === 'audio-context');
      await assert.rejects(() => capturedCtx!.fetch('https://example.com'), (err: unknown) => err instanceof PluginPermissionError && err.permission === 'network');
      assert.throws(() => capturedCtx!.registerSlot({ id: 'x', slot: 'panel', mount: () => undefined }), (err: unknown) => err instanceof PluginPermissionError && err.permission === 'ui-slot');
      assert.throws(() => capturedCtx!.registerTheme({ id: 'x', name: 'X' }), (err: unknown) => err instanceof PluginPermissionError && err.permission === 'theme');
      await assert.rejects(() => capturedCtx!.storage.set('k', 1), (err: unknown) => err instanceof PluginPermissionError && err.permission === 'storage');
    });

    it('grants exact declared capabilities and executes them through the host adapter', async () => {
      const { adapter, calls, patchedMeta } = createMockAdapter();
      const host = new PluginHost(adapter, createMemoryPluginStorage());
      let analyserFft = 0;
      let sampleRate = 0;
      let fetchOk = false;

      await host.install({
        manifest: makeManifest({
          id: 'mplay3r.full',
          category: 'visualizer',
          permissions: ['playback-control', 'playlist-write', 'track-metadata', 'audio-analyser', 'audio-context', 'network'],
        }),
        async activate(ctx) {
          await ctx.playback.play();
          await ctx.playback.seek(12);
          await ctx.playlist.addTracks([{ src: 'https://radio.example/live.mp3', title: 'Live' }]);
          await ctx.updateTrackMetadata('t-0', { title: 'ICY Live Title' });
          analyserFft = (await ctx.getAudioAnalyser())?.fftSize ?? 0;
          sampleRate = (await ctx.getAudioContext())?.sampleRate ?? 0;
          fetchOk = (await ctx.fetch('https://api.example/stations')).ok;
        },
      });

      assert.deepEqual(calls, ['play', 'seek:12', 'addTracks:1']);
      assert.deepEqual(patchedMeta, [{ trackId: 't-0', title: 'ICY Live Title' }]);
      assert.equal(analyserFft, 2048);
      assert.equal(sampleRate, 48000);
      assert.equal(fetchOk, true);
    });
  });

  describe('error isolation & persisted state', () => {
    it('isolates activate, event listener, and deactivate errors without affecting sibling plugins', async () => {
      const { adapter } = createMockAdapter();
      const host = new PluginHost(adapter, createMemoryPluginStorage());
      const healthyEvents: string[] = [];

      // 1. Failing activate() rolls back partial UI slot and sets status = 'error'.
      const brokenRecord = await host.install({
        manifest: makeManifest({ id: 'mplay3r.broken-activate', permissions: ['ui-slot'] }),
        activate(ctx) {
          ctx.registerSlot({ id: 'leaked', slot: 'visualizer', mount: () => undefined });
          throw new Error('boom during activate');
        },
      });
      assert.equal(brokenRecord.status, 'error');
      assert.equal(brokenRecord.enabled, false);
      assert.equal(brokenRecord.lastError, 'boom during activate');
      assert.equal(host.getSlots('visualizer').length, 0, 'Partial registrations must be rolled back');

      // 2. Throwing event listener in plugin A must not prevent plugin B from receiving the event.
      await host.install({
        manifest: makeManifest({ id: 'mplay3r.throw-listener' }),
        activate(ctx) {
          ctx.on('paletteChange', () => {
            throw new Error('listener exploded');
          });
        },
        deactivate() {
          throw new Error('deactivate exploded');
        },
      });
      await host.install({
        manifest: makeManifest({ id: 'mplay3r.healthy' }),
        activate(ctx) {
          ctx.on('paletteChange', ({ palette }) => healthyEvents.push(palette));
        },
      });

      assert.doesNotThrow(() => host.emitPlayerEvent('paletteChange', { palette: 'emerald' }));
      assert.deepEqual(healthyEvents, ['emerald']);
      assert.equal(host.getPlugin('mplay3r.throw-listener')?.lastError, 'listener exploded');

      // 3. Throwing deactivate() still transitions cleanly to disabled.
      const disabled = await host.disable('mplay3r.throw-listener');
      assert.equal(disabled.status, 'disabled');
    });

    it('persists enabled/disabled state across host restarts and isolates per-plugin storage namespaces', async () => {
      const backend = createMemoryPluginStorage();
      const { adapter } = createMockAdapter();
      const host1 = new PluginHost(adapter, backend);

      let storageA!: Parameters<MPlay3rPlugin['activate']>[0]['storage'];
      let storageB!: Parameters<MPlay3rPlugin['activate']>[0]['storage'];

      const pluginA: MPlay3rPlugin = {
        manifest: makeManifest({ id: 'mplay3r.plugin-a', permissions: ['storage'] }),
        activate(ctx) {
          storageA = ctx.storage;
        },
      };
      const pluginB: MPlay3rPlugin = {
        manifest: makeManifest({ id: 'mplay3r.plugin-b', permissions: ['storage'] }),
        activate(ctx) {
          storageB = ctx.storage;
        },
      };

      await host1.install(pluginA);
      await host1.install(pluginB);
      await storageA.set('favorites', ['FIP']);
      await storageB.set('favorites', ['Nova']);

      assert.deepEqual(await storageA.get('favorites'), ['FIP']);
      assert.deepEqual(await storageB.get('favorites'), ['Nova']);
      await storageA.clear();
      assert.equal(await storageA.get('favorites'), null);
      assert.deepEqual(await storageB.get('favorites'), ['Nova'], 'Clearing plugin A storage must never touch plugin B');

      // Disable pluginA, then create a fresh PluginHost sharing the same persisted backend.
      await host1.disable('mplay3r.plugin-a');

      let reactivatedA = false;
      let reactivatedB = false;
      const host2 = new PluginHost(adapter, backend);
      const recA = await host2.install({
        manifest: pluginA.manifest,
        activate() {
          reactivatedA = true;
        },
      });
      const recB = await host2.install({
        manifest: pluginB.manifest,
        activate() {
          reactivatedB = true;
        },
      });

      assert.equal(recA.status, 'disabled');
      assert.equal(reactivatedA, false, 'Previously disabled plugin must remain disabled across restart');
      assert.equal(recB.status, 'active');
      assert.equal(reactivatedB, true);
    });
  });

  describe('<mplay3r-app> plugin slots & ds-trigger host integration', () => {
    it('exposes plugin lifecycle methods and UI slot regions on mplay3r-app', () => {
      const appSource = fs.readFileSync(path.join(root, 'src', 'components', 'mplay3r-app', 'mplay3r-app.tsx'), 'utf8');
      for (const method of [
        'getPluginHost',
        'registerPlugin',
        'enablePlugin',
        'disablePlugin',
        'uninstallPlugin',
        'togglePluginPanel',
        'updateTrackMetadata',
      ]) {
        assert.match(appSource, new RegExp(`@Method\\(\\)\\s+async\\s+${method}\\s*\\(`), `Missing @Method() ${method} on MPlay3rApp`);
      }
      assert.ok(appSource.includes('mp-slot --visualizer'), 'Missing visualizer UI slot in mplay3r-app');
      assert.ok(appSource.includes('mp-slot --track-info'), 'Missing track-info UI slot in mplay3r-app');
      assert.ok(appSource.includes('mp-slot --panel'), 'Missing panel UI slot in mplay3r-app');
      assert.ok(appSource.includes('mp-slot --theme-root'), 'Missing theme-root UI slot in mplay3r-app');
    });
  });
});
