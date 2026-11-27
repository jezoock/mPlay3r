import { PluginIntegrityError, verifySha256 } from './integrity';
import { PluginValidationError } from './types';
import type { PluginManifest } from './types';
import { validatePluginManifest } from './validation';

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_LFH_SIG = 0x04034b50;

export interface ExtractedLocalPluginArchive {
  manifest: PluginManifest;
  entrySource: Uint8Array;
}

async function inflateRawBytes(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Deflate decompression is not supported in this runtime; use an uncompressed .zip or .js plugin.');
  }
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const copy = new Uint8Array(new ArrayBuffer(compressed.byteLength));
  copy.set(compressed);
  await writer.write(copy);
  await writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Zero-dependency minimal ZIP extractor supporting Stored (0) and Deflate (8) entries.
 * Reads the Central Directory safely without relying on third-party archive libraries.
 */
export async function extractZipEntries(buffer: ArrayBuffer | Uint8Array): Promise<Map<string, Uint8Array>> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < 22) {
    throw new Error('Invalid ZIP archive: file too small.');
  }

  // Locate End of Central Directory (EOCD) signature within the last 64 KB.
  const minOffset = Math.max(0, bytes.byteLength - 65557);
  let eocdOffset = -1;
  for (let pos = bytes.byteLength - 22; pos >= minOffset; pos -= 1) {
    if (view.getUint32(pos, true) === ZIP_EOCD_SIG) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP archive: End of Central Directory record not found.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder('utf-8');
  const files = new Map<string, Uint8Array>();

  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== ZIP_CD_SIG) {
      throw new Error('Invalid ZIP archive: corrupted Central Directory entry.');
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const rawName = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    const normalizedName = rawName.replace(/^(\.\/)+/, '').replace(/\\/g, '/');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (normalizedName.endsWith('/') || normalizedName.includes('..')) {
      continue;
    }

    if (localHeaderOffset + 30 > bytes.byteLength || view.getUint32(localHeaderOffset, true) !== ZIP_LFH_SIG) {
      throw new Error(`Invalid ZIP archive: corrupted local header for "${normalizedName}".`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) {
      throw new Error(`Invalid ZIP archive: entry "${normalizedName}" exceeds file bounds.`);
    }

    const slice = bytes.subarray(dataStart, dataEnd);
    if (method === 0) {
      files.set(normalizedName, new Uint8Array(slice));
    } else if (method === 8) {
      files.set(normalizedName, await inflateRawBytes(slice));
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for "${normalizedName}".`);
    }
  }

  return files;
}

/**
 * Extracts and validates a local `.zip` plugin package containing `manifest.json` and its entry ESM bundle.
 * If `manifest.json` specifies a `sha256` digest, verifies the entry bytes before returning.
 */
export async function parseLocalPluginZip(buffer: ArrayBuffer | Uint8Array): Promise<ExtractedLocalPluginArchive> {
  const entries = await extractZipEntries(buffer);
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) {
    throw new PluginValidationError(['ZIP archive is missing root "manifest.json"']);
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder('utf-8').decode(manifestBytes));
  } catch {
    throw new PluginValidationError(['ZIP "manifest.json" contains invalid JSON']);
  }

  const check = validatePluginManifest(rawManifest);
  if (!check.valid || !check.manifest) {
    throw new PluginValidationError(check.errors);
  }
  const manifest = check.manifest;
  const entryPath = (manifest.entry || 'index.js').replace(/^(\.\/)+/, '');
  const entrySource = entries.get(entryPath);
  if (!entrySource) {
    throw new PluginValidationError([`ZIP archive is missing declared entry file "${entryPath}"`]);
  }

  if (manifest.sha256) {
    const integrity = await verifySha256(entrySource, manifest.sha256);
    if (!integrity.ok) {
      throw new PluginIntegrityError(manifest.id, integrity.expected, integrity.actual);
    }
  }

  return { manifest, entrySource };
}
