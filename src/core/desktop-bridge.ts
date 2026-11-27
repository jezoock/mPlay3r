import { resetStorageAdapter, setStorageAdapter } from './storage';
import type { StorageAdapter } from './storage';
import type {
  AudioTagPatch,
  DesktopAppInfo,
  DesktopAudioFile,
  LanShareServerConfig,
  LanShareServerStatus,
  PlatformBridge,
  WriteAudioTagsResult,
} from './types';

interface TauriInternals {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

let defaultPlatformBridge: PlatformBridge | undefined;

function getTauriInternals(): TauriInternals | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return internals && typeof internals.invoke === 'function' ? internals : null;
}

/** True when running inside the Tauri v2 desktop container (portable or installed). */
export function isDesktopRuntime(): boolean {
  return getTauriInternals() !== null;
}

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const internals = getTauriInternals();
  if (!internals) {
    return null;
  }
  return internals.invoke<T>(cmd, args);
}

export async function getDesktopAppInfo(): Promise<DesktopAppInfo> {
  const info = await invokeTauri<DesktopAppInfo>('get_app_info');
  return info ?? { isDesktop: false, isPortable: false };
}

/** Opens the native OS file picker for audio files and returns authorized `mplay3r://` stream URLs. */
export async function pickDesktopAudioFiles(): Promise<DesktopAudioFile[] | null> {
  return invokeTauri<DesktopAudioFile[]>('pick_audio_files');
}

/** Opens the native OS folder picker and recursively scans for supported audio files. */
export async function pickDesktopAudioFolder(): Promise<DesktopAudioFile[] | null> {
  return invokeTauri<DesktopAudioFile[]>('pick_audio_folder');
}

/** Re-authorizes saved native file paths (e.g. restored from portable settings or an M3U playlist). */
export async function resolveDesktopAudioPaths(paths: string[]): Promise<DesktopAudioFile[] | null> {
  if (paths.length === 0) {
    return [];
  }
  return invokeTauri<DesktopAudioFile[]>('resolve_audio_paths', { paths });
}

/** Opens native dialog to pick an M3U/M3U8/PLS file and returns its filename & UTF-8 contents. */
export async function pickDesktopPlaylistFile(): Promise<{ name: string; content: string } | null> {
  return invokeTauri<{ name: string; content: string } | null>('pick_playlist_file');
}

/** Saves an M3U8 playlist string through the native OS save dialog. */
export async function saveDesktopPlaylistFile(content: string, defaultName = 'playlist.m3u8'): Promise<boolean> {
  const saved = await invokeTauri<boolean>('save_playlist_file', { content, defaultName });
  return Boolean(saved);
}

/** Loads persisted JSON state from portable `./data/` or OS config dir on Desktop. */
export async function loadDesktopStateJson(): Promise<string | null> {
  return invokeTauri<string | null>('load_persisted_state');
}

/** Writes persisted JSON state to portable `./data/` or OS config dir on Desktop. */
export async function saveDesktopStateJson(json: string): Promise<boolean> {
  const saved = await invokeTauri<boolean>('save_persisted_state', { json });
  return Boolean(saved);
}

/** Starts the embedded native Rust LAN Share & SSE Listening Party server on Desktop. */
export async function startLanShareServer(config: LanShareServerConfig): Promise<LanShareServerStatus | null> {
  return invokeTauri<LanShareServerStatus>('start_lan_share_server', { config });
}

/** Stops the embedded native Rust LAN Share server if running. */
export async function stopLanShareServer(): Promise<boolean> {
  const stopped = await invokeTauri<boolean>('stop_lan_share_server');
  return Boolean(stopped);
}

/** Queries the current running state, LAN URL, and library counts of the native LAN Share server. */
export async function getLanShareStatus(): Promise<LanShareServerStatus | null> {
  return invokeTauri<LanShareServerStatus>('get_lan_share_status');
}

/** Writes ID3v2.3 text tags (TIT2/TPE1/TALB) atomically to an explicitly authorized local MP3 file. */
export async function writeDesktopAudioTags(
  filePath: string,
  tags: AudioTagPatch,
): Promise<WriteAudioTagsResult | null> {
  return invokeTauri<WriteAudioTagsResult>('write_audio_tags', { path: filePath, tags });
}

/** Creates a `PlatformBridge` backed by Tauri v2 IPC commands. */
export function createTauriPlatformBridge(): PlatformBridge {
  return {
    isDesktop: isDesktopRuntime,
    getAppInfo: getDesktopAppInfo,
    pickAudioFiles: pickDesktopAudioFiles,
    pickAudioFolder: pickDesktopAudioFolder,
    resolveAudioPaths: resolveDesktopAudioPaths,
    pickPlaylistFile: pickDesktopPlaylistFile,
    savePlaylistFile: saveDesktopPlaylistFile,
    startLanShareServer,
    stopLanShareServer,
    getLanShareStatus,
    writeAudioTags: writeDesktopAudioTags,
  };
}

/** Creates a `StorageAdapter` persisting JSON state in Tauri's portable `./data/` or OS config directory. */
export function createTauriStorageAdapter(): StorageAdapter {
  return {
    load: loadDesktopStateJson,
    async save(json: string) {
      await saveDesktopStateJson(json);
    },
  };
}

export function getDefaultPlatformBridge(): PlatformBridge | undefined {
  return defaultPlatformBridge;
}

export function setDefaultPlatformBridge(bridge: PlatformBridge | undefined): void {
  defaultPlatformBridge = bridge;
}

/**
 * Wires Tauri's native storage and platform bridge when running inside the desktop shell.
 * Returns `true` if Tauri was detected and initialized, `false` in Web / Embed runtimes.
 */
export function initDesktopRuntime(): boolean {
  if (!isDesktopRuntime()) {
    return false;
  }
  setStorageAdapter(createTauriStorageAdapter());
  setDefaultPlatformBridge(createTauriPlatformBridge());
  return true;
}

/** Resets runtime desktop wiring (primarily for unit tests). */
export function resetDesktopRuntime(): void {
  defaultPlatformBridge = undefined;
  resetStorageAdapter();
}
