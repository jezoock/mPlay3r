import { getFileExtension } from './format';

export interface LocalTrackMetadata {
  title: string;
  artist?: string;
  album?: string;
  format?: string;
}

/**
 * Parses clean artist/title/format metadata purely from a filename or URL path (100% offline, no scraping).
 * Examples:
 *   "01 - Daft Punk - Aerodynamic.flac" -> { artist: "Daft Punk", title: "Aerodynamic", format: "FLAC" }
 *   "04.boards_of_canada_-_roygbiv.mp3" -> { artist: "boards of canada", title: "roygbiv", format: "MP3" }
 */
export function parseFilenameMetadata(nameOrUrl: string): LocalTrackMetadata {
  const withoutQuery = nameOrUrl.split(/[?#]/)[0] ?? nameOrUrl;
  let base = withoutQuery.split(/[/\\]/).pop() ?? nameOrUrl;
  try {
    base = decodeURIComponent(base);
  } catch {
    // Keep original string if URI decoding fails.
  }

  const ext = getFileExtension(base);
  const format = ext ? ext.toUpperCase() : undefined;
  let stem = ext ? base.slice(0, -(ext.length + 1)) : base;

  // Replace underscores with spaces when the name relies on underscores as word separators.
  if (!stem.includes(' ') && stem.includes('_')) {
    stem = stem.replace(/_/g, ' ');
  }

  // Strip common leading track numbers: "01 - ", "01. ", "01.", "[01] ", "01 " (only when followed by text).
  stem = stem
    .replace(/^\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3})(?:\s*[.-]\s*|\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stem) {
    return { title: base || 'Untitled Track', format };
  }

  const separatorMatch = stem.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (separatorMatch) {
    const artist = separatorMatch[1].trim();
    const title = separatorMatch[2].trim();
    if (artist && title) {
      return { artist, title, format };
    }
  }

  return { title: stem, format };
}

/**
 * Lightweight, zero-dependency local ID3v2.3 / ID3v2.4 & ID3v1 tag reader (TIT2, TPE1, TALB).
 * Operates strictly on local binary bytes already loaded from a user-selected file (no network/scraping).
 */
export function parseId3TagsFromBuffer(buffer: ArrayBuffer): Partial<LocalTrackMetadata> {
  const bytes = new Uint8Array(buffer);
  const v2 = parseId3v2(bytes);
  if (v2.title || v2.artist || v2.album) {
    return v2;
  }
  return parseId3v1(bytes);
}

function parseId3v2(bytes: Uint8Array): Partial<LocalTrackMetadata> {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return {};
  }

  const versionMajor = bytes[3];
  if (versionMajor !== 3 && versionMajor !== 4) {
    return {};
  }

  const flags = bytes[5];
  const tagSize = readSyncSafeInt(bytes, 6);
  const limit = Math.min(bytes.length, 10 + tagSize);
  let offset = 10;

  // Skip optional extended header if flag bit 6 is set.
  if ((flags & 0x40) !== 0 && offset + 4 <= limit) {
    const extSize = versionMajor === 4 ? readSyncSafeInt(bytes, offset) : readUint32BE(bytes, offset);
    offset += versionMajor === 4 ? extSize : 4 + extSize;
  }

  const result: Partial<LocalTrackMetadata> = {};

  while (offset + 10 <= limit) {
    if (bytes[offset] === 0) {
      break; // Padding reached.
    }

    const frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) {
      break;
    }

    const frameSize = versionMajor === 4 ? readSyncSafeInt(bytes, offset + 4) : readUint32BE(bytes, offset + 4);
    offset += 10;

    if (frameSize <= 0 || offset + frameSize > limit) {
      break;
    }

    if (frameId === 'TIT2' || frameId === 'TPE1' || frameId === 'TALB') {
      const decoded = decodeId3TextFrame(bytes.subarray(offset, offset + frameSize));
      if (decoded) {
        if (frameId === 'TIT2') result.title = decoded;
        else if (frameId === 'TPE1') result.artist = decoded;
        else if (frameId === 'TALB') result.album = decoded;
      }
    }

    offset += frameSize;
    if (result.title && result.artist && result.album) {
      break;
    }
  }

  return result;
}

function parseId3v1(bytes: Uint8Array): Partial<LocalTrackMetadata> {
  if (bytes.length < 128) {
    return {};
  }
  const start = bytes.length - 128;
  if (bytes[start] !== 0x54 || bytes[start + 1] !== 0x41 || bytes[start + 2] !== 0x47) {
    return {};
  }
  const readLatin1 = (from: number, len: number) => {
    const raw = decodeLatin1(bytes.subarray(start + from, start + from + len));
    const nul = raw.indexOf('\u0000');
    return (nul >= 0 ? raw.slice(0, nul) : raw).trim();
  };

  const title = readLatin1(3, 30);
  const artist = readLatin1(33, 30);
  const album = readLatin1(63, 30);
  return {
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
  };
}

function readSyncSafeInt(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function decodeId3TextFrame(frameData: Uint8Array): string {
  if (frameData.length < 2) {
    return '';
  }
  const encoding = frameData[0];
  const payload = frameData.subarray(1);
  let text = '';

  try {
    if (encoding === 0) {
      text = decodeLatin1(payload);
    } else if (encoding === 1) {
      const isBE = payload.length >= 2 && payload[0] === 0xfe && payload[1] === 0xff;
      const isLE = payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xfe;
      const sliced = isBE || isLE ? payload.subarray(2) : payload;
      text = new TextDecoder(isBE ? 'utf-16be' : 'utf-16le').decode(sliced);
    } else if (encoding === 2) {
      text = new TextDecoder('utf-16be').decode(payload);
    } else if (encoding === 3) {
      text = new TextDecoder('utf-8').decode(payload);
    }
  } catch {
    text = decodeLatin1(payload);
  }

  return text.split('\u0000').join('').trim();
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

/** Extracts local metadata from a browser File (filename + optional local ID3 header slice). */
export async function extractLocalFileMetadata(file: File): Promise<LocalTrackMetadata> {
  const fromName = parseFilenameMetadata(file.name);
  if (getFileExtension(file.name) !== 'mp3' || typeof file.slice !== 'function') {
    return fromName;
  }

  try {
    const headerSlice = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
    const tags = parseId3TagsFromBuffer(headerSlice);
    return {
      title: tags.title || fromName.title,
      artist: tags.artist || fromName.artist,
      album: tags.album,
      format: fromName.format,
    };
  } catch {
    return fromName;
  }
}
