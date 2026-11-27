import {
  createDefaultPluginStorage,
  createScopedPluginStorage,
  loadPluginRegistry,
  savePluginRegistry,
} from './storage';
import type { PersistedPluginRegistry, PluginStorageBackend } from './storage';
import {
  PluginPermissionError,
  PluginValidationError,
} from './types';
import type {
  InstalledPluginRecord,
  MPlay3rPlugin,
  PluginContext,
  PluginDisposer,
  PluginEventMap,
  PluginHostAdapter,
  PluginManifest,
  PluginPermission,
  PluginPlaybackApi,
  PluginPlaylistApi,
  PluginProviderKind,
  PluginProviderTypeMap,
  PluginSlotDescriptor,
  PluginSlotName,
  PluginThemeDescriptor,
  RegisteredPluginSlot,
  RegisteredPluginTheme,
  TrackMetadataPatch,
} from './types';
import { isCoreVersionCompatible, validatePluginManifest } from './validation';

interface ManagedPluginEntry {
  plugin: MPlay3rPlugin;
  record: InstalledPluginRecord;
  disposers: Set<PluginDisposer>;
}

type ChangeListener = () => void;

export interface InstallPluginOptions {
  /** Override whether to activate on install (defaults to persisted state if known, else `true`). */
  enable?: boolean;
}

/**
 * Sandboxed Phase 2 plugin runtime host.
 *
 * Enforces declarative manifest validation, semver compatibility, least-privilege permissions,
 * automatic disposer cleanup on disable/uninstall, and strict error isolation so a faulty
 * plugin can never crash mPlay3r or interfere with sibling plugins.
 */
export class PluginHost {
  private readonly adapter: PluginHostAdapter;
  private readonly storageBackend: PluginStorageBackend;
  private readonly entries = new Map<string, ManagedPluginEntry>();
  private readonly eventListeners: {
    [K in keyof PluginEventMap]: Map<PluginDisposer, { pluginId: string; listener: (payload: PluginEventMap[K]) => void }>;
  } = {
    stateChange: new Map(),
    trackChange: new Map(),
    timeUpdate: new Map(),
    playlistChange: new Map(),
    eqChange: new Map(),
    paletteChange: new Map(),
    error: new Map(),
  };
  private readonly slots = new Map<string, RegisteredPluginSlot>();
  private readonly themes = new Map<string, RegisteredPluginTheme>();
  private readonly providers: {
    [K in PluginProviderKind]: Map<string, { pluginId: string; provider: PluginProviderTypeMap[K] }>;
  } = {
    radio: new Map(),
    'media-source': new Map(),
  };
  private readonly changeListeners = new Set<ChangeListener>();
  private activeThemeKey: string | null = null;
  private persistedRegistry: PersistedPluginRegistry | null = null;

  constructor(adapter: PluginHostAdapter, storageBackend: PluginStorageBackend = createDefaultPluginStorage()) {
    this.adapter = adapter;
    this.storageBackend = storageBackend;
  }

  /** Subscribes to host registry, slot, theme, or provider changes (used by `<mplay3r-app>` to re-render). */
  subscribe(listener: ChangeListener): PluginDisposer {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Installs and validates a plugin, optionally activating it right away. */
  async install(plugin: MPlay3rPlugin, options: InstallPluginOptions = {}): Promise<InstalledPluginRecord> {
    if (!plugin || typeof plugin.activate !== 'function') {
      throw new PluginValidationError(['Plugin must expose an activate(ctx) function']);
    }

    const validation = validatePluginManifest(plugin.manifest);
    if (!validation.valid || !validation.manifest) {
      throw new PluginValidationError(validation.errors);
    }

    const manifest = validation.manifest;
    if (!isCoreVersionCompatible(manifest.minCoreVersion, this.adapter.coreVersion)) {
      throw new PluginValidationError([
        `Plugin "${manifest.id}" requires mPlay3r >= ${manifest.minCoreVersion} (current: ${this.adapter.coreVersion})`,
      ]);
    }

    if (this.entries.has(manifest.id)) {
      throw new PluginValidationError([`Plugin "${manifest.id}" is already installed`]);
    }

    const registry = await this.ensurePersistedRegistry();
    const shouldEnable =
      options.enable !== undefined ? options.enable : (registry[manifest.id]?.enabled ?? true);

    const record: InstalledPluginRecord = {
      manifest,
      status: shouldEnable ? 'installed' : 'disabled',
      enabled: shouldEnable,
    };

    this.entries.set(manifest.id, {
      plugin,
      record,
      disposers: new Set(),
    });

    registry[manifest.id] = { enabled: shouldEnable, version: manifest.version };
    await savePluginRegistry(this.storageBackend, registry);

    if (shouldEnable) {
      return this.enable(manifest.id);
    }

    this.notifyChange();
    return this.cloneRecord(record);
  }

  /** Activates an installed plugin with a fresh permission-gated context. Errors are isolated per plugin. */
  async enable(pluginId: string): Promise<InstalledPluginRecord> {
    const entry = this.entries.get(pluginId);
    if (!entry) {
      throw new Error(`Plugin "${pluginId}" is not installed.`);
    }
    if (entry.record.status === 'active') {
      return this.cloneRecord(entry.record);
    }

    const ctx = this.createContext(entry);
    try {
      await entry.plugin.activate(ctx);
      entry.record.status = 'active';
      entry.record.enabled = true;
      entry.record.lastError = undefined;
    } catch (error) {
      this.runDisposers(entry);
      entry.record.status = 'error';
      entry.record.enabled = false;
      entry.record.lastError = error instanceof Error ? error.message : String(error);
    }

    const registry = await this.ensurePersistedRegistry();
    registry[pluginId] = {
      enabled: entry.record.enabled,
      version: entry.record.manifest.version,
    };
    await savePluginRegistry(this.storageBackend, registry);

    this.notifyChange();
    return this.cloneRecord(entry.record);
  }

  /** Deactivates a plugin and unconditionally releases all its listeners, UI slots, themes, and providers. */
  async disable(pluginId: string): Promise<InstalledPluginRecord> {
    const entry = this.entries.get(pluginId);
    if (!entry) {
      throw new Error(`Plugin "${pluginId}" is not installed.`);
    }

    if (entry.record.status === 'active') {
      try {
        await entry.plugin.deactivate?.();
      } catch (error) {
        entry.record.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    this.runDisposers(entry);
    entry.record.status = 'disabled';
    entry.record.enabled = false;

    const registry = await this.ensurePersistedRegistry();
    registry[pluginId] = {
      enabled: false,
      version: entry.record.manifest.version,
    };
    await savePluginRegistry(this.storageBackend, registry);

    this.notifyChange();
    return this.cloneRecord(entry.record);
  }

  /** Deactivates and completely removes a plugin from the host and persisted registry. */
  async uninstall(pluginId: string): Promise<boolean> {
    const entry = this.entries.get(pluginId);
    if (!entry) {
      return false;
    }

    if (entry.record.status === 'active') {
      await this.disable(pluginId);
    } else {
      this.runDisposers(entry);
    }

    this.entries.delete(pluginId);
    const registry = await this.ensurePersistedRegistry();
    delete registry[pluginId];
    await savePluginRegistry(this.storageBackend, registry);

    this.notifyChange();
    return true;
  }

  /** Dispatches a player event to every subscribed plugin, isolating listener errors individually. */
  emitPlayerEvent<K extends keyof PluginEventMap>(event: K, payload: PluginEventMap[K]): void {
    const map = this.eventListeners[event];
    for (const sub of Array.from(map.values())) {
      try {
        sub.listener(payload);
      } catch (error) {
        const entry = this.entries.get(sub.pluginId);
        if (entry) {
          entry.record.lastError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  getPlugins(): InstalledPluginRecord[] {
    return Array.from(this.entries.values(), entry => this.cloneRecord(entry.record));
  }

  getPlugin(pluginId: string): InstalledPluginRecord | undefined {
    const entry = this.entries.get(pluginId);
    return entry ? this.cloneRecord(entry.record) : undefined;
  }

  getSlots(slotName?: Exclude<PluginSlotName, 'theme-root'>): RegisteredPluginSlot[] {
    const all = Array.from(this.slots.values());
    return slotName ? all.filter(s => s.slot === slotName) : all;
  }

  getThemes(): RegisteredPluginTheme[] {
    return Array.from(this.themes.values());
  }

  getActiveTheme(): RegisteredPluginTheme | null {
    return this.activeThemeKey ? (this.themes.get(this.activeThemeKey) ?? null) : null;
  }

  setActiveTheme(themeKey: string | null): void {
    if (themeKey !== null && !this.themes.has(themeKey)) {
      return;
    }
    this.activeThemeKey = themeKey;
    this.notifyChange();
  }

  getProviders<K extends PluginProviderKind>(kind: K): PluginProviderTypeMap[K][] {
    return Array.from(this.providers[kind].values(), item => item.provider);
  }

  /** Cleanly disables all active plugins when the host player unmounts. */
  async destroy(): Promise<void> {
    const activeIds = Array.from(this.entries.values())
      .filter(entry => entry.record.status === 'active')
      .map(entry => entry.record.manifest.id);

    for (const id of activeIds) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      try {
        await entry.plugin.deactivate?.();
      } catch {
        // Ignore teardown failures on host destruction.
      }
      this.runDisposers(entry);
      entry.record.status = 'disabled';
    }
    this.changeListeners.clear();
  }

  private createContext(entry: ManagedPluginEntry): PluginContext {
    const manifest: Readonly<PluginManifest> = Object.freeze({
      ...entry.record.manifest,
      permissions: [...entry.record.manifest.permissions],
    });
    const pluginId = manifest.id;
    const permSet = new Set<PluginPermission>(manifest.permissions);

    const requirePerm = (perm: PluginPermission): void => {
      if (!permSet.has(perm)) {
        throw new PluginPermissionError(pluginId, perm);
      }
    };

    const track = (disposer: PluginDisposer): PluginDisposer => {
      let called = false;
      const wrapped: PluginDisposer = () => {
        if (called) return;
        called = true;
        entry.disposers.delete(wrapped);
        disposer();
      };
      entry.disposers.add(wrapped);
      return wrapped;
    };

    const playback: PluginPlaybackApi = {
      play: async () => {
        requirePerm('playback-control');
        await this.adapter.playback.play();
      },
      pause: async () => {
        requirePerm('playback-control');
        await this.adapter.playback.pause();
      },
      togglePlay: async () => {
        requirePerm('playback-control');
        await this.adapter.playback.togglePlay();
      },
      stop: async () => {
        requirePerm('playback-control');
        await this.adapter.playback.stop();
      },
      next: async () => {
        requirePerm('playback-control');
        await this.adapter.playback.next();
      },
      previous: async () => {
        requirePerm('playback-control');
        await this.adapter.playback.previous();
      },
      seek: async (seconds: number) => {
        requirePerm('playback-control');
        await this.adapter.playback.seek(seconds);
      },
      setVolume: async (volume: number) => {
        requirePerm('playback-control');
        await this.adapter.playback.setVolume(volume);
      },
      setPlaybackRate: async (rate: number) => {
        requirePerm('playback-control');
        await this.adapter.playback.setPlaybackRate?.(rate);
      },
      getPlaybackRate: () => this.adapter.playback.getPlaybackRate?.() ?? 1,
      getStatus: () => this.adapter.playback.getStatus(),
    };

    const playlist: PluginPlaylistApi = {
      addTracks: async (inputs, autoplayIfEmpty = false) => {
        requirePerm('playlist-write');
        return this.adapter.playlist.addTracks(inputs, autoplayIfEmpty);
      },
      removeTrack: async (id: string) => {
        requirePerm('playlist-write');
        await this.adapter.playlist.removeTrack(id);
      },
      clearPlaylist: async () => {
        requirePerm('playlist-write');
        await this.adapter.playlist.clearPlaylist();
      },
    };

    const storage = createScopedPluginStorage(pluginId, this.storageBackend, () => requirePerm('storage'));

    return {
      manifest,
      playerTarget: this.adapter.getPlayerTarget(),
      coreVersion: this.adapter.coreVersion,
      playback,
      playlist,
      storage,
      getState: () => this.adapter.getState(),
      on: <K extends keyof PluginEventMap>(event: K, listener: (payload: PluginEventMap[K]) => void): PluginDisposer => {
        const bucket = this.eventListeners[event];
        const token: PluginDisposer = () => {
          bucket.delete(token);
        };
        bucket.set(token, { pluginId, listener });
        return track(token);
      },
      updateTrackMetadata: async (trackId: string, patch: TrackMetadataPatch) => {
        requirePerm('track-metadata');
        return this.adapter.updateTrackMetadata(trackId, patch);
      },
      getAudioAnalyser: async () => {
        requirePerm('audio-analyser');
        return this.adapter.getAudioAnalyser();
      },
      getAudioContext: async () => {
        requirePerm('audio-context');
        return this.adapter.getAudioContext();
      },
      fetch: async (input: string | URL, init?: RequestInit) => {
        requirePerm('network');
        const impl = this.adapter.fetcher ?? fetch;
        return impl(input, init);
      },
      registerSlot: (slot: PluginSlotDescriptor): PluginDisposer => {
        requirePerm('ui-slot');
        const key = `${pluginId}:${slot.id}`;
        this.slots.set(key, { ...slot, pluginId, key });
        this.notifyChange();
        return track(() => {
          if (this.slots.delete(key)) {
            this.notifyChange();
          }
        });
      },
      registerTheme: (theme: PluginThemeDescriptor): PluginDisposer => {
        requirePerm('theme');
        const key = `${pluginId}:${theme.id}`;
        this.themes.set(key, { ...theme, pluginId });
        this.activeThemeKey = key;
        this.notifyChange();
        return track(() => {
          if (this.themes.delete(key)) {
            if (this.activeThemeKey === key) {
              this.activeThemeKey = null;
            }
            this.notifyChange();
          }
        });
      },
      registerProvider: <K extends PluginProviderKind>(kind: K, provider: PluginProviderTypeMap[K]): PluginDisposer => {
        const bucket = this.providers[kind];
        const key = `${pluginId}:${provider.id}`;
        bucket.set(key, { pluginId, provider });
        this.notifyChange();
        return track(() => {
          if (bucket.delete(key)) {
            this.notifyChange();
          }
        });
      },
      getProviders: <K extends PluginProviderKind>(kind: K): PluginProviderTypeMap[K][] => this.getProviders(kind),
      notify: (message, variant = '') => this.adapter.notify(message, variant),
    };
  }

  private runDisposers(entry: ManagedPluginEntry): void {
    for (const dispose of Array.from(entry.disposers)) {
      try {
        dispose();
      } catch {
        // Never allow a faulty disposer to leak remaining resources.
      }
    }
    entry.disposers.clear();
  }

  private async ensurePersistedRegistry(): Promise<PersistedPluginRegistry> {
    if (!this.persistedRegistry) {
      this.persistedRegistry = await loadPluginRegistry(this.storageBackend);
    }
    return this.persistedRegistry;
  }

  private notifyChange(): void {
    for (const listener of Array.from(this.changeListeners)) {
      try {
        listener();
      } catch {
        // Isolate host UI observer failures.
      }
    }
  }

  private cloneRecord(record: InstalledPluginRecord): InstalledPluginRecord {
    return {
      manifest: {
        ...record.manifest,
        permissions: [...record.manifest.permissions],
      },
      status: record.status,
      enabled: record.enabled,
      ...(record.lastError ? { lastError: record.lastError } : {}),
    };
  }
}
