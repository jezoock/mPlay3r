import { getFileExtension, isAudioFilename, isPlaylistFilename } from './format';
import { parseFilenameMetadata } from './metadata';
import type { Track, TrackInput } from './types';

export interface ResolveTracksResult {
  tracks: TrackInput[];
  error?: 'invalid-json' | 'fetch-failed';
}

/**
 * Parses M3U / M3U8 playlists (classic Winamp format with optional #EXTINF duration & title).
 */
export function parseM3u(content: string, baseUrl?: string): TrackInput[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const tracks: TrackInput[] = [];
  let pendingMeta: { duration?: number; title?: string; artist?: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      pendingMeta = parseExtInf(line.slice('#EXTINF:'.length));
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    const src = resolveTrackSource(line, baseUrl);
    const fallback = parseFilenameMetadata(line);
    tracks.push({
      src,
      title: pendingMeta?.title || fallback.title,
      artist: pendingMeta?.artist || fallback.artist,
      duration: pendingMeta?.duration,
      format: fallback.format,
      filePath: isNativeFilePath(line) ? line : undefined,
    });
    pendingMeta = null;
  }

  return tracks;
}

function parseExtInf(rest: string): { duration?: number; title?: string; artist?: string } {
  const commaIndex = rest.indexOf(',');
  const durationPart = commaIndex >= 0 ? rest.slice(0, commaIndex).trim() : rest.trim();
  const displayPart = commaIndex >= 0 ? rest.slice(commaIndex + 1).trim() : '';

  const parsedDuration = Number(durationPart.split(/\s+/)[0]);
  const duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : undefined;

  if (!displayPart) {
    return { duration };
  }

  const splitMatch = displayPart.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (splitMatch) {
    return {
      duration,
      artist: splitMatch[1].trim(),
      title: splitMatch[2].trim(),
    };
  }

  return { duration, title: displayPart };
}

/**
 * Parses Winamp/SHOUTcast PLS playlists (`[playlist]`, `File1=...`, `Title1=...`, `Length1=...`).
 */
export function parsePls(content: string, baseUrl?: string): TrackInput[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const entries = new Map<number, { file?: string; title?: string; length?: number }>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) {
      continue;
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    const match = key.match(/^(File|Title|Length)(\d+)$/i);
    if (!match) {
      continue;
    }
    const field = match[1].toLowerCase();
    const num = Number(match[2]);
    const entry = entries.get(num) ?? {};

    if (field === 'file') {
      entry.file = value;
    } else if (field === 'title') {
      entry.title = value;
    } else if (field === 'length') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        entry.length = parsed;
      }
    }
    entries.set(num, entry);
  }

  return Array.from(entries.entries())
    .sort(([a], [b]) => a - b)
    .filter(([, entry]) => Boolean(entry.file))
    .map(([, entry]) => {
      const file = entry.file as string;
      const fallback = parseFilenameMetadata(file);
      let title = entry.title || fallback.title;
      let artist = fallback.artist;
      if (entry.title) {
        const splitMatch = entry.title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        if (splitMatch) {
          artist = splitMatch[1].trim();
          title = splitMatch[2].trim();
        }
      }
      return {
        src: resolveTrackSource(file, baseUrl),
        title,
        artist,
        duration: entry.length,
        format: fallback.format,
        filePath: isNativeFilePath(file) ? file : undefined,
      };
    });
}

/** Auto-detects M3U/M3U8 vs PLS format and parses tracks. */
export function parsePlaylistContent(content: string, filename = '', baseUrl?: string): TrackInput[] {
  const ext = getFileExtension(filename);
  if (ext === 'pls' || /^\s*\[playlist\]/im.test(content)) {
    return parsePls(content, baseUrl);
  }
  return parseM3u(content, baseUrl);
}

/**
 * Resolves the `<mplay3r-app tracks="...">` prop: accepts a TrackInput array,
 * a JSON array string, a URL to an M3U/M3U8/PLS playlist, or a direct audio file URL.
 */
export async function resolveTracksInput(
  input: TrackInput[] | string,
  fetcher: typeof fetch = fetch,
): Promise<ResolveTracksResult> {
  if (Array.isArray(input)) {
    return {
      tracks: input.filter(item => Boolean(item && typeof item.src === 'string' && item.src.trim())),
    };
  }

  if (typeof input !== 'string') {
    return { tracks: [] };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { tracks: [] };
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        return { tracks: [], error: 'invalid-json' };
      }
      return {
        tracks: parsed.filter(
          (item): item is TrackInput =>
            Boolean(item && typeof item === 'object' && typeof (item as TrackInput).src === 'string' && (item as TrackInput).src.trim()),
        ),
      };
    } catch {
      return { tracks: [], error: 'invalid-json' };
    }
  }

  if (isPlaylistFilename(trimmed)) {
    try {
      const response = await fetcher(trimmed);
      if (!response.ok) {
        return { tracks: [], error: 'fetch-failed' };
      }
      const text = await response.text();
      return {
        tracks: parsePlaylistContent(text, trimmed, response.url || trimmed),
      };
    } catch {
      return { tracks: [], error: 'fetch-failed' };
    }
  }

  if (isAudioFilename(trimmed)) {
    return { tracks: [{ src: trimmed }] };
  }

  return { tracks: [] };
}

/** Serializes tracks into an extended M3U8 playlist string. */
export function serializeM3u(tracks: readonly Track[]): string {
  const lines = ['#EXTM3U'];
  for (const track of tracks) {
    const secs = typeof track.duration === 'number' && Number.isFinite(track.duration) ? Math.round(track.duration) : -1;
    const label = track.artist ? `${track.artist} - ${track.title}` : track.title;
    lines.push(`#EXTINF:${secs},${label}`);
    lines.push(track.filePath || track.src);
  }
  return `${lines.join('\n')}\n`;
}

function isNativeFilePath(entry: string): boolean {
  return entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry) || entry.startsWith('\\\\');
}

function resolveTrackSource(entry: string, baseUrl?: string): string {
  if (/^(https?|blob|data|file|mplay3r):/i.test(entry) || isNativeFilePath(entry) || !baseUrl) {
    return entry;
  }
  try {
    return new URL(entry, baseUrl).href;
  } catch {
    return entry;
  }
}
