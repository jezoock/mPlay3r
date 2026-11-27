import { Component, Element, Event, EventEmitter, h, Host, Listen, Method, Prop, State, Watch } from '@stencil/core';
import {
  AUDIO_FILE_ACCEPT,
  AudioEngine,
  DEFAULT_EQUALIZER_STATE,
  DEFAULT_PALETTE,
  extractLocalFileMetadata,
  isAudioFilename,
  isPlaylistFilename,
  isValidPalette,
  loadPersistedState,
  PALETTES,
  parsePlaylistContent,
  PLAYLIST_FILE_ACCEPT,
  PlaylistStore,
  resolveTracksInput,
  savePersistedState,
  serializeM3u,
} from '../../core';
import type {
  DesktopAppInfo,
  EqualizerState,
  PaletteId,
  PersistedState,
  PlatformBridge,
  PlaybackStatus,
  PlayerSnapshot,
  RepeatMode,
  Track,
  TrackInput,
} from '../../core';
import { getDefaultPlatformBridge } from '../../core/desktop-bridge';
import { PluginHost } from '../../plugins/host';
import type {
  InstalledPluginRecord,
  MPlay3rPlugin,
  PluginDisposer,
  RegisteredPluginSlot,
  RegisteredPluginTheme,
  TrackMetadataPatch,
} from '../../plugins/types';

const CORE_VERSION = '0.1.0';
let instanceCounter = 0;

interface ToasterRef extends HTMLElement {
  messages?: string | string[];
  mods?: string | string[];
  displayToast?: () => Promise<void>;
}

/**
 * Root mPlay3r web component (light DOM).
 *
 * Exposes all playback, playlist, equalizer, and palette controls as public `@Method()`s
 * so both the built-in minimalist UI and any external/Phase 2 theme can drive the player
 * declaratively with `<ds-trigger target="#mplay3r" action="play">`.
 *
 * Set `headless` to render no built-in UI and supply completely custom slotted markup.
 *
 * @slot - Custom UI markup (used in `headless` mode or for Phase 2 layout themes).
 */
@Component({
  tag: 'mplay3r-app',
  styleUrl: 'mplay3r-app.scss',
})
export class MPlay3rApp {
  @Element() host!: HTMLElement;

  /** Active minimalist color palette (`obsidian`, `slate`, `amber`, `emerald`, `sand`). */
  @Prop({ mutable: true, reflect: true }) palette: PaletteId = DEFAULT_PALETTE;
  /** Initial tracks: an array of TrackInput, a JSON string, or a URL to an `.m3u`/`.m3u8`/`.pls` file. */
  @Prop() tracks?: TrackInput[] | string;
  /** Enables compact Winamp-style windowshade layout. */
  @Prop({ mutable: true, reflect: true }) compact = false;
  /** Whether the 10-band equalizer drawer is open. */
  @Prop({ mutable: true, reflect: true }) showEqualizer = false;
  /** Whether the playlist drawer is open. */
  @Prop({ mutable: true, reflect: true }) showPlaylist = true;
  /** Whether the integrated Phase 2 Plugin Store drawer is open (lazy-loaded on demand). */
  @Prop({ mutable: true, reflect: true }) showStore = false;
  /** Optional custom JSON registry URLs for the Plugin Store (defaults to jezoock/mPlay3r-addons). */
  @Prop() storeRegistries?: string[];
  /** Persist volume, equalizer, palette, shuffle, and repeat in localStorage (or desktop portable storage). */
  @Prop() persist = true;
  /** Renders only slotted content so custom themes or external web apps can supply their own UI via `ds-trigger`. */
  @Prop({ reflect: true }) headless = false;
  /** Enables global Winamp keyboard shortcuts even when focus is outside the player (for standalone mode). */
  @Prop() globalShortcuts = false;
  /** Optional native desktop platform bridge (wired automatically by Tauri in PR #6). */
  @Prop() platform?: PlatformBridge;

  @State() status: PlaybackStatus = 'stopped';
  @State() trackList: Track[] = [];
  @State() currentIndex = -1;
  @State() currentTime = 0;
  @State() duration = 0;
  @State() buffered = 0;
  @State() volume = 0.85;
  @State() muted = false;
  @State() balance = 0;
  @State() playbackRate = 1;
  @State() shuffle = false;
  @State() repeat: RepeatMode = 'off';
  @State() showRemaining = false;
  @State() equalizer: EqualizerState = { ...DEFAULT_EQUALIZER_STATE, bands: [...DEFAULT_EQUALIZER_STATE.bands] };
  @State() filterQuery = '';
  @State() isDraggingFiles = false;
  @State() desktopInfo: DesktopAppInfo = { isDesktop: false, isPortable: false };
  @State() alwaysOnTop = false;
  @State() errorMessage = '';
  @State() pluginSlots: RegisteredPluginSlot[] = [];
  @State() activePluginPanelKey = '';
  @State() activePluginTheme: RegisteredPluginTheme | null = null;

  /** Emitted on any meaningful player state change. */
  @Event() mpStateChange!: EventEmitter<PlayerSnapshot>;
  /** Emitted when the active track changes. */
  @Event() mpTrackChange!: EventEmitter<{ track: Track | null; index: number }>;
  /** Emitted periodically during playback and seeks. */
  @Event() mpTimeUpdate!: EventEmitter<{ currentTime: number; duration: number; remaining: number }>;
  /** Emitted whenever tracks are added, removed, reordered, or cleared. */
  @Event() mpPlaylistChange!: EventEmitter<{ tracks: Track[]; currentIndex: number }>;
  /** Emitted whenever equalizer settings change. */
  @Event() mpEqChange!: EventEmitter<EqualizerState>;
  /** Emitted whenever the active color palette changes. */
  @Event() mpPaletteChange!: EventEmitter<{ palette: PaletteId }>;
  /** Emitted on playback or file-loading errors. */
  @Event() mpError!: EventEmitter<{ message: string }>;

  private playerId = '';
  private engine!: AudioEngine;
  private playlist!: PlaylistStore;
  private pluginHost!: PluginHost;
  private unsubscribePluginHost?: PluginDisposer;
  private mountedSlots = new Map<string, { el: HTMLElement; cleanup?: PluginDisposer }>();
  private mountedThemeRoot?: { id: string; el: HTMLElement; cleanup?: PluginDisposer };
  private fileInputEl?: HTMLInputElement;
  private folderInputEl?: HTMLInputElement;
  private playlistInputEl?: HTMLInputElement;
  private toasterEl?: ToasterRef;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private windowResizeObserver?: ResizeObserver;
  private resizeRafId?: number;
  private lastWindowSize = '';
  private dragDepth = 0;
  private paletteSetByAttribute = false;

  @Watch('palette')
  paletteWatcher(next: PaletteId) {
    if (!isValidPalette(next)) {
      this.palette = DEFAULT_PALETTE;
      return;
    }
    this.mpPaletteChange.emit({ palette: next });
    this.pluginHost?.emitPlayerEvent('paletteChange', { palette: next });
    this.schedulePersist();
  }

  @Watch('tracks')
  async tracksWatcher(next: TrackInput[] | string | undefined) {
    if (next !== undefined) {
      await this.loadTracksProp(next);
    }
  }

  async componentWillLoad() {
    // Guarantee a stable DOM id before children connect so every `<ds-trigger target="#...">` resolves immediately.
    if (!this.host.id) {
      instanceCounter += 1;
      this.host.id = `mplay3r-${instanceCounter}`;
    }
    this.playerId = this.host.id;
    this.paletteSetByAttribute = this.host.hasAttribute('palette');

    this.playlist = new PlaylistStore();
    this.engine = new AudioEngine({
      onStatusChange: status => {
        this.status = status;
        if (status !== 'error') {
          this.errorMessage = '';
        }
        this.updateMediaSessionState();
        this.emitState();
      },
      onTimeUpdate: ({ currentTime, duration, buffered }) => {
        this.currentTime = currentTime;
        this.duration = duration;
        this.buffered = buffered;
        const payload = {
          currentTime,
          duration,
          remaining: Math.max(0, duration - currentTime),
        };
        this.mpTimeUpdate.emit(payload);
        this.pluginHost?.emitPlayerEvent('timeUpdate', payload);
      },
      onDurationChange: duration => {
        this.duration = duration;
        const active = this.playlist.getCurrentTrack();
        if (active && (!active.duration || Math.abs(active.duration - duration) > 1)) {
          this.playlist.updateTrackMeta(active.id, { duration });
          this.syncPlaylistView();
        }
      },
      onEnded: () => {
        void this.handleTrackEnded();
      },
      onError: message => {
        this.errorMessage = message;
        this.mpError.emit({ message });
        this.pluginHost?.emitPlayerEvent('error', { message });
        void this.notify(message, 'error');
      },
    });

    this.pluginHost = new PluginHost({
      coreVersion: CORE_VERSION,
      getPlayerTarget: () => `#${this.playerId}`,
      getState: () => this.createSnapshot(),
      playback: {
        play: () => this.play(),
        pause: () => this.pause(),
        togglePlay: () => this.togglePlay(),
        stop: () => this.stop(),
        next: () => this.next(),
        previous: () => this.previous(),
        seek: seconds => this.seek(seconds),
        setVolume: volume => this.setVolume(volume),
        setPlaybackRate: rate => this.setPlaybackRate(rate),
        getPlaybackRate: () => this.playbackRate,
        getStatus: () => this.status,
      },
      playlist: {
        addTracks: (inputs, autoplayIfEmpty = false) => this.addTracks(inputs, autoplayIfEmpty),
        removeTrack: id => this.removeTrack(id),
        clearPlaylist: () => this.clearPlaylist(),
      },
      updateTrackMetadata: (trackId, patch) => this.updateTrackMetadata(trackId, patch),
      getAudioAnalyser: () => this.getAudioAnalyser(),
      getAudioContext: () => this.getAudioContext(),
      notify: (message, variant) => this.notify(message, variant),
    });
    this.unsubscribePluginHost = this.pluginHost.subscribe(() => this.syncPluginViews());

    if (this.persist) {
      await this.restorePersistedState();
    } else {
      this.engine.setVolume(this.volume);
      this.engine.setBalance(this.balance);
      this.engine.setPlaybackRate(this.playbackRate);
    }

    const bridge = this.getPlatform();
    if (bridge?.isDesktop()) {
      this.desktopInfo = await bridge.getAppInfo();
    }

    if (this.tracks !== undefined) {
      await this.loadTracksProp(this.tracks);
    }

    this.registerMediaSessionHandlers();
  }

  componentDidLoad() {
    const bridge = this.getPlatform();
    if (!this.desktopInfo.isDesktop || !bridge?.resizeWindowToContent || typeof ResizeObserver === 'undefined') {
      return;
    }
    const syncSize = () => {
      if (this.resizeRafId !== undefined) {
        cancelAnimationFrame(this.resizeRafId);
      }
      this.resizeRafId = requestAnimationFrame(() => {
        const rect = this.host.getBoundingClientRect();
        const width = Math.ceil(rect.width);
        const height = Math.ceil(rect.height);
        const key = `${width}x${height}`;
        if (width > 0 && height > 0 && key !== this.lastWindowSize) {
          this.lastWindowSize = key;
          void bridge.resizeWindowToContent?.(width, height);
        }
      });
    };
    this.windowResizeObserver = new ResizeObserver(syncSize);
    this.windowResizeObserver.observe(this.host);
    syncSize();
  }

  disconnectedCallback() {
    clearTimeout(this.persistTimer);
    if (this.resizeRafId !== undefined) {
      cancelAnimationFrame(this.resizeRafId);
    }
    this.windowResizeObserver?.disconnect();
    this.teardownAllSlots();
    this.unsubscribePluginHost?.();
    void this.pluginHost?.destroy();
    this.engine?.destroy();
    this.playlist?.clear();
  }

  //#region PUBLIC METHODS (CALLED BY ds-trigger AND JAVASCRIPT API)

  @Method()
  async play(): Promise<void> {
    const active = this.playlist.getCurrentTrack();
    if (!active) {
      await this.openFilePicker();
      return;
    }
    await this.engine.play(active.src);
    this.updateMediaSessionMetadata(active);
  }

  @Method()
  async pause(): Promise<void> {
    this.engine.pause();
  }

  @Method()
  async togglePlay(): Promise<void> {
    if (this.status === 'playing') {
      await this.pause();
    } else {
      await this.play();
    }
  }

  @Method()
  async stop(): Promise<void> {
    this.engine.stop();
    this.currentTime = 0;
  }

  @Method()
  async next(): Promise<void> {
    const result = this.playlist.next(false);
    await this.applyNavigation(result);
  }

  @Method()
  async previous(): Promise<void> {
    const result = this.playlist.previous(this.currentTime);
    await this.applyNavigation(result);
  }

  @Method()
  async seek(seconds: number): Promise<void> {
    this.currentTime = this.engine.seek(Number(seconds));
  }

  @Method()
  async seekRelative(deltaSeconds: number): Promise<void> {
    await this.seek(this.currentTime + Number(deltaSeconds));
  }

  @Method()
  async setVolume(volume: number): Promise<void> {
    this.volume = this.engine.setVolume(Number(volume));
    this.muted = this.engine.isMuted();
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async adjustVolume(delta: number): Promise<void> {
    await this.setVolume(this.volume + Number(delta));
  }

  @Method()
  async toggleMute(): Promise<void> {
    this.muted = this.engine.toggleMute();
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async setBalance(balance: number): Promise<void> {
    this.balance = this.engine.setBalance(Number(balance));
    this.schedulePersist();
    this.emitState();
  }

  /** Sets playback speed (`0.5×`–`2×`) with pitch preservation; invoked directly by Podcast/Broadcast plugins or `<ds-trigger>`. */
  @Method()
  async setPlaybackRate(rate: number): Promise<void> {
    this.playbackRate = this.engine.setPlaybackRate(Number(rate));
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async toggleShuffle(): Promise<void> {
    this.shuffle = this.playlist.toggleShuffle();
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async cycleRepeat(): Promise<void> {
    this.repeat = this.playlist.cycleRepeat();
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async setRepeat(mode: RepeatMode): Promise<void> {
    this.repeat = this.playlist.setRepeat(mode);
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async toggleTimeDisplay(): Promise<void> {
    this.showRemaining = !this.showRemaining;
    this.schedulePersist();
  }

  @Method()
  async playTrack(indexOrId: number | string): Promise<void> {
    const track = this.playlist.selectTrack(indexOrId);
    if (!track) {
      return;
    }
    this.syncPlaylistView();
    this.emitTrackChange(track, this.currentIndex);
    this.currentTime = 0;
    this.duration = track.duration ?? 0;
    await this.engine.play(track.src);
    this.updateMediaSessionMetadata(track);
  }

  @Method()
  async addTracks(inputs: TrackInput[], autoplayIfEmpty = false): Promise<Track[]> {
    const wasEmpty = this.playlist.getTracks().length === 0;
    const added = this.playlist.addTracks(inputs);
    if (added.length === 0) {
      return [];
    }
    this.syncPlaylistView();
    this.schedulePersist();
    if (wasEmpty) {
      const first = this.playlist.getCurrentTrack();
      if (first) {
        this.emitTrackChange(first, 0);
        if (autoplayIfEmpty) {
          await this.engine.play(first.src);
          this.updateMediaSessionMetadata(first);
        } else {
          this.engine.loadSource(first.src);
        }
      }
    }
    return added;
  }

  @Method()
  async addFiles(fileList: FileList | File[]): Promise<Track[]> {
    const files = Array.from(fileList);
    if (files.length === 0) {
      return [];
    }

    const audioInputs: TrackInput[] = [];
    for (const file of files) {
      if (isPlaylistFilename(file.name)) {
        const text = await file.text();
        const parsed = parsePlaylistContent(text, file.name);
        audioInputs.push(...parsed);
      } else if (isAudioFilename(file.name) || file.type.startsWith('audio/')) {
        const meta = await extractLocalFileMetadata(file);
        const url = URL.createObjectURL(file);
        audioInputs.push({
          src: url,
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          format: meta.format,
          isObjectUrl: true,
        });
      }
    }

    if (audioInputs.length === 0) {
      await this.notify('No supported audio files found.', 'warning');
      return [];
    }

    const added = await this.addTracks(audioInputs);
    await this.notify(added.length === 1 ? `Added "${added[0].title}"` : `Added ${added.length} tracks`, 'success');
    return added;
  }

  @Method()
  async openFilePicker(): Promise<void> {
    const bridge = this.getPlatform();
    if (bridge?.isDesktop()) {
      const files = await bridge.pickAudioFiles();
      if (files && files.length > 0) {
        const added = await this.addTracks(files.map(file => ({ src: file.url, filePath: file.path })));
        await this.notify(added.length === 1 ? `Added "${added[0].title}"` : `Added ${added.length} tracks`, 'success');
      }
      return;
    }
    this.fileInputEl?.click();
  }

  @Method()
  async openFolderPicker(): Promise<void> {
    const bridge = this.getPlatform();
    if (bridge?.isDesktop()) {
      const files = await bridge.pickAudioFolder();
      if (files && files.length > 0) {
        const added = await this.addTracks(files.map(file => ({ src: file.url, filePath: file.path })));
        await this.notify(`Added ${added.length} tracks from folder`, 'success');
      }
      return;
    }
    this.folderInputEl?.click();
  }

  @Method()
  async importPlaylistFile(): Promise<void> {
    const bridge = this.getPlatform();
    if (bridge?.isDesktop()) {
      const picked = await bridge.pickPlaylistFile();
      if (!picked) {
        return;
      }
      const parsed = parsePlaylistContent(picked.content, picked.name);
      const nativePaths = parsed.map(t => t.filePath).filter((p): p is string => Boolean(p));
      let tracksToAdd = parsed;
      if (nativePaths.length > 0) {
        const resolved = await bridge.resolveAudioPaths(nativePaths);
        const urlByPath = new Map((resolved ?? []).map(item => [item.path, item.url]));
        tracksToAdd = parsed.map(item => (item.filePath && urlByPath.has(item.filePath) ? { ...item, src: urlByPath.get(item.filePath)! } : item));
      }
      const added = await this.addTracks(tracksToAdd);
      await this.notify(`Imported ${added.length} tracks from ${picked.name}`, 'success');
      return;
    }
    this.playlistInputEl?.click();
  }

  @Method()
  async exportPlaylist(): Promise<void> {
    const tracks = this.playlist.getTracks();
    if (tracks.length === 0) {
      await this.notify('Playlist is empty.', 'warning');
      return;
    }
    const content = serializeM3u(tracks);
    const bridge = this.getPlatform();
    if (bridge?.isDesktop()) {
      const saved = await bridge.savePlaylistFile(content, 'mplay3r-playlist.m3u8');
      if (saved) {
        await this.notify('Playlist exported (.m3u8)', 'success');
      }
      return;
    }
    const blob = new Blob([content], { type: 'audio/x-mpegurl;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mplay3r-playlist.m3u8';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    await this.notify('Playlist exported (.m3u8)', 'success');
  }

  @Method()
  async removeTrack(id: string): Promise<void> {
    const wasPlaying = this.status === 'playing';
    const { removed, wasCurrent, nextTrack } = this.playlist.removeTrack(id);
    if (!removed) {
      return;
    }
    this.syncPlaylistView();
    this.schedulePersist();

    if (wasCurrent) {
      this.emitTrackChange(nextTrack, this.currentIndex);
      if (!nextTrack) {
        await this.stop();
        this.duration = 0;
      } else if (wasPlaying) {
        await this.engine.play(nextTrack.src);
        this.updateMediaSessionMetadata(nextTrack);
      } else {
        this.engine.loadSource(nextTrack.src);
      }
    }
  }

  @Method()
  async reorderTracks(ids: string[]): Promise<void> {
    if (this.playlist.reorderByIds(ids)) {
      this.syncPlaylistView();
      this.schedulePersist();
    }
  }

  @Method()
  async clearPlaylist(): Promise<void> {
    this.engine.stop();
    this.playlist.clear();
    this.currentTime = 0;
    this.duration = 0;
    this.filterQuery = '';
    this.syncPlaylistView();
    this.emitTrackChange(null, -1);
    this.schedulePersist();
  }

  @Method()
  async toggleEqualizerEnabled(): Promise<void> {
    await this.setEqualizerEnabled(!this.equalizer.enabled);
  }

  @Method()
  async setEqualizerEnabled(enabled: boolean): Promise<void> {
    this.equalizer = this.engine.setEqualizerEnabled(enabled);
    this.emitEqChange();
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async setEqBand(index: number, gain: number): Promise<void> {
    this.equalizer = this.engine.setEqBand(Number(index), Number(gain));
    this.emitEqChange();
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async setPreamp(gain: number): Promise<void> {
    this.equalizer = this.engine.setPreamp(Number(gain));
    this.emitEqChange();
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async applyEqPreset(presetId: string): Promise<void> {
    this.equalizer = this.engine.applyEqPreset(presetId);
    this.emitEqChange();
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async resetEqualizer(): Promise<void> {
    this.equalizer = this.engine.resetEqualizer();
    this.emitEqChange();
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async toggleEqualizer(): Promise<void> {
    this.showEqualizer = !this.showEqualizer;
    if (this.showEqualizer && this.compact) {
      this.compact = false;
    }
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async togglePlaylist(): Promise<void> {
    this.showPlaylist = !this.showPlaylist;
    if (this.showPlaylist && this.compact) {
      this.compact = false;
    }
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async toggleCompact(): Promise<void> {
    this.compact = !this.compact;
    this.schedulePersist();
    this.emitState();
  }

  @Method()
  async setPalette(palette: PaletteId): Promise<void> {
    if (isValidPalette(palette)) {
      this.palette = palette;
    }
  }

  @Method()
  async cyclePalette(): Promise<void> {
    const idx = PALETTES.findIndex(item => item.id === this.palette);
    const next = PALETTES[(idx + 1) % PALETTES.length];
    this.palette = next.id;
  }

  /** Returns an immutable snapshot of the current player state (for external apps & Phase 2 plugins/themes). */
  @Method()
  async getState(): Promise<PlayerSnapshot> {
    return this.createSnapshot();
  }

  /** Phase 2 extension hook: returns the live Web Audio AnalyserNode for visualizer plugins. */
  @Method()
  async getAudioAnalyser(): Promise<AnalyserNode | null> {
    return this.engine.getAnalyserNode();
  }

  /** Phase 2 extension hook: returns the Web Audio AudioContext for AudioWorklet / DSP plugins. */
  @Method()
  async getAudioContext(): Promise<AudioContext | null> {
    return this.engine.getAudioContext();
  }

  /** Returns the sandboxed Phase 2 PluginHost instance bound to this player. */
  @Method()
  async getPluginHost(): Promise<PluginHost> {
    return this.pluginHost;
  }

  /** Installs (and optionally activates) a plugin into this player's sandboxed PluginHost. */
  @Method()
  async registerPlugin(plugin: MPlay3rPlugin, enable?: boolean): Promise<InstalledPluginRecord> {
    return this.pluginHost.install(plugin, enable !== undefined ? { enable } : {});
  }

  /** Activates an installed plugin by id. */
  @Method()
  async enablePlugin(pluginId: string): Promise<InstalledPluginRecord> {
    return this.pluginHost.enable(pluginId);
  }

  /** Deactivates an active plugin by id and cleans up all its listeners, slots, themes, and providers. */
  @Method()
  async disablePlugin(pluginId: string): Promise<InstalledPluginRecord> {
    return this.pluginHost.disable(pluginId);
  }

  /** Uninstalls a plugin by id. */
  @Method()
  async uninstallPlugin(pluginId: string): Promise<boolean> {
    return this.pluginHost.uninstall(pluginId);
  }

  /** Toggles the lazy-loaded Plugin Store drawer (controllable via `<ds-trigger action="toggleStore">`). */
  @Method()
  async toggleStore(): Promise<void> {
    this.showStore = !this.showStore;
    if (this.showStore && this.compact) {
      this.compact = false;
    }
  }

  /** Toggles or switches the active plugin panel drawer (controllable via `<ds-trigger action="togglePluginPanel">`). */
  @Method()
  async togglePluginPanel(panelKeyOrPluginId?: string): Promise<void> {
    const panelSlots = this.pluginSlots.filter(s => s.slot === 'panel');
    if (panelSlots.length === 0) {
      this.activePluginPanelKey = '';
      return;
    }

    if (panelKeyOrPluginId) {
      const target = panelSlots.find(s => s.key === panelKeyOrPluginId || s.pluginId === panelKeyOrPluginId);
      if (!target) {
        return;
      }
      this.activePluginPanelKey = this.activePluginPanelKey === target.key ? '' : target.key;
    } else {
      this.activePluginPanelKey = this.activePluginPanelKey ? '' : panelSlots[0].key;
    }

    if (this.activePluginPanelKey && this.compact) {
      this.compact = false;
    }
  }

  /** Updates metadata of a track in the playlist (used by Radio ICY & Scraper plugins). */
  @Method()
  async updateTrackMetadata(trackId: string, patch: TrackMetadataPatch): Promise<boolean> {
    const existing = this.playlist.getTracks().find(t => t.id === trackId);
    if (!existing) {
      return false;
    }
    this.playlist.updateTrackMeta(trackId, patch);
    this.syncPlaylistView();
    const current = this.playlist.getCurrentTrack();
    if (current && current.id === trackId) {
      this.updateMediaSessionMetadata(current);
      this.emitTrackChange(current, this.currentIndex);
    }
    return true;
  }

  /** Initiates native OS window dragging when running in frameless Desktop mode. */
  @Method()
  async startWindowDrag(): Promise<void> {
    await this.getPlatform()?.startWindowDrag?.();
  }

  /** Minimizes the frameless Desktop player window. */
  @Method()
  async minimizeWindow(): Promise<void> {
    await this.getPlatform()?.minimizeWindow?.();
  }

  /** Closes the frameless Desktop player window. */
  @Method()
  async closeWindow(): Promise<void> {
    await this.getPlatform()?.closeWindow?.();
  }

  /** Toggles classic Winamp-style always-on-top pinning for the Desktop window. */
  @Method()
  async toggleAlwaysOnTop(): Promise<void> {
    const pinned = await this.getPlatform()?.toggleAlwaysOnTop?.();
    if (typeof pinned === 'boolean') {
      this.alwaysOnTop = pinned;
    }
  }

  //#endregion

  //#region KEYBOARD & DRAG-DROP HANDLERS

  @Listen('keydown', { target: 'window' })
  handleKeyDown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && (target.matches('input, textarea, select, [contenteditable="true"]') || target.closest('ds-select'))) {
      return;
    }
    if (!this.globalShortcuts && target && !this.host.contains(target)) {
      return;
    }

    const key = event.key.toLowerCase();
    // Classic Winamp keyboard bindings: Z=Prev, X=Play, C=Pause, V=Stop, B=Next, S=Shuffle, R=Repeat, M=Mute.
    switch (key) {
      case ' ':
        if (target?.matches('button, [role="button"], [role="switch"], [role="listitem"]')) {
          return;
        }
        event.preventDefault();
        void this.togglePlay();
        break;
      case 'z':
        event.preventDefault();
        void this.previous();
        break;
      case 'x':
        event.preventDefault();
        void this.play();
        break;
      case 'c':
        event.preventDefault();
        void this.togglePlay();
        break;
      case 'v':
        event.preventDefault();
        void this.stop();
        break;
      case 'b':
        event.preventDefault();
        void this.next();
        break;
      case 's':
        event.preventDefault();
        void this.toggleShuffle();
        break;
      case 'r':
        event.preventDefault();
        void this.cycleRepeat();
        break;
      case 'm':
        event.preventDefault();
        void this.toggleMute();
        break;
      case 'arrowleft':
        event.preventDefault();
        void this.seekRelative(-5);
        break;
      case 'arrowright':
        event.preventDefault();
        void this.seekRelative(5);
        break;
      case 'arrowup':
        event.preventDefault();
        void this.adjustVolume(0.05);
        break;
      case 'arrowdown':
        event.preventDefault();
        void this.adjustVolume(-0.05);
        break;
      default:
        break;
    }
  }

  private handleHostMouseDown = (event: MouseEvent) => {
    if (!this.desktopInfo.isDesktop || event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (!target || !target.closest('[data-tauri-drag-region]')) {
      return;
    }
    if (target.closest('button, input, select, textarea, a, ds-trigger, ds-range, ds-select, ds-toggle')) {
      return;
    }
    void this.startWindowDrag();
  };

  private handleDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer?.types?.includes('Files')) {
      return;
    }
    event.preventDefault();
    this.dragDepth += 1;
    this.isDraggingFiles = true;
  };

  private handleDragOver = (event: DragEvent) => {
    if (!event.dataTransfer?.types?.includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  private handleDragLeave = () => {
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.isDraggingFiles = false;
    }
  };

  private handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    this.dragDepth = 0;
    this.isDraggingFiles = false;
    if (event.dataTransfer?.files?.length) {
      await this.addFiles(event.dataTransfer.files);
    }
  };

  private handleFileInputChange = async (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) {
      await this.addFiles(input.files);
      input.value = '';
    }
  };

  //#endregion

  //#region INTERNAL HELPERS

  private async handleTrackEnded(): Promise<void> {
    const result = this.playlist.next(true);
    await this.applyNavigation(result);
  }

  private async applyNavigation(result: { action: string; track: Track | null; index: number }): Promise<void> {
    this.syncPlaylistView();
    if (result.action === 'restart' && result.track) {
      this.engine.seek(0);
      await this.engine.play(result.track.src);
      return;
    }
    if (result.action === 'play' && result.track) {
      this.emitTrackChange(result.track, result.index);
      this.currentTime = 0;
      this.duration = result.track.duration ?? 0;
      await this.engine.play(result.track.src);
      this.updateMediaSessionMetadata(result.track);
      return;
    }
    if (result.action === 'stop') {
      await this.stop();
    }
  }

  private async loadTracksProp(input: TrackInput[] | string): Promise<void> {
    const result = await resolveTracksInput(input);
    if (result.error === 'invalid-json') {
      console.error('[mplay3r] invalid JSON in tracks attribute');
      return;
    }
    if (result.error === 'fetch-failed') {
      await this.notify('Unable to load playlist URL.', 'error');
      return;
    }

    if (result.tracks.length > 0) {
      this.playlist.replaceTracks(result.tracks);
      this.syncPlaylistView();
      const first = this.playlist.getCurrentTrack();
      if (first) {
        this.engine.loadSource(first.src);
        this.emitTrackChange(first, 0);
      }
    }
  }

  private async restorePersistedState(): Promise<void> {
    const saved = await loadPersistedState();
    this.volume = this.engine.setVolume(saved.volume);
    this.muted = this.engine.setMuted(saved.muted);
    this.balance = this.engine.setBalance(saved.balance);
    this.playbackRate = this.engine.setPlaybackRate(saved.playbackRate ?? 1);
    this.shuffle = this.playlist.setShuffle(saved.shuffle);
    this.repeat = this.playlist.setRepeat(saved.repeat);
    this.showRemaining = saved.showRemaining;
    this.equalizer = this.engine.setEqualizerState(saved.equalizer);

    if (!this.paletteSetByAttribute) {
      this.palette = saved.palette;
    }
    if (!this.host.hasAttribute('show-equalizer')) {
      this.showEqualizer = saved.showEqualizer;
    }
    if (!this.host.hasAttribute('show-playlist')) {
      this.showPlaylist = saved.showPlaylist;
    }
    if (!this.host.hasAttribute('compact')) {
      this.compact = saved.compact;
    }

    if (this.tracks === undefined && saved.savedTracks?.length) {
      const bridge = this.getPlatform();
      if (bridge?.isDesktop()) {
        const nativePaths = saved.savedTracks.map(t => t.filePath).filter((p): p is string => Boolean(p));
        const resolved = await bridge.resolveAudioPaths(nativePaths);
        const urlByPath = new Map((resolved ?? []).map(item => [item.path, item.url]));
        const restored = saved.savedTracks
          .map(t => (t.filePath && urlByPath.has(t.filePath) ? { ...t, src: urlByPath.get(t.filePath)! } : t))
          .filter(t => !t.filePath || urlByPath.has(t.filePath));
        if (restored.length > 0) {
          this.playlist.addTracks(restored);
          this.syncPlaylistView();
        }
      } else {
        const remoteTracks = saved.savedTracks.filter(t => /^https?:/i.test(t.src));
        if (remoteTracks.length > 0) {
          this.playlist.addTracks(remoteTracks);
          this.syncPlaylistView();
        }
      }
    }
  }

  private getPlatform(): PlatformBridge | undefined {
    return this.platform ?? getDefaultPlatformBridge();
  }

  private schedulePersist(): void {
    if (!this.persist) {
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const savedTracks: TrackInput[] = this.playlist
        .getTracks()
        .filter(track => !track.isObjectUrl)
        .map(track => ({
          id: track.id,
          src: track.src,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
          format: track.format,
          filePath: track.filePath,
        }));

      const state: PersistedState = {
        volume: this.volume,
        muted: this.muted,
        balance: this.balance,
        playbackRate: this.playbackRate,
        shuffle: this.shuffle,
        repeat: this.repeat,
        showRemaining: this.showRemaining,
        palette: this.palette,
        showEqualizer: this.showEqualizer,
        showPlaylist: this.showPlaylist,
        compact: this.compact,
        equalizer: this.equalizer,
        savedTracks,
      };
      void savePersistedState(state);
    }, 200);
  }

  private syncPlaylistView(): void {
    this.trackList = this.playlist.getTracks();
    this.currentIndex = this.playlist.getCurrentIndex();
    const payload = { tracks: this.trackList, currentIndex: this.currentIndex };
    this.mpPlaylistChange.emit(payload);
    this.pluginHost?.emitPlayerEvent('playlistChange', payload);
    this.emitState();
  }

  private createSnapshot(): PlayerSnapshot {
    return {
      status: this.status,
      currentTrack: this.playlist.getCurrentTrack(),
      currentIndex: this.currentIndex,
      tracks: this.trackList,
      currentTime: this.currentTime,
      duration: this.duration,
      buffered: this.buffered,
      volume: this.volume,
      muted: this.muted,
      balance: this.balance,
      playbackRate: this.playbackRate,
      shuffle: this.shuffle,
      repeat: this.repeat,
      showRemaining: this.showRemaining,
      equalizer: this.equalizer,
      palette: this.palette,
      showEqualizer: this.showEqualizer,
      showPlaylist: this.showPlaylist,
      compact: this.compact,
      errorMessage: this.errorMessage || undefined,
    };
  }

  private emitState(): void {
    const snapshot = this.createSnapshot();
    this.mpStateChange.emit(snapshot);
    this.pluginHost?.emitPlayerEvent('stateChange', snapshot);
  }

  private emitTrackChange(track: Track | null, index: number): void {
    const payload = { track, index };
    this.mpTrackChange.emit(payload);
    this.pluginHost?.emitPlayerEvent('trackChange', payload);
  }

  private emitEqChange(): void {
    this.mpEqChange.emit(this.equalizer);
    this.pluginHost?.emitPlayerEvent('eqChange', this.equalizer);
  }

  private syncPluginViews(): void {
    const slots = this.pluginHost.getSlots();
    const activeKeys = new Set(slots.map(s => s.key));
    for (const [key, mounted] of Array.from(this.mountedSlots.entries())) {
      if (!activeKeys.has(key)) {
        try {
          mounted.cleanup?.();
        } catch {
          // Isolate plugin cleanup failures.
        }
        this.mountedSlots.delete(key);
      }
    }

    this.pluginSlots = slots;
    const panelSlots = slots.filter(s => s.slot === 'panel');
    if (this.activePluginPanelKey && !panelSlots.some(s => s.key === this.activePluginPanelKey)) {
      this.activePluginPanelKey = panelSlots[0]?.key ?? '';
    }

    const nextTheme = this.pluginHost.getActiveTheme();
    if (this.mountedThemeRoot && (!nextTheme || nextTheme.id !== this.mountedThemeRoot.id)) {
      try {
        this.mountedThemeRoot.cleanup?.();
      } catch {
        // Isolate theme teardown failures.
      }
      this.mountedThemeRoot = undefined;
    }
    this.activePluginTheme = nextTheme;
  }

  private bindSlotElement(slot: RegisteredPluginSlot, el: HTMLElement | undefined): void {
    const existing = this.mountedSlots.get(slot.key);
    if (!el) {
      if (existing) {
        try {
          existing.cleanup?.();
        } catch {
          // Isolate cleanup errors.
        }
        this.mountedSlots.delete(slot.key);
      }
      return;
    }
    if (existing && existing.el === el) {
      return;
    }
    if (existing) {
      try {
        existing.cleanup?.();
      } catch {
        // Isolate cleanup errors.
      }
    }
    const record: { el: HTMLElement; cleanup?: PluginDisposer } = { el };
    this.mountedSlots.set(slot.key, record);
    try {
      const maybeDisposer = slot.mount(el, `#${this.playerId}`);
      void Promise.resolve(maybeDisposer)
        .then(cleanup => {
          if (typeof cleanup === 'function') {
            if (this.mountedSlots.get(slot.key) === record) {
              record.cleanup = cleanup;
            } else {
              cleanup();
            }
          }
        })
        .catch(() => {
          // Isolate asynchronous slot mount failures.
        });
    } catch {
      // Isolate synchronous slot mount failures.
    }
  }

  private bindThemeRootElement(theme: RegisteredPluginTheme, el: HTMLElement | undefined): void {
    if (!el) {
      if (this.mountedThemeRoot) {
        try {
          this.mountedThemeRoot.cleanup?.();
        } catch {
          // Isolate cleanup errors.
        }
        this.mountedThemeRoot = undefined;
      }
      return;
    }
    if (this.mountedThemeRoot && this.mountedThemeRoot.id === theme.id && this.mountedThemeRoot.el === el) {
      return;
    }
    if (this.mountedThemeRoot) {
      try {
        this.mountedThemeRoot.cleanup?.();
      } catch {
        // Isolate cleanup errors.
      }
    }
    const record: { id: string; el: HTMLElement; cleanup?: PluginDisposer } = { id: theme.id, el };
    this.mountedThemeRoot = record;
    if (!theme.mountLayout) {
      return;
    }
    try {
      const maybeDisposer = theme.mountLayout(el, `#${this.playerId}`);
      void Promise.resolve(maybeDisposer)
        .then(cleanup => {
          if (typeof cleanup === 'function') {
            if (this.mountedThemeRoot === record) {
              record.cleanup = cleanup;
            } else {
              cleanup();
            }
          }
        })
        .catch(() => {
          // Isolate theme mount errors.
        });
    } catch {
      // Isolate theme mount errors.
    }
  }

  private teardownAllSlots(): void {
    for (const mounted of this.mountedSlots.values()) {
      try {
        mounted.cleanup?.();
      } catch {
        // Ignore teardown errors.
      }
    }
    this.mountedSlots.clear();
    if (this.mountedThemeRoot) {
      try {
        this.mountedThemeRoot.cleanup?.();
      } catch {
        // Ignore teardown errors.
      }
      this.mountedThemeRoot = undefined;
    }
  }

  private async notify(message: string, variant: '' | 'success' | 'warning' | 'error' = ''): Promise<void> {
    if (!this.toasterEl) {
      return;
    }
    this.toasterEl.mods = variant ? [variant] : [];
    this.toasterEl.messages = [message];
    await this.toasterEl.displayToast?.();
  }

  private registerMediaSessionHandlers(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => void this.play());
      ms.setActionHandler('pause', () => void this.pause());
      ms.setActionHandler('stop', () => void this.stop());
      ms.setActionHandler('previoustrack', () => void this.previous());
      ms.setActionHandler('nexttrack', () => void this.next());
      ms.setActionHandler('seekbackward', () => void this.seekRelative(-10));
      ms.setActionHandler('seekforward', () => void this.seekRelative(10));
    } catch {
      // Some WebViews do not support every MediaSession action.
    }
  }

  private updateMediaSessionMetadata(track: Track): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') {
      return;
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist || 'mPlay3r',
        album: track.album || '',
      });
    } catch {
      // Ignore MediaMetadata failures.
    }
  }

  private updateMediaSessionState(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    try {
      navigator.mediaSession.playbackState = this.status === 'playing' ? 'playing' : this.status === 'paused' ? 'paused' : 'none';
    } catch {
      // Ignore playbackState errors.
    }
  }

  //#endregion

  render() {
    const targetSelector = `#${this.playerId}`;
    const currentTrack = this.currentIndex >= 0 ? (this.trackList[this.currentIndex] ?? null) : null;
    const filteredTracks = this.playlist ? this.playlist.getFilteredTracks(this.filterQuery) : [];
    const visualizerSlots = this.pluginSlots.filter(s => s.slot === 'visualizer');
    const trackInfoSlots = this.pluginSlots.filter(s => s.slot === 'track-info');
    const panelSlots = this.pluginSlots.filter(s => s.slot === 'panel');
    const activePanel = panelSlots.find(s => s.key === this.activePluginPanelKey) ?? null;
    const activeTheme = this.activePluginTheme;
    const customThemeLayout = Boolean(activeTheme?.mountLayout);

    return (
      <Host
        class={{
          'mp-app': true,
          '--compact': this.compact,
          '--dragging': this.isDraggingFiles,
          '--frameless': this.desktopInfo.isDesktop,
          '--headless': this.headless || customThemeLayout,
          [`--status-${this.status}`]: true,
        }}
        data-mp-palette={this.palette}
        data-mp-status={this.status}
        onMouseDown={this.handleHostMouseDown}
        onDragEnter={this.handleDragEnter}
        onDragOver={this.handleDragOver}
        onDragLeave={this.handleDragLeave}
        onDrop={this.handleDrop}
      >
        {activeTheme?.css && <style data-mp-plugin-theme={activeTheme.id}>{activeTheme.css}</style>}

        {/* Hidden native file inputs for Web / Embed mode (Desktop uses PlatformBridge dialogs). */}
        <input
          class="ds-visually-hidden"
          type="file"
          multiple
          accept={AUDIO_FILE_ACCEPT}
          tabindex="-1"
          aria-hidden="true"
          ref={el => (this.fileInputEl = el as HTMLInputElement)}
          onChange={this.handleFileInputChange}
        />
        <input
          class="ds-visually-hidden"
          type="file"
          multiple
          tabindex="-1"
          aria-hidden="true"
          ref={el => {
            this.folderInputEl = el as HTMLInputElement;
            if (this.folderInputEl) {
              this.folderInputEl.setAttribute('webkitdirectory', '');
            }
          }}
          onChange={this.handleFileInputChange}
        />
        <input
          class="ds-visually-hidden"
          type="file"
          accept={PLAYLIST_FILE_ACCEPT}
          tabindex="-1"
          aria-hidden="true"
          ref={el => (this.playlistInputEl = el as HTMLInputElement)}
          onChange={this.handleFileInputChange}
        />

        {this.headless ? (
          <slot />
        ) : customThemeLayout && activeTheme ? (
          <div
            class="mp-slot --theme-root"
            key={`theme:${activeTheme.id}`}
            ref={el => this.bindThemeRootElement(activeTheme, el as HTMLElement | undefined)}
          />
        ) : (
          <div class="mp-app__shell" role="region" aria-label="mPlay3r audio player">
            <mp-header
              playerTarget={targetSelector}
              palette={this.palette}
              showEqualizer={this.showEqualizer}
              showPlaylist={this.showPlaylist}
              showStore={this.showStore}
              hasPluginPanels={panelSlots.length > 0}
              showPluginPanel={Boolean(activePanel)}
              compact={this.compact}
              isPortable={this.desktopInfo.isPortable}
              isDesktop={this.desktopInfo.isDesktop}
              alwaysOnTop={this.alwaysOnTop}
            />

            {!this.compact &&
              visualizerSlots.map(slot => (
                <div
                  class="mp-slot --visualizer"
                  key={slot.key}
                  data-mp-slot={slot.key}
                  ref={el => this.bindSlotElement(slot, el as HTMLElement | undefined)}
                />
              ))}

            <mp-transport
              playerTarget={targetSelector}
              status={this.status}
              track={currentTrack}
              trackIndex={this.currentIndex}
              trackCount={this.trackList.length}
              currentTime={this.currentTime}
              duration={this.duration}
              buffered={this.buffered}
              volume={this.volume}
              muted={this.muted}
              balance={this.balance}
              shuffle={this.shuffle}
              repeat={this.repeat}
              showRemaining={this.showRemaining}
              compact={this.compact}
              onMpSeek={event => void this.seek(event.detail)}
              onMpVolumeChange={event => void this.setVolume(event.detail)}
              onMpBalanceChange={event => void this.setBalance(event.detail)}
            />

            {!this.compact &&
              trackInfoSlots.map(slot => (
                <div
                  class="mp-slot --track-info"
                  key={slot.key}
                  data-mp-slot={slot.key}
                  ref={el => this.bindSlotElement(slot, el as HTMLElement | undefined)}
                />
              ))}

            {!this.compact && this.showStore && (
              <mp-store
                playerTarget={targetSelector}
                pluginHost={this.pluginHost}
                registries={this.storeRegistries}
                coreVersion={CORE_VERSION}
                onMpStoreNotify={event => void this.notify(event.detail.message, event.detail.variant)}
              />
            )}

            {!this.compact && activePanel && (
              <div class="mp-plugin-drawer" role="region" aria-label={activePanel.title || 'Plugin panel'}>
                {panelSlots.length > 1 && (
                  <div class="mp-plugin-drawer__tabs" role="tablist">
                    {panelSlots.map(slot => {
                      const selected = slot.key === activePanel.key;
                      return (
                        <ds-trigger
                          key={slot.key}
                          mods={selected ? 'mp-pill,active' : 'mp-pill'}
                          target={targetSelector}
                          action={`togglePluginPanel:${JSON.stringify([slot.key])}`}
                          label={slot.title || slot.id}
                          aria-pressed={selected ? 'true' : 'false'}
                        >
                          <span>{slot.title || slot.id}</span>
                        </ds-trigger>
                      );
                    })}
                  </div>
                )}
                <div
                  class="mp-slot --panel"
                  key={activePanel.key}
                  data-mp-slot={activePanel.key}
                  ref={el => this.bindSlotElement(activePanel, el as HTMLElement | undefined)}
                />
              </div>
            )}

            {!this.compact && this.showEqualizer && (
              <mp-equalizer
                playerTarget={targetSelector}
                equalizer={this.equalizer}
                onMpEqToggle={event => void this.setEqualizerEnabled(event.detail)}
                onMpPreampChange={event => void this.setPreamp(event.detail)}
                onMpBandChange={event => void this.setEqBand(event.detail.index, event.detail.gain)}
                onMpPresetChange={event => void this.applyEqPreset(event.detail)}
              />
            )}

            {!this.compact && this.showPlaylist && (
              <mp-playlist
                playerTarget={targetSelector}
                tracks={filteredTracks}
                totalCount={this.trackList.length}
                currentTrackId={currentTrack?.id}
                status={this.status}
                filterQuery={this.filterQuery}
                onMpFilterChange={event => (this.filterQuery = event.detail)}
                onMpReorder={event => void this.reorderTracks(event.detail)}
              />
            )}

            {this.isDraggingFiles && (
              <div class="mp-app__drop-overlay" aria-hidden="true">
                <ds-icon type="upload" />
                <span>Drop audio files or M3U / PLS playlists</span>
              </div>
            )}
          </div>
        )}

        <ds-toaster
          position="bottom,right"
          closingDelay={2600}
          maxDisplayedToast={2}
          ref={el => (this.toasterEl = el as unknown as ToasterRef)}
        />
      </Host>
    );
  }
}
