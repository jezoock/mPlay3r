export type PlaybackStatus = 'stopped' | 'playing' | 'paused' | 'loading' | 'error';

export type RepeatMode = 'off' | 'all' | 'one';

export type PaletteId = 'obsidian' | 'slate' | 'amber' | 'emerald' | 'sand';

export interface Track {
  id: string;
  src: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  format?: string;
  /** Native filesystem path when running in the Tauri desktop shell. */
  filePath?: string;
  /** True when `src` was created with URL.createObjectURL and should be revoked on cleanup. */
  isObjectUrl?: boolean;
}

export interface TrackInput {
  id?: string;
  src: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  format?: string;
  filePath?: string;
  isObjectUrl?: boolean;
}

export interface EqualizerState {
  enabled: boolean;
  /** Preamp gain in dB (-12 to +12). */
  preamp: number;
  /** 10-band Winamp gains in dB (-12 to +12). */
  bands: number[];
  /** Active preset id, or 'custom' when manually adjusted. */
  preset: string;
}

export interface EqualizerPreset {
  id: string;
  name: string;
  preamp: number;
  bands: readonly number[];
}

export interface PaletteDefinition {
  id: PaletteId;
  name: string;
  swatch: string;
  accent: string;
  dark: boolean;
}

export interface PlayerSnapshot {
  status: PlaybackStatus;
  currentTrack: Track | null;
  currentIndex: number;
  tracks: Track[];
  currentTime: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  balance: number;
  playbackRate?: number;
  shuffle: boolean;
  repeat: RepeatMode;
  showRemaining: boolean;
  equalizer: EqualizerState;
  palette: PaletteId;
  showEqualizer: boolean;
  showPlaylist: boolean;
  compact: boolean;
  errorMessage?: string;
}

export interface PersistedState {
  volume: number;
  muted: boolean;
  balance: number;
  playbackRate?: number;
  shuffle: boolean;
  repeat: RepeatMode;
  showRemaining: boolean;
  palette: PaletteId;
  showEqualizer: boolean;
  showPlaylist: boolean;
  compact: boolean;
  equalizer: EqualizerState;
  /** Saved non-blob track references (e.g. desktop file paths or remote URLs). */
  savedTracks?: TrackInput[];
}

export interface DesktopAppInfo {
  isDesktop: boolean;
  isPortable: boolean;
  dataDir?: string;
  version?: string;
}

export interface DesktopAudioFile {
  path: string;
  url: string;
  name: string;
}

export interface LanShareServerConfig {
  serverName: string;
  port: number;
  bindAddress: string;
  sharedFolders: string[];
  pin: string;
  bearerToken: string;
}

export interface LanShareServerStatus {
  running: boolean;
  url?: string;
  serverName?: string;
  port?: number;
  folderCount?: number;
  trackCount?: number;
}

export interface AudioTagPatch {
  title?: string;
  artist?: string;
  album?: string;
}

export interface WriteAudioTagsResult {
  path: string;
  updatedFrames: string[];
  bytesWritten: number;
}

/** Optional native desktop platform bridge (implemented by Tauri v2 in PR #6 / PR #18; omitted on Web/Embed). */
export interface PlatformBridge {
  isDesktop(): boolean;
  getAppInfo(): Promise<DesktopAppInfo>;
  pickAudioFiles(): Promise<DesktopAudioFile[] | null>;
  pickAudioFolder(): Promise<DesktopAudioFile[] | null>;
  resolveAudioPaths(paths: string[]): Promise<DesktopAudioFile[] | null>;
  pickPlaylistFile(): Promise<{ name: string; content: string } | null>;
  savePlaylistFile(content: string, defaultName?: string): Promise<boolean>;
  startLanShareServer?(config: LanShareServerConfig): Promise<LanShareServerStatus | null>;
  stopLanShareServer?(): Promise<boolean>;
  getLanShareStatus?(): Promise<LanShareServerStatus | null>;
  writeAudioTags?(filePath: string, tags: AudioTagPatch): Promise<WriteAudioTagsResult | null>;
}
