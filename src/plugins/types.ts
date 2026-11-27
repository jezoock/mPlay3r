import type { EqualizerState, PaletteId, PlaybackStatus, PlayerSnapshot, Track, TrackInput } from '../core/types';

/** The 6 supported Phase 2 plugin categories. */
export type PluginCategory = 'source' | 'broadcast' | 'visualizer' | 'scraper' | 'dsp' | 'theme';

/** Least-privilege declarative permissions requested in a plugin manifest. */
export type PluginPermission =
  | 'playback-control'
  | 'playlist-write'
  | 'track-metadata'
  | 'audio-analyser'
  | 'audio-context'
  | 'network'
  | 'local-server'
  | 'ui-slot'
  | 'theme'
  | 'storage';

/** Named UI mount points inside `<mplay3r-app>`. */
export type PluginSlotName = 'panel' | 'visualizer' | 'track-info' | 'theme-root';

/** Runtime target constraint for plugins that require desktop-only APIs (e.g. LAN HTTP server). */
export type PluginRuntimeTarget = 'all' | 'desktop' | 'web';

/** Declarative plugin metadata (also used by the Phase 2 JSON Store registry). */
export interface PluginManifest {
  /** Unique identifier in lowercase kebab/dot notation (e.g. `mplay3r.radio`, `radio-freebox`). */
  id: string;
  name: string;
  /** Semantic version (`major.minor.patch`). */
  version: string;
  description: string;
  category: PluginCategory;
  permissions: PluginPermission[];
  /** Minimum compatible mPlay3r core semver (e.g. `0.1.0`). */
  minCoreVersion?: string;
  author?: string;
  homepage?: string;
  /** Entry ESM module path or URL (used by the integrated Store). */
  entry?: string;
  /** Expected lowercase SHA-256 hex digest of the entry bundle (verified by the Store). */
  sha256?: string;
  /** Approximate bundle weight in bytes (shown in the Store). */
  sizeBytes?: number;
  runtime?: PluginRuntimeTarget;
}

export type PluginLifecycleStatus = 'installed' | 'active' | 'disabled' | 'error';

export interface InstalledPluginRecord {
  manifest: PluginManifest;
  status: PluginLifecycleStatus;
  enabled: boolean;
  lastError?: string;
}

/** Disposer function returned by subscriptions and registrations. */
export type PluginDisposer = () => void;

/** Event payloads dispatched by `<mplay3r-app>` to active plugins. */
export interface PluginEventMap {
  stateChange: PlayerSnapshot;
  trackChange: { track: Track | null; index: number };
  timeUpdate: { currentTime: number; duration: number; remaining: number };
  playlistChange: { tracks: Track[]; currentIndex: number };
  eqChange: EqualizerState;
  paletteChange: { palette: PaletteId };
  error: { message: string };
}

export type TrackMetadataPatch = Partial<Pick<Track, 'title' | 'artist' | 'album' | 'duration' | 'format'>>;

/** Scoped key-value storage isolated per plugin id. */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** UI mount registration for a named slot in `<mplay3r-app>`. */
export interface PluginSlotDescriptor {
  /** Unique slot mount id within the plugin. */
  id: string;
  slot: Exclude<PluginSlotName, 'theme-root'>;
  title?: string;
  icon?: string;
  /**
   * Mounts plugin DOM inside `container`. Receives `playerTarget` (`#mplay3r`) so plugin
   * UI controls can declaratively invoke `<mplay3r-app>` actions via `<ds-trigger>`.
   * May return a cleanup function invoked when unmounted or deactivated.
   */
  mount(container: HTMLElement, playerTarget: string): void | PluginDisposer | Promise<void | PluginDisposer>;
}

export interface RegisteredPluginSlot extends PluginSlotDescriptor {
  pluginId: string;
  key: string;
}

/** Custom theme / full-layout registration (`theme` permission). */
export interface PluginThemeDescriptor {
  id: string;
  name: string;
  /** Optional scoped stylesheet injected while this theme is active. */
  css?: string;
  /** Optional full-layout renderer mounted instead of the default minimalist UI (e.g. Winamp `.wsz`). */
  mountLayout?(container: HTMLElement, playerTarget: string): void | PluginDisposer | Promise<void | PluginDisposer>;
}

export interface RegisteredPluginTheme extends PluginThemeDescriptor {
  pluginId: string;
}

/** Extensible contract for Phase 2 Radio plugins & per-ISP-box micro-plugins (Freebox, Bbox, Livebox, SFR). */
export interface RadioStation {
  id: string;
  name: string;
  streamUrl: string;
  country?: string;
  genre?: string;
  bitrate?: number;
  codec?: string;
  homepage?: string;
  favicon?: string;
  providerId: string;
  isLive?: boolean;
}

export interface RadioProvider {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  searchStations(query: string, options?: { country?: string; genre?: string; limit?: number }): Promise<RadioStation[]>;
  listFeatured?(): Promise<RadioStation[]>;
}

/** Extensible contract for Phase 2 Podcast & open streaming platform connectors. */
export interface MediaItem {
  id: string;
  title: string;
  streamUrl: string;
  artist?: string;
  album?: string;
  duration?: number;
  publishedAt?: string;
  description?: string;
  artworkUrl?: string;
  providerId: string;
}

export interface MediaSourceProvider {
  readonly id: string;
  readonly name: string;
  search(query: string, options?: { limit?: number }): Promise<MediaItem[]>;
  resolveUrl?(url: string): Promise<MediaItem[]>;
}

export type PluginProviderKind = 'radio' | 'media-source';

export interface PluginProviderTypeMap {
  radio: RadioProvider;
  'media-source': MediaSourceProvider;
}

/** Permission-gated playback controls exposed to plugins with `playback-control`. */
export interface PluginPlaybackApi {
  play(): Promise<void>;
  pause(): Promise<void>;
  togglePlay(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setPlaybackRate?(rate: number): Promise<void>;
  getPlaybackRate?(): number;
  getStatus(): PlaybackStatus;
}

/** Permission-gated playlist controls exposed to plugins with `playlist-write`. */
export interface PluginPlaylistApi {
  addTracks(inputs: TrackInput[], autoplayIfEmpty?: boolean): Promise<Track[]>;
  removeTrack(id: string): Promise<void>;
  clearPlaylist(): Promise<void>;
}

/** Capability-gated context provided to each plugin during `activate(ctx)`. */
export interface PluginContext {
  readonly manifest: Readonly<PluginManifest>;
  readonly playerTarget: string;
  readonly coreVersion: string;
  readonly playback: PluginPlaybackApi;
  readonly playlist: PluginPlaylistApi;
  readonly storage: PluginStorage;

  getState(): PlayerSnapshot;
  on<K extends keyof PluginEventMap>(event: K, listener: (payload: PluginEventMap[K]) => void): PluginDisposer;
  updateTrackMetadata(trackId: string, patch: TrackMetadataPatch): Promise<boolean>;
  getAudioAnalyser(): Promise<AnalyserNode | null>;
  getAudioContext(): Promise<AudioContext | null>;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  registerSlot(slot: PluginSlotDescriptor): PluginDisposer;
  registerTheme(theme: PluginThemeDescriptor): PluginDisposer;
  registerProvider<K extends PluginProviderKind>(kind: K, provider: PluginProviderTypeMap[K]): PluginDisposer;
  getProviders<K extends PluginProviderKind>(kind: K): PluginProviderTypeMap[K][];
  notify(message: string, variant?: '' | 'success' | 'warning' | 'error'): Promise<void>;
}

/** Standard entry-point contract implemented by every mPlay3r plugin. */
export interface MPlay3rPlugin {
  readonly manifest: PluginManifest;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Host adapter implemented by `<mplay3r-app>` (or mocked in unit tests). */
export interface PluginHostAdapter {
  readonly coreVersion: string;
  getPlayerTarget(): string;
  getState(): PlayerSnapshot;
  playback: PluginPlaybackApi;
  playlist: PluginPlaylistApi;
  updateTrackMetadata(trackId: string, patch: TrackMetadataPatch): Promise<boolean>;
  getAudioAnalyser(): Promise<AnalyserNode | null>;
  getAudioContext(): Promise<AudioContext | null>;
  notify(message: string, variant?: '' | 'success' | 'warning' | 'error'): Promise<void>;
  fetcher?: typeof fetch;
}

export class PluginPermissionError extends Error {
  readonly pluginId: string;
  readonly permission: PluginPermission;

  constructor(pluginId: string, permission: PluginPermission) {
    super(`Plugin "${pluginId}" attempted an operation requiring undeclared permission "${permission}".`);
    this.name = 'PluginPermissionError';
    this.pluginId = pluginId;
    this.permission = permission;
  }
}

export class PluginValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid plugin manifest: ${errors.join('; ')}`);
    this.name = 'PluginValidationError';
    this.errors = errors;
  }
}
