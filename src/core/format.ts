import { SUPPORTED_AUDIO_EXTENSIONS, SUPPORTED_PLAYLIST_EXTENSIONS } from './constants';

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/** Formats seconds into MM:SS or H:MM:SS; optionally displays negative remaining time like Winamp. */
export function formatTime(seconds: number | undefined, showRemaining = false, duration?: number): string {
  if (showRemaining && typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    const remaining = Math.max(0, duration - (Number.isFinite(seconds ?? 0) ? (seconds ?? 0) : 0));
    return `-${formatPositiveTime(remaining)}`;
  }
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }
  return formatPositiveTime(seconds);
}

function formatPositiveTime(totalSeconds: number): string {
  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/** Sums known track durations for the playlist footer. */
export function formatTotalDuration(durations: ReadonlyArray<number | undefined>): string {
  let total = 0;
  let knownCount = 0;
  for (const duration of durations) {
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      total += duration;
      knownCount += 1;
    }
  }
  if (knownCount === 0) {
    return '00:00';
  }
  return formatPositiveTime(total);
}

/** Formats an equalizer gain value in dB (e.g. "+4.5 dB", "0.0 dB", "-6.0 dB"). */
export function formatDb(gain: number): string {
  const safe = Number.isFinite(gain) ? gain : 0;
  const rounded = Math.round(safe * 10) / 10;
  const prefix = rounded > 0 ? '+' : '';
  return `${prefix}${rounded.toFixed(1)} dB`;
}

/** Formats stereo balance (-1..+1) for tooltips and ARIA labels. */
export function formatBalance(balance: number): string {
  const safe = clamp(balance, -1, 1);
  const percent = Math.round(Math.abs(safe) * 100);
  if (percent < 2) {
    return 'Center';
  }
  return safe < 0 ? `L ${percent}%` : `R ${percent}%`;
}

/** Extracts lowercase extension without the leading dot from a filename, path, or URL. */
export function getFileExtension(nameOrPath: string): string {
  const withoutQuery = nameOrPath.split(/[?#]/)[0] ?? '';
  const base = withoutQuery.split(/[/\\]/).pop() ?? '';
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === base.length - 1) {
    return '';
  }
  return base.slice(dotIndex + 1).toLowerCase();
}

export function isAudioFilename(nameOrPath: string): boolean {
  const ext = getFileExtension(nameOrPath);
  return SUPPORTED_AUDIO_EXTENSIONS.includes(ext);
}

export function isPlaylistFilename(nameOrPath: string): boolean {
  const ext = getFileExtension(nameOrPath);
  return SUPPORTED_PLAYLIST_EXTENSIONS.includes(ext);
}
