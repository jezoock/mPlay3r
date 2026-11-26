import { DEFAULT_EQUALIZER_STATE, DEFAULT_PALETTE, EQ_FREQUENCIES, EQ_MAX_DB, EQ_MIN_DB, isValidPalette, STORAGE_KEY } from './constants';
import { clamp } from './format';
import type { PersistedState, RepeatMode } from './types';

const VALID_REPEATS: readonly RepeatMode[] = ['off', 'all', 'one'];

/** Pluggable persistence backend (localStorage on Web, portable/config JSON on Tauri Desktop in PR #6). */
export interface StorageAdapter {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

const defaultWebStorageAdapter: StorageAdapter = {
  async load() {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return localStorage.getItem(STORAGE_KEY);
  },
  async save(json: string) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, json);
    }
  },
};

let activeAdapter: StorageAdapter = defaultWebStorageAdapter;

export function setStorageAdapter(adapter: StorageAdapter): void {
  activeAdapter = adapter;
}

export function resetStorageAdapter(): void {
  activeAdapter = defaultWebStorageAdapter;
}

export function createDefaultPersistedState(): PersistedState {
  return {
    volume: 0.85,
    muted: false,
    balance: 0,
    shuffle: false,
    repeat: 'off',
    showRemaining: false,
    palette: DEFAULT_PALETTE,
    showEqualizer: false,
    showPlaylist: true,
    compact: false,
    equalizer: {
      ...DEFAULT_EQUALIZER_STATE,
      bands: [...DEFAULT_EQUALIZER_STATE.bands],
    },
  };
}

export function sanitizePersistedState(raw: unknown): PersistedState {
  const defaults = createDefaultPersistedState();
  if (!raw || typeof raw !== 'object') {
    return defaults;
  }
  const input = raw as Partial<PersistedState>;
  const eq = input.equalizer;
  const bands =
    eq && Array.isArray(eq.bands) && eq.bands.length === EQ_FREQUENCIES.length
      ? eq.bands.map(v => clamp(Number(v), EQ_MIN_DB, EQ_MAX_DB))
      : [...defaults.equalizer.bands];

  return {
    volume: typeof input.volume === 'number' ? clamp(input.volume, 0, 1) : defaults.volume,
    muted: typeof input.muted === 'boolean' ? input.muted : defaults.muted,
    balance: typeof input.balance === 'number' ? clamp(input.balance, -1, 1) : defaults.balance,
    shuffle: typeof input.shuffle === 'boolean' ? input.shuffle : defaults.shuffle,
    repeat: VALID_REPEATS.includes(input.repeat as RepeatMode) ? (input.repeat as RepeatMode) : defaults.repeat,
    showRemaining: typeof input.showRemaining === 'boolean' ? input.showRemaining : defaults.showRemaining,
    palette: isValidPalette(input.palette) ? input.palette : defaults.palette,
    showEqualizer: typeof input.showEqualizer === 'boolean' ? input.showEqualizer : defaults.showEqualizer,
    showPlaylist: typeof input.showPlaylist === 'boolean' ? input.showPlaylist : defaults.showPlaylist,
    compact: typeof input.compact === 'boolean' ? input.compact : defaults.compact,
    equalizer: {
      enabled: typeof eq?.enabled === 'boolean' ? eq.enabled : defaults.equalizer.enabled,
      preamp: typeof eq?.preamp === 'number' ? clamp(eq.preamp, EQ_MIN_DB, EQ_MAX_DB) : defaults.equalizer.preamp,
      bands,
      preset: typeof eq?.preset === 'string' && eq.preset ? eq.preset : defaults.equalizer.preset,
    },
    ...(Array.isArray(input.savedTracks)
      ? { savedTracks: input.savedTracks.filter(t => t && typeof t.src === 'string') }
      : {}),
  };
}

export async function loadPersistedState(adapter: StorageAdapter = activeAdapter): Promise<PersistedState> {
  try {
    const json = await adapter.load();
    if (json) {
      return sanitizePersistedState(JSON.parse(json));
    }
  } catch {
    // Ignore corrupted storage and fall back to defaults.
  }
  return createDefaultPersistedState();
}

export async function savePersistedState(state: PersistedState, adapter: StorageAdapter = activeAdapter): Promise<void> {
  try {
    await adapter.save(JSON.stringify(state));
  } catch {
    // Ignore storage quota or private-browsing failures.
  }
}
