import type { PluginCategory, PluginManifest } from './types';
import { validatePluginManifest } from './validation';

/** Default official community addons registry hosted on jezoock/mPlay3r-addons. */
export const DEFAULT_PLUGIN_REGISTRY_URL =
  'https://raw.githubusercontent.com/jezoock/mPlay3r-addons/main/registry.json';

export interface PluginRegistryDocument {
  schemaVersion: 1;
  name: string;
  updatedAt?: string;
  plugins: PluginManifest[];
}

export interface ParsedRegistryResult {
  valid: boolean;
  registry?: PluginRegistryDocument;
  errors: string[];
}

export interface StoreCatalogItem {
  manifest: PluginManifest;
  registryUrl: string;
  registryName: string;
  resolvedEntryUrl: string;
  compatible: boolean;
  installedVersion?: string;
  updateAvailable: boolean;
  status: 'available' | 'active' | 'disabled' | 'error';
}

export interface StoreCatalogFilter {
  category?: PluginCategory | 'all';
  query?: string;
  onlyCompatible?: boolean;
}

/** Validates that a remote registry or plugin bundle URL uses HTTPS (or localhost HTTP for local dev). */
export function isAllowedRemoteUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') {
      return true;
    }
    if (parsed.protocol === 'http:') {
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    }
    return false;
  } catch {
    return false;
  }
}

/** Resolves a plugin's `entry` path relative to its registry JSON URL and enforces safe HTTP(S) schemes. */
export function resolveRegistryEntryUrl(entry: string, registryUrl: string): string | null {
  try {
    const resolved = new URL(entry, registryUrl).href;
    return isAllowedRemoteUrl(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Parses and validates an untrusted JSON plugin registry document.
 * Every remote registry plugin MUST declare both a safe `entry` URL and a valid 64-hex `sha256` digest.
 */
export function parseRegistryDocument(raw: unknown, registryUrl: string): ParsedRegistryResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Registry payload must be a JSON object'] };
  }

  const input = raw as Partial<PluginRegistryDocument>;
  const errors: string[] = [];

  if (input.schemaVersion !== 1) {
    errors.push(`Unsupported registry schemaVersion "${String(input.schemaVersion)}" (expected 1)`);
  }
  if (typeof input.name !== 'string' || !input.name.trim()) {
    errors.push('Registry name must be a non-empty string');
  }
  if (!Array.isArray(input.plugins)) {
    errors.push('Registry plugins field must be an array');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const validPlugins: PluginManifest[] = [];
  const seenIds = new Set<string>();

  for (const rawPlugin of input.plugins as unknown[]) {
    const check = validatePluginManifest(rawPlugin);
    if (!check.valid || !check.manifest) {
      errors.push(`Skipped invalid plugin entry: ${check.errors.join(', ')}`);
      continue;
    }
    const manifest = check.manifest;
    if (!manifest.entry) {
      errors.push(`Plugin "${manifest.id}" is missing required "entry" URL`);
      continue;
    }
    if (!manifest.sha256) {
      errors.push(`Plugin "${manifest.id}" is missing required "sha256" integrity digest`);
      continue;
    }
    if (!resolveRegistryEntryUrl(manifest.entry, registryUrl)) {
      errors.push(`Plugin "${manifest.id}" has disallowed entry URL "${manifest.entry}"`);
      continue;
    }
    if (seenIds.has(manifest.id)) {
      errors.push(`Duplicate plugin id "${manifest.id}" in registry`);
      continue;
    }
    seenIds.add(manifest.id);
    validPlugins.push(manifest);
  }

  return {
    valid: true,
    errors,
    registry: {
      schemaVersion: 1,
      name: (input.name as string).trim(),
      ...(typeof input.updatedAt === 'string' ? { updatedAt: input.updatedAt } : {}),
      plugins: validPlugins,
    },
  };
}

/** Filters store catalog items by category, search query, and compatibility. */
export function filterStoreCatalog(items: readonly StoreCatalogItem[], filter: StoreCatalogFilter = {}): StoreCatalogItem[] {
  const query = filter.query?.trim().toLowerCase() ?? '';
  const category = filter.category ?? 'all';

  return items.filter(item => {
    if (category !== 'all' && item.manifest.category !== category) {
      return false;
    }
    if (filter.onlyCompatible && !item.compatible) {
      return false;
    }
    if (!query) {
      return true;
    }
    const haystack = [
      item.manifest.id,
      item.manifest.name,
      item.manifest.description,
      item.manifest.author ?? '',
      item.manifest.category,
      ...item.manifest.permissions,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

/** Formats plugin download weight cleanly for Store cards (e.g. `4.8 KB`, `1.2 MB`). */
export function formatByteSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
