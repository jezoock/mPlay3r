import type { PluginCategory, PluginManifest, PluginPermission, PluginRuntimeTarget } from './types';

export const PLUGIN_CATEGORIES: readonly PluginCategory[] = [
  'source',
  'broadcast',
  'visualizer',
  'scraper',
  'dsp',
  'theme',
];

export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'playback-control',
  'playlist-write',
  'track-metadata',
  'audio-analyser',
  'audio-context',
  'network',
  'local-server',
  'ui-slot',
  'theme',
  'storage',
];

export const PLUGIN_RUNTIMES: readonly PluginRuntimeTarget[] = ['all', 'desktop', 'web'];

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

export type ManifestValidationResult =
  | { valid: true; manifest: PluginManifest }
  | { valid: false; errors: string[] };

/** Parses a `major.minor.patch` semver string into numeric components, or `null` if invalid. */
export function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().match(SEMVER_RE);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compares two semver strings (`-1`, `0`, `1`). Invalid strings sort lower than valid ones. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** True when `coreVersion >= minCoreVersion` (or when `minCoreVersion` is omitted). */
export function isCoreVersionCompatible(minCoreVersion: string | undefined, coreVersion: string): boolean {
  if (!minCoreVersion) {
    return true;
  }
  if (!parseSemver(minCoreVersion) || !parseSemver(coreVersion)) {
    return false;
  }
  return compareSemver(coreVersion, minCoreVersion) >= 0;
}

/** Validates an untrusted plugin manifest object before installation or store display. */
export function validatePluginManifest(raw: unknown): ManifestValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  const input = raw as Partial<PluginManifest>;
  const errors: string[] = [];

  if (typeof input.id !== 'string' || !PLUGIN_ID_RE.test(input.id)) {
    errors.push('id must be 2-64 lowercase alphanumeric characters (., _, - allowed)');
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    errors.push('name must be a non-empty string');
  }
  if (typeof input.version !== 'string' || !parseSemver(input.version)) {
    errors.push('version must follow semver (e.g. 1.0.0)');
  }
  if (typeof input.description !== 'string' || input.description.trim().length === 0) {
    errors.push('description must be a non-empty string');
  }
  if (!PLUGIN_CATEGORIES.includes(input.category as PluginCategory)) {
    errors.push(`category must be one of: ${PLUGIN_CATEGORIES.join(', ')}`);
  }

  if (!Array.isArray(input.permissions)) {
    errors.push('permissions must be an array');
  } else {
    for (const perm of input.permissions) {
      if (!PLUGIN_PERMISSIONS.includes(perm as PluginPermission)) {
        errors.push(`unknown permission "${String(perm)}"`);
      }
    }
  }

  if (input.minCoreVersion !== undefined && (typeof input.minCoreVersion !== 'string' || !parseSemver(input.minCoreVersion))) {
    errors.push('minCoreVersion must follow semver when provided');
  }
  if (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || !SHA256_RE.test(input.sha256))) {
    errors.push('sha256 must be a 64-character hex digest when provided');
  }
  if (input.runtime !== undefined && !PLUGIN_RUNTIMES.includes(input.runtime)) {
    errors.push(`runtime must be one of: ${PLUGIN_RUNTIMES.join(', ')}`);
  }
  if (input.sizeBytes !== undefined && (typeof input.sizeBytes !== 'number' || !Number.isFinite(input.sizeBytes) || input.sizeBytes < 0)) {
    errors.push('sizeBytes must be a non-negative finite number when provided');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    manifest: {
      id: input.id as string,
      name: (input.name as string).trim(),
      version: (input.version as string).trim(),
      description: (input.description as string).trim(),
      category: input.category as PluginCategory,
      permissions: Array.from(new Set(input.permissions as PluginPermission[])),
      ...(input.minCoreVersion ? { minCoreVersion: input.minCoreVersion.trim() } : {}),
      ...(input.author ? { author: input.author } : {}),
      ...(input.homepage ? { homepage: input.homepage } : {}),
      ...(input.entry ? { entry: input.entry } : {}),
      ...(input.sha256 ? { sha256: input.sha256.toLowerCase() } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
    },
  };
}
