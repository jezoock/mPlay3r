import type { PluginHost } from './host';
import { PluginIntegrityError, verifySha256 } from './integrity';
import { parseLocalPluginZip } from './local-archive';
import {
  DEFAULT_PLUGIN_REGISTRY_URL,
  isAllowedRemoteUrl,
  parseRegistryDocument,
  resolveRegistryEntryUrl,
} from './registry';
import type { StoreCatalogItem } from './registry';
import { createDefaultPluginStorage } from './storage';
import type { PluginStorageBackend } from './storage';
import { PluginValidationError } from './types';
import type { InstalledPluginRecord, MPlay3rPlugin, PluginManifest } from './types';
import { compareSemver, isCoreVersionCompatible, validatePluginManifest } from './validation';

const STORE_REGISTRIES_KEY = 'store.registries';

export type PluginModuleLoader = (sourceBytes: Uint8Array, manifestHint?: PluginManifest) => Promise<MPlay3rPlugin>;

export interface PluginStoreOptions {
  coreVersion: string;
  initialRegistries?: string[];
  storageBackend?: PluginStorageBackend;
  fetcher?: typeof fetch;
  moduleLoader?: PluginModuleLoader;
}

export interface CatalogRefreshResult {
  items: StoreCatalogItem[];
  errors: Array<{ url: string; message: string }>;
}

/** Extracts an `MPlay3rPlugin` instance from a dynamically imported ES module namespace. */
function unwrapPluginModule(mod: Record<string, unknown>): MPlay3rPlugin {
  const candidate = (mod.default ?? mod.plugin ?? mod) as Partial<MPlay3rPlugin> | undefined;
  if (!candidate || typeof candidate.activate !== 'function' || !candidate.manifest) {
    throw new PluginValidationError(['Plugin module must export a default or named `plugin` object with `manifest` and `activate(ctx)`.']);
  }
  return candidate as MPlay3rPlugin;
}

/** Default browser ESM loader using an ephemeral Blob URL (revoked immediately after import). */
async function defaultBlobModuleLoader(sourceBytes: Uint8Array): Promise<MPlay3rPlugin> {
  const copy = new Uint8Array(new ArrayBuffer(sourceBytes.byteLength));
  copy.set(sourceBytes);
  const blob = new Blob([copy], { type: 'text/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const mod = (await import(url)) as Record<string, unknown>;
    return unwrapPluginModule(mod);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Integrated Phase 2 Plugin Store client.
 *
 * Connects to the official `jezoock/mPlay3r-addons` JSON registry and any user-added third-party
 * registries, enforces semver `minCoreVersion` compatibility, verifies cryptographic SHA-256
 * digests BEFORE loading any code, and supports local `.zip` / `.js` plugin imports.
 */
export class PluginStore {
  private readonly coreVersion: string;
  private readonly storageBackend: PluginStorageBackend;
  private readonly fetcher: typeof fetch;
  private readonly moduleLoader: PluginModuleLoader;
  private registryUrls: string[];
  private registriesLoaded = false;
  private cachedEntries: Array<{ manifest: PluginManifest; registryUrl: string; registryName: string; resolvedEntryUrl: string }> = [];

  constructor(options: PluginStoreOptions) {
    this.coreVersion = options.coreVersion;
    this.storageBackend = options.storageBackend ?? createDefaultPluginStorage();
    const customFetcher = options.fetcher;
    this.fetcher = (input, init) =>
      customFetcher && customFetcher !== globalThis.fetch ? customFetcher(input, init) : globalThis.fetch(input, init);
    this.moduleLoader = options.moduleLoader ?? defaultBlobModuleLoader;
    this.registryUrls =
      options.initialRegistries && options.initialRegistries.length > 0
        ? Array.from(new Set(options.initialRegistries.filter(isAllowedRemoteUrl)))
        : [DEFAULT_PLUGIN_REGISTRY_URL];
  }

  async getRegistryUrls(): Promise<string[]> {
    await this.ensureRegistriesLoaded();
    return [...this.registryUrls];
  }

  async addRegistryUrl(rawUrl: string): Promise<string[]> {
    await this.ensureRegistriesLoaded();
    const trimmed = rawUrl.trim();
    if (!isAllowedRemoteUrl(trimmed)) {
      throw new Error('Registry URL must use https:// (or http://localhost for local development).');
    }
    if (!this.registryUrls.includes(trimmed)) {
      this.registryUrls = [...this.registryUrls, trimmed];
      await this.persistRegistryUrls();
    }
    return [...this.registryUrls];
  }

  async removeRegistryUrl(rawUrl: string): Promise<string[]> {
    await this.ensureRegistriesLoaded();
    this.registryUrls = this.registryUrls.filter(url => url !== rawUrl);
    await this.persistRegistryUrls();
    return [...this.registryUrls];
  }

  /** Fetches and validates all configured JSON registries, deduplicating by plugin id (first registry wins). */
  async refreshCatalog(installedPlugins: readonly InstalledPluginRecord[] = []): Promise<CatalogRefreshResult> {
    await this.ensureRegistriesLoaded();
    const errors: Array<{ url: string; message: string }> = [];
    const merged: typeof this.cachedEntries = [];
    const seen = new Set<string>();

    for (const url of this.registryUrls) {
      try {
        const response = await this.fetcher(url);
        if (!response.ok) {
          errors.push({ url, message: `HTTP ${response.status}` });
          continue;
        }
        const json = (await response.json()) as unknown;
        const parsed = parseRegistryDocument(json, url);
        if (!parsed.valid || !parsed.registry) {
          errors.push({ url, message: parsed.errors.join('; ') });
          continue;
        }
        for (const warning of parsed.errors) {
          errors.push({ url, message: warning });
        }
        for (const manifest of parsed.registry.plugins) {
          if (seen.has(manifest.id)) {
            continue;
          }
          const resolvedEntryUrl = resolveRegistryEntryUrl(manifest.entry || '', url);
          if (!resolvedEntryUrl) {
            continue;
          }
          seen.add(manifest.id);
          merged.push({
            manifest,
            registryUrl: url,
            registryName: parsed.registry.name,
            resolvedEntryUrl,
          });
        }
      } catch (error) {
        errors.push({ url, message: error instanceof Error ? error.message : String(error) });
      }
    }

    this.cachedEntries = merged;
    return {
      items: this.buildCatalogItems(installedPlugins),
      errors,
    };
  }

  /** Returns the current catalog enriched with install / active / update status from `PluginHost`. */
  buildCatalogItems(installedPlugins: readonly InstalledPluginRecord[] = []): StoreCatalogItem[] {
    const installedById = new Map(installedPlugins.map(rec => [rec.manifest.id, rec]));

    return this.cachedEntries.map(entry => {
      const installed = installedById.get(entry.manifest.id);
      const compatible = isCoreVersionCompatible(entry.manifest.minCoreVersion, this.coreVersion);
      const updateAvailable = Boolean(installed && compareSemver(entry.manifest.version, installed.manifest.version) > 0);
      const status: StoreCatalogItem['status'] = installed
        ? installed.status === 'active'
          ? 'active'
          : installed.status === 'error'
            ? 'error'
            : 'disabled'
        : 'available';

      return {
        manifest: entry.manifest,
        registryUrl: entry.registryUrl,
        registryName: entry.registryName,
        resolvedEntryUrl: entry.resolvedEntryUrl,
        compatible,
        installedVersion: installed?.manifest.version,
        updateAvailable,
        status,
      };
    });
  }

  /**
   * Downloads, SHA-256 verifies, loads, and installs (or updates) a plugin from a catalog entry.
   * Refuses execution if `minCoreVersion` is incompatible, `sha256` fails, or the loaded module
   * tries to substitute a different plugin id or version.
   */
  async installFromCatalog(item: StoreCatalogItem, host: PluginHost): Promise<InstalledPluginRecord> {
    const manifest = item.manifest;
    if (!isCoreVersionCompatible(manifest.minCoreVersion, this.coreVersion)) {
      throw new PluginValidationError([
        `Plugin "${manifest.id}" requires mPlay3r >= ${manifest.minCoreVersion} (current: ${this.coreVersion}).`,
      ]);
    }
    if (!manifest.sha256) {
      throw new PluginIntegrityError(manifest.id, '64-hex sha256 digest', 'missing');
    }
    if (!isAllowedRemoteUrl(item.resolvedEntryUrl)) {
      throw new PluginValidationError([`Disallowed plugin bundle URL "${item.resolvedEntryUrl}"`]);
    }

    const response = await this.fetcher(item.resolvedEntryUrl);
    if (!response.ok) {
      throw new Error(`Failed to download plugin "${manifest.id}" (HTTP ${response.status}).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());

    // Cryptographic SHA-256 verification BEFORE any module evaluation or import.
    const check = await verifySha256(bytes, manifest.sha256);
    if (!check.ok) {
      throw new PluginIntegrityError(manifest.id, check.expected, check.actual);
    }

    const loaded = await this.moduleLoader(bytes, manifest);
    const loadedCheck = validatePluginManifest(loaded.manifest);
    if (!loadedCheck.valid || !loadedCheck.manifest) {
      throw new PluginValidationError(loadedCheck.errors);
    }
    if (loadedCheck.manifest.id !== manifest.id || loadedCheck.manifest.version !== manifest.version) {
      throw new PluginValidationError([
        `Loaded plugin manifest (${loadedCheck.manifest.id}@${loadedCheck.manifest.version}) does not match signed registry entry (${manifest.id}@${manifest.version}).`,
      ]);
    }

    // Replace existing version cleanly on update.
    if (host.getPlugin(manifest.id)) {
      await host.uninstall(manifest.id);
    }
    return host.install(loaded, { enable: true });
  }

  /** Imports a local `.zip` package (`manifest.json` + bundle) or standalone `.js`/`.mjs` plugin file. */
  async installFromLocalFile(
    file: { name: string; arrayBuffer(): Promise<ArrayBuffer> },
    host: PluginHost,
  ): Promise<InstalledPluginRecord> {
    const rawBuffer = await file.arrayBuffer();
    const lowerName = file.name.toLowerCase();

    let sourceBytes: Uint8Array;
    let expectedManifest: PluginManifest | undefined;

    if (lowerName.endsWith('.zip')) {
      const extracted = await parseLocalPluginZip(rawBuffer);
      sourceBytes = extracted.entrySource;
      expectedManifest = extracted.manifest;
    } else if (lowerName.endsWith('.js') || lowerName.endsWith('.mjs')) {
      sourceBytes = new Uint8Array(rawBuffer);
    } else {
      throw new PluginValidationError(['Local import supports .zip archives or .js/.mjs ES module bundles.']);
    }

    const loaded = await this.moduleLoader(sourceBytes, expectedManifest);
    const check = validatePluginManifest(loaded.manifest);
    if (!check.valid || !check.manifest) {
      throw new PluginValidationError(check.errors);
    }
    if (expectedManifest && check.manifest.id !== expectedManifest.id) {
      throw new PluginValidationError([
        `ZIP entry module id "${check.manifest.id}" does not match manifest.json id "${expectedManifest.id}".`,
      ]);
    }

    if (host.getPlugin(check.manifest.id)) {
      await host.uninstall(check.manifest.id);
    }
    return host.install(loaded, { enable: true });
  }

  private async ensureRegistriesLoaded(): Promise<void> {
    if (this.registriesLoaded) {
      return;
    }
    this.registriesLoaded = true;
    try {
      const raw = await this.storageBackend.getItem(STORE_REGISTRIES_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((u): u is string => typeof u === 'string' && isAllowedRemoteUrl(u));
        if (valid.length > 0) {
          this.registryUrls = Array.from(new Set(valid));
        }
      }
    } catch {
      // Fall back to default registries on corrupted JSON.
    }
  }

  private async persistRegistryUrls(): Promise<void> {
    try {
      await this.storageBackend.setItem(STORE_REGISTRIES_KEY, JSON.stringify(this.registryUrls));
    } catch {
      // Ignore storage failures cleanly.
    }
  }
}
