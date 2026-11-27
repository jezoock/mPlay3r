const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function toUint8Array(data: Uint8Array | ArrayBuffer | string): Uint8Array<ArrayBuffer> {
  if (typeof data === 'string') {
    const encoded = new TextEncoder().encode(data);
    const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
    copy.set(encoded);
    return copy;
  }
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
    copy.set(data);
    return copy;
  }
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
  copy.set(new Uint8Array(data));
  return copy;
}

/** Computes a lowercase hexadecimal SHA-256 digest using standard Web Crypto (works in Browsers, Tauri & Node 22). */
export async function sha256Hex(data: Uint8Array | ArrayBuffer | string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new Error('Web Crypto SubtleCrypto API is unavailable for SHA-256 verification.');
  }
  const bytes = toUint8Array(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export interface IntegrityCheckResult {
  ok: boolean;
  actual: string;
  expected: string;
}

/** Constant-time string comparison for fixed-length hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Verifies binary or text payload bytes against an expected 64-char hex SHA-256 digest. */
export async function verifySha256(
  data: Uint8Array | ArrayBuffer | string,
  expectedHex: string,
): Promise<IntegrityCheckResult> {
  const expected = expectedHex.trim().toLowerCase();
  if (!SHA256_HEX_RE.test(expected)) {
    return { ok: false, actual: '', expected };
  }
  const actual = await sha256Hex(data);
  return {
    ok: timingSafeEqualHex(actual, expected),
    actual,
    expected,
  };
}

export class PluginIntegrityError extends Error {
  readonly pluginId: string;
  readonly expected: string;
  readonly actual: string;

  constructor(pluginId: string, expected: string, actual: string) {
    super(`SHA-256 integrity mismatch for plugin "${pluginId}": expected ${expected}, got ${actual || 'invalid digest'}.`);
    this.name = 'PluginIntegrityError';
    this.pluginId = pluginId;
    this.expected = expected;
    this.actual = actual;
  }
}
