import type { PluginStorage } from './types';

const STORAGE_PREFIX = 'mplay3r.plugins.v1.';
const REGISTRY_KEY = 'registry';

/** Pluggable persistence backend for plugin state and per-plugin scoped storage. */
export interface PluginStorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
}

/** In-memory storage backend (for headless environments, SSR, and deterministic unit tests). */
export function createMemoryPluginStorage(): PluginStorageBackend {
  const store = new Map<string, string>();
  return {
    async getItem(key) {
      return store.get(key) ?? null;
    },
    async setItem(key, value) {
      store.set(key, value);
    },
    async removeItem(key) {
      store.delete(key);
    },
    async listKeys(prefix) {
      return Array.from(store.keys()).filter(k => k.startsWith(prefix));
    },
  };
}

/** Default browser localStorage backend with graceful fallback to memory when unavailable. */
export function createDefaultPluginStorage(): PluginStorageBackend {
  const memoryFallback = createMemoryPluginStorage();
  const hasLocalStorage = (): boolean => {
    try {
      return typeof localStorage !== 'undefined' && localStorage !== null;
    } catch {
      return false;
    }
  };

  return {
    async getItem(key) {
      if (!hasLocalStorage()) {
        return memoryFallback.getItem(key);
      }
      try {
        return localStorage.getItem(`${STORAGE_PREFIX}${key}`);
      } catch {
        return memoryFallback.getItem(key);
      }
    },
    async setItem(key, value) {
      if (!hasLocalStorage()) {
        return memoryFallback.setItem(key, value);
      }
      try {
        localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
      } catch {
        await memoryFallback.setItem(key, value);
      }
    },
    async removeItem(key) {
      if (!hasLocalStorage()) {
        return memoryFallback.removeItem(key);
      }
      try {
        localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
      } catch {
        await memoryFallback.removeItem(key);
      }
    },
    async listKeys(prefix) {
      if (!hasLocalStorage()) {
        return memoryFallback.listKeys(prefix);
      }
      const fullPrefix = `${STORAGE_PREFIX}${prefix}`;
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(fullPrefix)) {
          keys.push(key.slice(STORAGE_PREFIX.length));
        }
      }
      return keys;
    },
  };
}

export interface PersistedPluginEntry {
  enabled: boolean;
  version: string;
}

export type PersistedPluginRegistry = Record<string, PersistedPluginEntry>;

export async function loadPluginRegistry(backend: PluginStorageBackend): Promise<PersistedPluginRegistry> {
  try {
    const raw = await backend.getItem(REGISTRY_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: PersistedPluginRegistry = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && typeof (entry as PersistedPluginEntry).enabled === 'boolean') {
        result[id] = {
          enabled: (entry as PersistedPluginEntry).enabled,
          version: typeof (entry as PersistedPluginEntry).version === 'string' ? (entry as PersistedPluginEntry).version : '0.0.0',
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function savePluginRegistry(backend: PluginStorageBackend, registry: PersistedPluginRegistry): Promise<void> {
  try {
    await backend.setItem(REGISTRY_KEY, JSON.stringify(registry));
  } catch {
    // Ignore storage quota errors cleanly.
  }
}

/** Creates a strictly namespaced storage view for a single plugin (`data:<pluginId>:<key>`). */
export function createScopedPluginStorage(
  pluginId: string,
  backend: PluginStorageBackend,
  assertPermission: () => void,
): PluginStorage {
  const prefix = `data:${pluginId}:`;
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      assertPermission();
      const raw = await backend.getItem(`${prefix}${key}`);
      if (raw === null) {
        return null;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      assertPermission();
      await backend.setItem(`${prefix}${key}`, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      assertPermission();
      await backend.removeItem(`${prefix}${key}`);
    },
    async clear(): Promise<void> {
      assertPermission();
      const keys = await backend.listKeys(prefix);
      await Promise.all(keys.map(k => backend.removeItem(k)));
    },
  };
}
